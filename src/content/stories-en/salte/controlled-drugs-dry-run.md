---
title: Flagging controlled drugs in bulk without writing anything first
summary: "To issue a controlled-drug prescription on the right paper, the catalog had to know which items are controlled, and flagging that in bulk carries regulatory weight. I cross-referenced the catalog with Anvisa's official list in a tool that shows every change before writing."
project: salte
order: 21
tags: [TypeScript, PostgreSQL, Dry run, Data migration, Regulatory]
---

A doctor builds a prescription on the platform, picks a controlled-use drug and clicks print. The paper that comes out has to be the right one: a controlled drug requires a specific prescription form, sometimes with a retained copy, and the pharmacy won't accept another. For the prescription to come out right, the system needs to know, item by item in the catalog, which drugs are controlled and under which list. That information didn't come ready-made.

## The problem

The platform issues prescriptions from a drug catalog. A controlled-drug prescription needs the right format: prescription notification, special-control prescription or prescription with a retained copy, depending on the list. The lists are defined by Portaria 344 from Anvisa (Brazil's health regulatory agency), the Brazilian regulation that lists the substances subject to special control and the type of prescription form each one requires.

The catalog didn't have that flag. The notion of "controlled" existed only as an isolated function inside one of the services, without being the single source for the prescription screens. I needed a reliable flag in the catalog itself and a single rule that every screen would query.

## Why it wasn't trivial

The catalog has many rows, with brand names, generic names and pharmaceutical forms written in different ways. The regulation lists substances, not products. And the same active ingredient can fall into different lists depending on the form: an oral version may be controlled and the topical one not. There are salts, synonyms and exceptions written in addenda, like the one that sends a substance from one list to another's prescription form.

Flagging wrong in bulk is expensive to undo. And the error isn't symmetric. A flag stricter than the law produces an extra piece of paper. A looser flag lets the prescription go out invalid.

## The solution

I split the work into two pieces: a pure matcher and a command-line tool that only runs as a dry run, meaning it computes everything and writes reports, without touching the database.

### The matcher

The matcher indexes the regulation's substances, with normalized names and synonyms (no accents, no parentheses, lowercase), by first token. For each catalog row, it looks for the longest matching span and consumes the tokens used, so a compound name doesn't match twice. It returns one of three verdicts:

- `MARKED`: controlled, with the list, the prescription form and the basis of the decision.
- `REVIEW`: the rule requires a person to look, because of unknown words or conflicting candidates.
- `NONE`: not controlled, including the exceptions provided in the regulation itself.

When the brand name and the generic point to different lists, the most restrictive one wins. A human review decision, stored in a versioned file with who reviewed it and when, takes priority over the matcher.

### The tool that refuses to run

Before looking at the catalog, the tool checks the source: the regulation, the annex version and the file hash. If it doesn't match the expected values, it stops. Then it reads the catalog and writes only reports: what would be flagged and a review queue grouped by generic, with the candidates and the unknown words. The apply SQL and the rollback SQL are generated from the same result, and the sample for spot-checking uses a fixed seed, so the report is reproducible.

### Fail closed

After the load, the prescription rule is a pure function. The prescription type comes from the prescription-form flag and only falls back to the list when there's no flag. A row still under review counts as controlled, by the most restrictive list, and the interface warns that the classification hasn't been confirmed. If the load wasn't even registered, the system doesn't assume everything is plain.

## An example

The table shows how the matcher handles typical rows. The products, substances and lists are fictional and only illustrate the matching rules, they don't classify any real drug:

| Catalog row (illustrative) | Verdict | Why |
| --- | --- | --- |
| "Product A 10 mg tablet (substance X)" | `MARKED`, list C1 | X is in list C1 |
| "Product B gel 0.05% (substance Y)" | `NONE` | the regulation excludes Y for topical use |
| "Product C capsule (substance Y)" | `MARKED`, list C2 | oral Y is in C2 |
| "Product D (substance Z hydrochloride)" | `MARKED`, list B1 | salt normalized to Z |
| "Product E compound (substance W + vitamin)" | `REVIEW` | unknown word next to a candidate |
| "Product F (brand name in C1, generic in C2)" | `MARKED`, list C1 | conflict resolved by the most restrictive |

And the prescription rule after the load, in a simplified version:

```ts
type Row = { prescriptionType?: PrescriptionType; list?: ControlList; status: "marked" | "review" | "none" };

function prescriptionFor(row: Row, loadRegistered: boolean): PrescriptionType {
  if (row.prescriptionType) return row.prescriptionType;
  // a row under review may still be controlled: err on the restrictive side
  if (row.status === "review") return MOST_RESTRICTIVE;
  if (row.list) return typeForList(row.list);
  // with no registered load, "no flag" doesn't mean "plain"
  if (!loadRegistered) return MOST_RESTRICTIVE;
  return "simple";
}
```

What helped me most was the review queue grouped by generic. Instead of reviewing hundreds of rows one by one, the person decides once per active ingredient, and the decision applies to all of its presentations.

## Result

The flagging became auditable. Before writing a single row, you can see what would change, why, and who approved each exception. The rollback SQL exists before the write. And the prescription type doesn't depend on each screen: they all query the same rule, which errs on the safe side when it isn't sure.

## What I take from it

For any bulk load with regulatory weight, deliver the report and the rollback SQL first, and only then the write. Make the tool check the source and refuse to run when it doesn't match. And when the error isn't symmetric, set the system's default on the side where being wrong costs less.
