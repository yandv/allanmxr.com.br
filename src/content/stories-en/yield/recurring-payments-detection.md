---
title: Telling fixed bills from habitual spending by measuring charges per period
summary: "Finding subscriptions in a statement looks like counting repeats, but what repeats most is the corner grocery store. Testing the first heuristic against a realistic history, I replaced occurrence counting with one charge per period, and the detector started telling fixed bills from habitual spending."
project: yield
order: 2
tags: [TypeScript, Recurrence detection, Statistics, Pure functions, Personal finance]
---

Yield has an "what's due in the next few days" widget: streaming, gym, electricity, phone plan. The promise is that the user registers nothing; the app figures it out from the statement. When I tested the first heuristic against a realistic history, before it reached the screen, the highest-confidence item was the neighborhood grocery store. It made sense to the algorithm: it showed up every week, sometimes twice. To anyone reading, it was obviously wrong.

## The problem

Find recurring series in a transaction history and predict the next date, with a confidence score. The history mixes spending that looks like a subscription (groceries every week, the gas station) with subscriptions that don't look like one (the electricity bill changes amount every month and sometimes falls on a different day).

## Why it wasn't trivial

The most intuitive metric is misleading. In the first approach, confidence grew with the number of occurrences, and what shows up most in a statement is precisely habitual spending, not the bill.

The raw data gets in the way too. The payee name is sometimes the payment intermediary (the digital wallet, the acquirer) and not the real merchant, and grouping by it merges unrelated things. A Pix (Brazil's instant payment system) to a company and a Pix to a person look alike on the statement. And the day shifts: a bill due on the 31st lands on the 28th in February.

## The solution

The detector is a pure function: transactions in, candidate series out. No database, no clock of its own (the reference date is a parameter). That let me test dozens of scenarios with fabricated data and tune the heuristic without touching infrastructure.

### Group by the best available signal

Each transaction goes into the group of the most reliable signal it has: first the merchant already identified by classification, then the structured payee of the Pix or boleto (Brazilian bank slip), then the normalized description (no installment marker, no digits, no "LTDA"). Payment intermediaries don't count as a key. Within a group, a big jump in amount opens a new subgroup, so a R$ 29.90 subscription doesn't get mixed with a one-off R$ 400 purchase at the same store. A bill that varies gradually remains a single group.

### Cadence from the median of the intervals

I compute the intervals in days between dates, take the median and discard intervals far from it (more than 2.5 times above or below), so a one-month pause doesn't make the series look irregular. Then I fit the median into the nearest bucket, each with its own tolerance: weekly, biweekly, monthly, bimonthly, quarterly, semiannual or annual. Outside those, the series is irregular. "Every 5th and 20th" is handled as a separate case, because a 15-day median would confuse it with biweekly.

### Confidence from "one charge per period"

That was the turning point of the design. Instead of counting occurrences, I measure how many charges happen per cycle of the detected cadence. A bill charges close to once per cycle. The grocery store charges several times. Confidence became a weighted sum: 45% interval regularity, 35% closeness to "one per period", 10% series maturity and 10% amount stability. Above 1.6 charges per period, the series is discarded.

On top of that come domain signals. Categories like energy, telecom and software add confidence. Groceries and fuel need a higher bar. Pix to an individual loses points, because it's usually a one-off payment. Merchants flagged as typically recurring get a bonus and are exempt from the stable-amount criterion, so the variable electricity bill survives.

### Predict the next date and reconcile

For monthly or longer cycles, I use the most frequent day of the month, adjusted to the last day when the month is short. Annual adds 12 calendar months, not 365 days. Installments ("PARC 03/12") are a finite series and don't become a subscription.

The series is stored with its own id, separate from its content, because the user's decision (confirm or dismiss) has to survive when classification changes. On each new classification, a reconciliation matches the candidates against existing series. A series silent for about three cycles is flagged as probably cancelled.

## An example

Two fictional six-month groups, with monthly cadence detected:

| Group | Occurrences | Charges per period | Regularity | `oncePerPeriod` |
|---|---|---|---|---|
| Streaming, R$ 39.90 every 8th | 6 | 1.0 | high | 1.0 |
| Neighborhood grocery store | 31 | ~5.2 | medium | 0 |

With the first approach's counting, the grocery store won 31 to 6. With the new one, it doesn't even get a score: 5.2 charges per period is over the cap and the series is discarded. The core calculation, simplified:

```ts
const clamp01 = (x: number) => Math.min(1, Math.max(0, x))

function confidence(s: {
  gapCov: number            // coefficient of variation of the intervals
  chargesPerPeriod: number
  maturity: number          // 0 to 1, grows with the number of cycles
  amountStability: number   // 0 to 1
}): number | null {
  if (s.chargesPerPeriod > 1.6) return null
  const regularity    = clamp01(1 - s.gapCov / 0.35)
  const oncePerPeriod = clamp01(1 - Math.abs(s.chargesPerPeriod - 1) / 0.6)
  return 0.45 * regularity + 0.35 * oncePerPeriod
       + 0.10 * s.maturity + 0.10 * s.amountStability
}

confidence({ gapCov: 0.04, chargesPerPeriod: 1.0, maturity: 0.8, amountStability: 1 }) // ~0.93
confidence({ gapCov: 0.20, chargesPerPeriod: 5.2, maturity: 1.0, amountStability: 0.3 }) // null
```

The `oncePerPeriod` term peaks at 1 and falls off on both sides. A bill that skipped a month (0.8 per period) loses a little; the grocery store loses everything.

## Result

The widget lists what's due, with a predicted date and confidence, and stops showing what the user dismissed. The screen never writes to the database when opened: every write happens in reconciliation, which runs in the queue consumer after each classification. Because the detector is pure, every new statement case becomes a test with half a dozen fabricated transactions before any change to the heuristic.

## What I take from it

Before choosing a metric, I ask what behavior it rewards. Counting occurrences rewarded exactly what I wanted to discard. The right question wasn't "how often does it appear", but "does it appear at the rhythm of a bill".
