---
title: Making sure the Pix Automático charge day reaches the provider on the right day
summary: "The Pix Automático provider reads the date in Brasília time, and midnight UTC lands on the previous day there, which can push the charge outside the regulatory deadline. I started treating dates as calendar days end to end, and that whole class of error is closed across the system."
project: araute
order: 5
tags: [Pix Automático, Dates and time zones, PostgreSQL, TypeScript, Subscriptions]
---

Picture a merchant who creates a monthly subscription with Pix Automático (Pix recurring debit), charged every 13th. The subscriber authorizes it in their bank app and everything looks right. In the Pix provider's dashboard, though, the charge shows up scheduled for the 12th. No error, no alert, just one day short. And that missing day matters, because Pix Automático has strict regulatory deadlines.

## The problem

Pix Automático is the recurring version of Pix (Brazil's instant payment system): the payer authorizes a mandate once (permission for a receiver to debit amounts from their account at a certain frequency) and the following charges happen without further action. To schedule the debit, the provider receives the charge date.

The first version of the integration sent that date as `2026-08-13T00:00:00Z`, that is, midnight UTC, and the missing day showed up while still in the provider's test environment. The provider interprets the date in Brasília time, and midnight UTC is 9 pm on the 12th there. It reads the previous day.

## Why it wasn't trivial

First, the regulatory window. The instruction for each automatic charge has to go out between 10 and 2 calendar days before settlement. Scheduling within the last two days is rejected by the payer's bank. A one-day shift can push the charge into the forbidden zone.

Second, the first cycle has different paths. If there's an amount to charge right at enrollment, the same QR that creates the mandate also charges the first cycle. If the subscription starts with a trial period, the mandate only authorizes, and the start has to be at least three days out. Each path derives a different date, and each derivation is a place where the time zone can slip in.

Third, and trickiest: in UTC the bug vanishes. A test suite running in UTC passes entirely, because there midnight UTC and the local day coincide.

## The solution

### Classify every date before writing code

I started with one question for each date field: would two people in different time zones, looking at the same record in the same second, see different values? If not, it's a **civil date**. The August billing period is August in Tokyo and in Rio Branco, and the due day is the due day. If so, it's an **instant**, like the moment a payment was confirmed.

### A civil date is text from start to finish

A civil date lives as `YYYY-MM-DD`. In PostgreSQL, the column is `date`, never `timestamptz`. I turned off the driver's parser for that type, so the date comes back from the database as a string, without becoming a JavaScript `Date` along the way. In the API it goes out as the same string, with no time zone suffix.

Comparing two civil dates is comparing strings. Arithmetic (adding months, finding the last day of the month) goes through functions that validate the real calendar, because a format regex accepts `2026-02-31` and the database doesn't.

### An instant becomes a day only with an explicit time zone

When an instant has to become a day, the time zone is always declared. In SQL, `AT TIME ZONE 'America/Sao_Paulo'`. In TypeScript, a single function does that conversion, and nowhere else improvises.

### A single conversion back, at noon

Some providers require a date with a time. At that one point, at the edge, the civil date becomes an instant, always at noon UTC. Noon UTC falls on the same calendar day in any inhabited Brazilian time zone and, in practice, in almost the whole world, so no local interpretation flips the day.

### The cycle anchor

The charge day the subscriber perceives is local. I store the anchor day (1 to 31) and derive each period by resolving the local day first and only then the instant. In short months, the smaller of the anchor day and the last day of the month applies, so a day-31 subscription charges on February 28 or 29. I never add 30 times 24 hours.

## An example

A subscription anchored on the 13th, created at 10:30 pm on August 12 in São Paulo. Here's what each approach produces:

| Approach | Value sent | What the provider reads (Brasília) |
| --- | --- | --- |
| `new Date('2026-08-13').toISOString()` | `2026-08-13T00:00:00.000Z` | Aug 12, 9 pm |
| "Today" via `toISOString().slice(0, 10)` at 10:30 pm | `2026-08-13` | a day ahead: it's still the 12th in Brasília, and the D-2 deadline comes out wrong |
| Civil date + noon at the edge | `2026-08-13T12:00:00.000Z` | Aug 13, 9 am |

The edge code stays small, because all the discipline comes before it:

```ts
type CivilDate = string // 'YYYY-MM-DD', never Date

function toLocalDate(instant: Date, timeZone = 'America/Sao_Paulo'): CivilDate {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(instant)
}

function toProviderDateTime(day: CivilDate): string {
  // noon UTC doesn't change day in any Brazilian time zone
  return `${day}T12:00:00.000Z`
}

const chargeDay: CivilDate = '2026-08-13'
toProviderDateTime(chargeDay) // '2026-08-13T12:00:00.000Z'
toLocalDate(new Date('2026-08-13T01:30:00Z')) // '2026-08-12'
```

And the test that catches the whole class of error runs at a time that's already the next day in UTC:

```ts
test('charge day survives the 9 pm to 11:59 pm window', () => {
  vi.setSystemTime(new Date('2026-08-13T01:30:00Z')) // 10:30 pm on Aug 12 in SP
  expect(nextChargeDay({ anchorDay: 13 })).toBe('2026-08-13')
})
```

## Result

The whole suite now runs with `TZ=America/Sao_Paulo` on purpose. Every new date field gets two boundary tests: an instant between 9 pm and 11:59 pm Brasília time, and another on the 1st of a month.

The rule also became a short list of prohibitions, each with the symptom it causes. `toISOString().slice(0, 10)` moves the day ahead after 9 pm. `new Date('2026-08-13')` shows Aug 12 on a screen in Brasília. The same class of error lurked elsewhere, like a billing period typed in the dashboard that would come back a day earlier, and the single rule closed them all at once, instead of patching case by case.

## What I take from it

Run the tests in a time zone that exposes the error, never in UTC. And don't ask for the user's time zone to fix a civil date: for a civil date the time zone is irrelevant, and any conversion reintroduces the error the rule exists to prevent.
