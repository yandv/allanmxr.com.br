---
title: "The bank account inside the ERP: transactional PIN, outflow limits and scheduled Pix"
summary: "With the clinic's bank account inside the ERP, a session left open on the front desk computer can't be enough to move money out. I designed outflows with a per-person PIN verified on every operation, per-transaction and 24-hour limits that hold up under races, and a scheduled Pix that follows the same rules."
project: salte
order: 3
tags: [Pix, Woovi, Security, Finance, PostgreSQL, Cloudflare Workers]
---

A clinic's finance manager pays the lab, schedules the rent for the 5th and sends the professional payouts, all without leaving the ERP. The clinic's bank account lives in there, through Woovi: incoming and outgoing Pix (Brazil's instant payment system), scheduled Pix, boleto (Brazilian bank slip) and transfers. It's convenient, and that's exactly what makes the design delicate. The front desk computer keeps its session open all day. If being logged in were enough to move money, anyone who sat down there, or any stolen session, could drain the account.

## The problem

Outflows needed a second barrier, independent of the session, and a cap that limits the damage even when the barrier is beaten. All of that without making day-to-day work unbearable: the manager makes dozens of legitimate payments.

Three pieces came out of that requirement: a transactional PIN per person, verified on every outflow operation; outflow limits per transaction and per 24-hour window; and a scheduled Pix that, running on its own in the middle of the night, follows the same rules as someone at the screen.

## Why it wasn't trivial

A six-digit PIN has only a million combinations. Stored with an ordinary hash, it falls to brute force in seconds if the database leaks. On Cloudflare Workers, slow-hash options are limited: there's no argon2 or scrypt, and PBKDF2 has an iteration cap.

Wrong attempts have to count even when the request fails. If the count lived inside the route's transaction, the rollback from the error would erase the very wrong attempt.

The 24-hour limit has a race built in: two simultaneous outflows can look at the window at the same time, see that it fits and both go through. And the scheduled Pix runs with no person there to type the PIN.

## The solution

### The PIN belongs to the person, not the clinic

Each person has their own six-digit PIN. It's stored with HMAC-SHA256 over a server-side secret key (the "pepper") and then PBKDF2 with 100,000 iterations and a random salt, compared in constant time. With PBKDF2 capped by the platform, it's the pepper, which doesn't live in the database, that protects the hashes in a leak.

Five wrong attempts lock the PIN, and each lock lasts longer than the previous one: 5 minutes, 30 minutes, 2 hours, 8 hours, 24 hours, 72 hours. The highest step isn't permanent on purpose, so an attack can't become a way to lock the manager out forever. A correct attempt resets the count.

On top of the global limit, each verification carries a binding to the operation: type, amount and destination. Three wrong attempts on the same payment within an hour pause that payment, without even checking the hash, while everything else keeps working.

There is no "validated PIN" kept in a cache. Every outflow operation sends the PIN again. Registering the PIN requires an extra identity check, by an emailed code or by the authenticator when the person has MFA, so that a stolen session can't choose its own PIN. Moving money also requires membership in the clinic and the permission to manage finances.

### The wrong attempt survives the error

The PIN middleware runs after body validation and before the route's transaction. That way, the error counter is written and committed even if the request ends in an error. Each attempt, right or wrong, becomes an audit record with the IP; if a correct attempt can't be recorded, the operation is rejected.

### Limits that hold up under races

Each account has a per-transaction limit and a limit over a sliding 24-hour window. The window slides rather than following the calendar day, because a day that resets at midnight allows spending double the limit between 23:59 and 00:01. It adds up Pix, boletos and transfers that are processing or completed; failures don't count.

The race is resolved with two checks. The first happens before the outflow is written. The second, after the outflow row is written as processing, when it already counts itself. If a concurrent outflow made the window overflow, this row is marked as failed before it reaches Woovi. In this design, both concurrent outflows may be rejected, but the limit is never exceeded.

No API route changes the limits. A stolen session with finance permission can't raise the limit before draining the account.

### Scheduled Pix with the same rules

A scheduled Pix requires the PIN at creation, and the PIN binding covers amount, key, date, frequency and end date. A series with no end date never ends, so the end date has to be signed too. The date has to be in the future and at most one year away.

At creation, the amount goes through the per-transaction limit and the 24-hour limit measured around the scheduled date, looking in both directions, since scheduling in reverse order would punch through a window that only looked backward. At execution, the check that applies is the regular outflow one.

A job every five minutes picks up the due scheduled items, claims each one with an update conditional on its state, and runs it on behalf of whoever created it, without asking for the PIN again: it was given at creation, for that exact operation. A monthly repeat anchors on the original day (31st, then 28th in February, then 31st again). If the job was down, it skips to the next future date instead of firing all the missed ones at once. Canceling only works while the scheduled item hasn't started running; after that, the response is a conflict.

## An example

A fictional clinic, with a R$ 10,000 per-transaction limit and R$ 150,000 over 24 hours. At 2 p.m., R$ 142,300 has already gone out in the last 24 hours.

| Time | Action | Result |
| --- | --- | --- |
| 14:00 | Pix of R$ 9,500 to the lab | Rejected: 142,300 + 9,500 exceeds 150,000 |
| 14:01 | Pix of R$ 7,000, wrong PIN three times | That payment is paused for one hour |
| 14:03 | Two more errors on other operations | Five errors: PIN locked for 5 minutes |
| 14:10 | She and a colleague send R$ 7,000 at the same time | Both pass the first check; the second sees 156,300, and at least one becomes a failure before going out |
| 14:20 | She schedules rent of R$ 12,000 for the 5th | Rejected at creation: above the per-transaction limit |

The second limit check, simplified:

```ts
async function sendPix(accountId: string, amountCents: number) {
  await assertFitsWindow(accountId, amountCents); // 1st: before the row exists
  const row = await insertOutbound({ accountId, amountCents, status: 'PROCESSING' });
  // 2nd: now the row counts itself; whoever raced with it is already summed in
  if (!(await windowStillFits(accountId))) {
    await markFailed(row.id, '24-hour limit reached by a simultaneous send');
    return row;
  }
  return provider.sendPix(row);
}
```

## Result

An open session doesn't move money: every outflow asks for the person's PIN, bound to that operation, with progressive lockout and an audit trail. The limits cap the damage in the worst case and hold up under simultaneous sends. The scheduled Pix runs on its own without loosening any of these rules. A test walks through every route that moves money and fails if any of them lacks the PIN barrier.

## What I take from it

Money calls for a barrier per operation, not per session. Security counters have to survive the very error they cause. And when two simultaneous checks can both err on the permissive side, it's worth accepting that both get rejected to guarantee the limit is never exceeded.
