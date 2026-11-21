---
title: "A checks contract between the AI draft and the screen, with abstention as a valid answer"
summary: "A clinical answer could cite the right source and still say 25 mg where the protocol says 0.25 mg. I put automatic checks between the AI draft and the screen, and whatever doesn't pass becomes an abstention instead of a wrong answer."
project: salte
order: 18
tags: [LLM, Output validation, TypeScript, Abstention, Regression tests]
---

In one of the clinical engine's tests, the question is the dose of a drug in a specific scenario. The model generates a well-written answer, with a citation to a Ministry of Health protocol. The citation exists, the protocol exists, and the number in the answer also appears in the protocol. But there it sits inside "0.25 mg", and the answer says "25 mg". A naive text check would approve it. That was the case that made me write the contract.

## The problem

In a clinical evidence engine, an answer can be wrong in many ways besides the number. It can cite a source the text doesn't actually use. It can cite the wrong population, like a pediatric passage on a question about adults. It can use an expired version of the protocol. Or it can speak to the patient ("seek care") when the reader is a professional.

An answer with no backing is worse than no answer. I needed a barrier between the model's draft and the screen, and that barrier couldn't be another model.

## Why it wasn't trivial

Checking that "the text matches the source" isn't an `includes`. Portuguese uses a decimal comma and a thousands dot. There are compound units (`mg/kg/day`), dotted codes like ICD ones (the international classification of diseases), and legal act numbers in the `1.234/2024` format.

An `includes("25 mg")` finds `25 mg` inside `0,25 mg`. An `includes("10 mg")` finds `10 mg` inside `10 mg/kg`, which is a per-kilogram dose and means something else. Those are exactly the errors that matter in a dose answer.

## The solution

### Checks as pure functions

I wrote the contract as a fixed set of checks, each one a pure function that takes the draft and the corpus record and returns violations. No model in the path. Some rules:

- A citation the text doesn't use fails. A repeated citation id too, because the interface numbers the citations and the marker would be ambiguous.
- Version, publication date and status of the source are compared against the corpus record, never against what the citation declares about itself.
- A critical source past its review deadline doesn't go out.
- A sentence addressed to the patient fails.

### A quantity reader with a closed vocabulary

The most delicate part is reading numbers. I wrote a tokenizer that splits the text into quantity, code, out-of-vocabulary unit and malformed number. The unit vocabulary is closed. A dot is only decimal when the number doesn't match the thousands form: `2.500` is 2500, and `2.50` is 2.5. An unknown word right after a number becomes `unknown-unit` and fails, instead of letting the number through on its own.

### Token boundary on both ends

A source passage only supports a quantity in the answer if it appears there with a boundary on both ends: no digit, decimal comma or compound-unit slash stuck to the edge.

### Repair once, then abstain

When a check fails, the draft doesn't go to the screen. If all violations are about format or numbers, the engine tries a single repair: it hands the generator the draft and the contract's messages, and the result goes through all the checks again. If it fails again, the answer becomes an abstention with fixed, auditable text. The log keeps only the codes of the checks that failed, never the model's text.

## An example

The code below is a didactic version of the boundary check, with generic names:

```ts
const BEFORE = /[\d,.]$/;      // "0," before "25 mg" changes the number
const AFTER = /^(\/|[\d,.]\d)/; // "/kg" after "10 mg" changes the quantity

function supports(excerpt: string, quantity: string): boolean {
  let from = 0;
  while (true) {
    const at = excerpt.indexOf(quantity, from);
    if (at === -1) return false;
    const before = excerpt.slice(0, at);
    const after = excerpt.slice(at + quantity.length);
    if (!BEFORE.test(before) && !AFTER.test(after)) return true;
    from = at + 1;
  }
}
```

And the cases it has to get right. All passages and doses are fictional and only serve to show the text rule, they are not clinical guidance:

| Source passage (illustrative) | Quantity in the answer | Result |
| --- | --- | --- |
| "dose of 25 mg per day" | 25 mg | supports |
| "dose of 0,25 mg per day" | 25 mg | does not support |
| "10 mg/kg every 8 hours" | 10 mg | does not support |
| "up to 2.500 mg per day" | 2500 mg | supports, after normalizing the thousands |
| "10 mg/kg at the start, then 10 mg per day" | 10 mg | supports on the second occurrence |

The last case is the reason for the loop. The first occurrence of "10 mg" is stuck to "/kg", and the second isn't. Stopping at the first would give a false negative and an unnecessary abstention.

## Result

Every delivered answer went through the same checks, and every abstention carries a fixed code that the interface knows how to display. Abstention also came to cover other honest paths. If the generator hits the output token limit, the engine returns the abstention instead of an error. If the drug's label has no reviewed dosing section, the dose question abstains. If the question asks for a calculation and data is missing, the answer lists the missing fields, with units, with no free text from the model.

The checks have tests per rule, including pinned regression cases for formats that had broken heuristics before, like registration numbers and ICD codes. When someone touches the tokenizer, those cases say right away what changed.

## What I take from it

Treat "I don't know" as an expected state of the contract, with its own code and text, not as a failure. Validate a model's output with deterministic code whenever the rule can be written. And be suspicious of any text check that doesn't have a test for the token boundary.
