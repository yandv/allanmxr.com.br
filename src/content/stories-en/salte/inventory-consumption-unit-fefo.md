---
title: "Clinic inventory: vials when buying, milliliters when applying and the lot that expires first"
summary: "A clinic buys medication by the vial and applies it in milliliters or milligrams, and needs to use the lot that expires first. I designed inventory with two units on a single integer, stock deduction by expiry when the session is finalized and a deduction suggestion taken from the consultation's prescription."
project: salte
order: 6
tags: [Inventory, FEFO, PostgreSQL, ERP, TypeScript]
---

A nurse applies 0.5 mL of a drug the clinic buys in 2.4 mL vials. At the end of the appointment, inventory has to say how much is left: not "one vial fewer", but "one open vial with 1.9 mL". On the shelf there are two lots of the same drug, one expiring in three weeks and another in six months. The one that expires first has to go out first, and what's set aside for another patient's session can't be touched.

## The problem

Clinic inventory isn't retail inventory. The purchase unit (box, vial, ampoule) differs from the consumption unit (mL, mg, tablet), and an application almost never uses a whole purchase unit. Drugs have lots and expiry dates, and wasting stock to expiry is expensive. And the deduction has to happen at the point where consumption is recorded clinically, when the appointment is finalized, without relying on someone remembering to log it later.

## Why it wasn't trivial

Storing fractional quantities as floating point is asking for rounding errors: 0.1 plus 0.2 isn't 0.3, and a vial that yields 4.8 doses turns into 4.76 after a few calculations. Changing the quantity columns' type would also touch all the existing inventory.

Deduction at session finalization runs inside the clinical transaction, with several items at once. Two sessions finalizing together can compete for the same items in different orders and deadlock each other.

And reservations, deductions and reversals have to coexist: what's reserved isn't available, what was consumed in a session can't be "unconsumed" by mistake, and what was reversed has to go back to the lot it came from.

## The solution

### Two units on one integer

Quantities remain integers, counting balance steps. Each item has a conversion factor: 1 for a regular item; for an item with a consumption unit, the purchase unit measured in hundredths of the consumption unit. A 2.4 mL vial has factor 240. No column changed type.

In the API, quantity is always in purchase units, and the fraction comes in a separate field, in hundredths of the consumption unit. The two add up: "3 vials and 0.5 mL" is 3 × 240 + 50 = 770 steps. A 0.5 mL dose is exactly 50 steps, so a vial yields 4.8 doses, never 4.76. The screen shows "3 vials (7.20 mL)".

### Deduction by expiry, without touching what's reserved

Deduction follows FEFO (first expired, first out: whatever expires first leaves first). First the balance with no lot, then lots by nearest expiry, with those without an expiry date last. From each lot, only what's on hand minus what's reserved can leave. If the nurse picked a specific lot, her choice stands and FEFO is skipped. Using an expired lot raises a warning, not a refusal, and the expiry warning window is configurable per clinic.

### Consumption inside finalization

When the session is finalized, consumption is recorded in the same transaction as the clinical record, by a single service that owns the balance. Items are locked in a stable order, always the same, so two simultaneous finalizations never lock each other out. A catalog-only item, with no balance tracking, is skipped. Insufficient balance is a conflict that says which item ran short.

### Reservation, deduction and reversal

A reservation holds units from a single lot, the first in FEFO order that covers the whole quantity. If no single lot covers it, the reservation is refused and the message shows how much each lot can give. Cancelling a reservation creates no movement, because nothing left the shelf.

A reversal is a new movement with the opposite sign, which returns exactly to the lots it came from, once per movement. Session consumption can't be reversed: the finalized appointment would still say the supply was used.

### Deduction suggestion from the prescription

So the nurse doesn't assemble the deduction from memory, the consultation offers suggestions: one line per item, with the drugs from the prescription issued during the appointment first and the items mentioned in the consultation transcript after. Each line carries the balance, the next FEFO lot, the quantity the prescribed dose represents and whether there's a shortage. The quantity always comes from the prescription, never from speech. The transcript only flags mentioned items, with typo tolerance proportional to the word's length, and it's neither stored nor logged. A dose by body surface area, like "85 mg/m²", doesn't become a quantity: the suggestion leaves it open instead of guessing.

## An example

Three fictional items, with the suggestion math:

| Item | Purchase | Factor | Prescribed | Suggestion |
| --- | --- | --- | --- | --- |
| Ondansetron | 2 mg ampoule | 1 | 8 mg | 4 ampoules |
| Drug X | 100 mg vial | 10,000 | 250 mg | 2 vials and 50 mg |
| Drug Y | 2.4 mL vial | 240 | 0.5 mL | 50 steps; the vial is left with 190 |

```ts
type Item = { mgPerPurchaseUnit: number; conversionFactor: number; hasConsumptionUnit: boolean };

function suggestedUsage(item: Item, doseMg: number) {
  if (!item.hasConsumptionUnit) {
    // whole unit: round up, never suggest less than the dose requires
    return { purchase: Math.max(1, Math.ceil(doseMg / item.mgPerPurchaseUnit - 1e-9)), steps: null };
  }
  return { purchase: null, steps: Math.max(1, Math.round((doseMg / item.mgPerPurchaseUnit) * item.conversionFactor)) };
}

suggestedUsage({ mgPerPurchaseUnit: 2, conversionFactor: 1, hasConsumptionUnit: false }, 8); // 4 ampoules
suggestedUsage({ mgPerPurchaseUnit: 100, conversionFactor: 10_000, hasConsumptionUnit: true }, 250); // 25,000 steps
```

With two lots of Drug Y, one expiring in three weeks with 2 vials, 1 of them reserved, and another in six months, the 50-step deduction comes from the lot that expires first, from the unreserved part.

## Result

Inventory speaks the clinic's language: it buys by the vial, applies in milliliters and shows both. Fractional math is exact because it never leaves the integers. Deduction happens at appointment finalization, from the lot that expires first, without touching what's reserved and without blocking another finalization. And the suggestion taken from the prescription spares the nurse from working out the dose as a quantity in her head.

## What I take from it

When two units coexist, pick the smaller one as the truth and store integers. A stable lock order is the cheapest way to avoid deadlock. And in an automatic suggestion, separate what's a trusted source, the prescription, from what's only a hint, the speech, and never let the hint decide the number.
