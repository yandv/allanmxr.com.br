---
title: Why the AI model never writes a clinical number
summary: "In healthcare, a number the AI confidently makes up is the worst possible error. I took numbers out of the model's hands, and every value the professional reads comes from the cited source or a tested calculator."
project: salte
order: 17
tags: [LLM, TypeScript, Zod, Clinical calculators, AI safety]
---

A healthcare professional asks Salte's clinical evidence engine whether a drug needs adjusting for a patient with reduced kidney function. The engine answers in seconds, cites the drug label and writes a clearance value. The text is fluent, the citation exists, and the number looks right. The problem is that, in a system that lets the language model write digits freely, there's no way to know whether that number came from the source, from a calculation or from nowhere.

## The problem

In healthcare, a wrong number has real consequences: a dose, a risk score, a creatinine clearance. The symptom I wanted to eliminate was specific. The model writes "70 mL/min" with total confidence, and the value has no traceable origin. No later check can tell with certainty a copied number from an invented one, because they look the same.

## Why it wasn't trivial

Anyone's first idea is to write "don't make up numbers" in the prompt. The model obeys almost always. And the risk lives in the "almost".

Besides, a number in a clinical answer can have different origins, each with its own trust rule:

- the literal text of the cited source (a drug label, a protocol);
- the question itself ("72-year-old patient");
- the patient context the professional entered;
- a calculation made from that data.

The calculation also has to accept different units (kg or g, cm or m, mg/dL or µmol/L) without getting the conversion wrong. And it has to refuse an input the model "thought up" that isn't anywhere.

## The solution

I inverted the responsibility. The model never writes a digit. It writes a draft with named gaps, and the code fills each gap from a verifiable origin.

### Two kinds of gap

A citation gap asks for "the nth literal number in the cited passage". The code goes to the passage, extracts the token and puts it in the text. If the passage doesn't have that number, the gap doesn't resolve.

A calculation gap asks for "the result of the calculator the engine ran". The model doesn't do the math. It only indicates which execution it wants to show.

### Calculators as pure functions

Each calculator is a pure function, defined by a constructor that forces it to declare its version, bibliographic reference (DOI or PubMed), valid ranges, units and where each field may come from: the question, the patient context, a source passage or today's date. There are dozens of them, grouped by area, each with its own tests.

Before running, the executor checks each input against the evidence. A boolean field only counts if it comes with a literal quote from the question or the context. A quantity only counts if it's in the text. The unit is converted by the field's definition, not by the model. An input that doesn't check out counts as missing, and the reason goes into the answer's trace.

### A check that fails stray digits

After the draft, a pure function looks for any digit outside a gap. That includes subscripts, superscripts and numbers spelled out ("seventy"). It also fails a gap that points to a nonexistent citation and malformed markup. The final text only exists if that check passes.

### Dose calculation off by default

Dose calculators require a double release: the client has to be enabled and the request has to carry the matching permission. Without both, the calculator doesn't even appear in the catalog the model sees, and any gap that tries to use it fails.

## An example

An illustrative example, with made-up values. It shows the mechanism, not clinical guidance.

The model returns this draft:

```text
The estimated clearance is {{calc:run1}}, using the Cockcroft-Gault formula [[run1]].
The label indicates an adjustment when clearance falls below {{q:c2:1}} [[c2]].
```

The engine resolves the gaps like this:

```ts
type Evidence = { quote: string; value: number; unit: string };

function cockcroftGault(age: number, weightKg: number, creatinineMgDl: number, female: boolean) {
  const base = ((140 - age) * weightKg) / (72 * creatinineMgDl);
  return female ? base * 0.85 : base;
}

// an input only counts if the literal quote exists in the question or the context
function accept(field: Evidence, sourceText: string): number | null {
  return sourceText.includes(field.quote) ? field.value : null;
}

const question = 'Fictional man, 70 years old, 60 kg, creatinine 2.0 mg/dL.';
const age = accept({ quote: '70 years old', value: 70, unit: 'year' }, question);
const weight = accept({ quote: '60 kg', value: 60, unit: 'kg' }, question);
const creatinine = accept({ quote: '2.0 mg/dL', value: 2.0, unit: 'mg/dL' }, question);

const run1 = age && weight && creatinine
  ? cockcroftGault(age, weight, creatinine, false) // ≈ 29 mL/min
  : null; // missing evidence: the gap doesn't resolve and the answer becomes an abstention
```

The `{{q:c2:1}}` gap takes the first number from the cited passage of the label, for example "30 mL/min" in "reduce the dose if clearance is below 30 mL/min". The final text reads:

> The estimated clearance is 29 mL/min, using the Cockcroft-Gault formula. The label indicates an adjustment when clearance falls below 30 mL/min.

If the model had written "29" directly in the draft, the stray digit check would fail the whole answer. If the weight weren't in the question, the calculator wouldn't run, and the professional would receive an abstention explaining the missing data.

## Result

The number the professional reads has a verifiable origin: either it's a literal from a cited source, or it came out of a function with a bibliographic reference and tests. The model keeps writing the text, which is where it's good. But a wrong value became a case where the contract blocks the answer, not a case where the answer goes out.

The price is accepting that some answers become abstentions when a gap doesn't resolve. In healthcare, I consider that the right side to err on.

## What I take from it

When an error in a field is expensive, take the field away from the model. Ask for a skeleton with named gaps and fill them in code, recording the origin of each value. A prompt reduces how often the error happens. Architecture changes which kinds of error are possible.
