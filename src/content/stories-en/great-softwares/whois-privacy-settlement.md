---
title: WHOIS privacy that the registrar takes hours to confirm
summary: "WHOIS privacy sometimes takes hours to switch on, and in the meantime the customer's personal data stays exposed. I separated instability, definitive refusal and our own error, and each case now resolves or raises an alert at the right time."
project: great-softwares
order: 20
tags: [OpenSRS, Cloudflare Workflows, Cron, Backoff, TypeScript]
---

Someone registers `estudiomarina.com` and pays extra for WHOIS privacy, the service that hides the holder's name, email and phone from the public domain lookup. The registration finishes in seconds. The privacy doesn't. Right after registration, the registrar responds that it's "being turned on". Ten minutes later, sometimes it still is. In the meantime, anyone who looks up the domain sees her personal data.

## The problem

The registrar turns privacy on asynchronously. When I query right after registration, I can get four responses: confirmed, pending, not applied, or an error that says nothing for certain.

If I give up early, the customer pays for a service she didn't receive and is left with exposed data. If I insist forever, a domain gets stuck in a retry queue that never ends, burning calls to the registrar.

## Why it wasn't trivial

The hard part was that three different situations arrived as the same "failed".

1. **Registrar instability.** Timeout, rate limit, request still processing. It passes on its own.
2. **Definitive refusal.** The TLD (the ending, such as `.com` or `.io`) doesn't support privacy. It will never pass, no matter how many times I try.
3. **Our own error.** Expired credential, wrong permission on the reseller profile. It looks like a refusal, but it's an operations problem.

Treating all three the same gives the worst result in each case. Giving up on an instability leaves the customer exposed. Insisting on a definitive refusal wastes attempts and time for nothing. And the third case is the trickiest: concluding "not applied" because our token expired for an hour would be recording as a registrar failure an error that was ours. Since the routine processes domains in batches, that would happen to dozens at once.

## The solution

### Two phases, two clocks

1. **Fast phase**, inside the provisioning Workflow (Cloudflare Workflows runs durable steps that survive restarts). Right after registration, I read the state. If it's pending, the step sleeps for two minutes and reads again. If it wasn't applied, I try to switch it on again up to three times. This resolves the common case in minutes.
2. **Slow phase**, in a cron job every 15 minutes. It picks up whatever the fast phase didn't resolve and continues with exponential backoff: 2 minutes, 4, 8, up to a ceiling of 1 hour between attempts. It stops at eight attempts or six hours, whichever comes first.

The six-hour deadline counts from a start timestamp written only once, on the first check. An early design counted from the date of the last check, but that date is rewritten on every attempt: the deadline would move along with time and never expire. That is why the start got a timestamp of its own. A `CHECK` constraint in PostgreSQL now guarantees that the start timestamp and the state are born together.

### Lease per domain

Before trying, the cron reserves the domain for 10 minutes with a conditional `UPDATE`. If two cron runs overlap, only one wins the reservation and the other skips the domain. Nobody spends an attempt twice.

### The integration returns the reason, not just the verdict

Reading and activation return two things: the verdict (confirmed, pending, not applied, unknown) and the failure type (transient, not eligible, operator defect). A map ties each error code from the OpenSRS integration to one of those three categories. The map is a `Record` over the union of all the codes, so a new code breaks compilation until someone decides where it falls.

### A pure function decides

The entire policy lives in one function that takes verdict, failure, attempts, start and now, and returns the outcome. No database, no network, no hidden clock. The rules:

- confirmed ends with success;
- not eligible ends immediately, because it's an observed fact;
- transient and operator defect keep trying up to the ceiling, so a passing error of ours doesn't become a verdict against the customer;
- at the end of the deadline, the outcomes split: "blocked" when the last failure was ours (urgent, someone needs to act) and "unresolved" when the registrar merely fluctuated.

Both bad outcomes generate an audit entry and an alert for operations, with different texts.

## An example

The function, simplified:

```ts
type Verdict = "CONFIRMED" | "PENDING" | "NOT_APPLIED" | "UNKNOWN";
type Failure = "TRANSIENT" | "NOT_ELIGIBLE" | "OPERATOR_DEFECT" | null;

const MAX_ATTEMPTS = 8;
const DEADLINE_MS = 6 * 60 * 60 * 1000;
const delaySeconds = (attempt: number) => Math.min(120 * 2 ** (attempt - 1), 3600);

function decide(v: Verdict, f: Failure, attempts: number, startedAt: Date, now: Date) {
  if (v === "CONFIRMED") return { done: true, outcome: "confirmed" };
  // A definitive refusal must close before anything else, or it burns every retry.
  if (f === "NOT_ELIGIBLE") return { done: true, outcome: "not_applied" };

  const expired = now.getTime() - startedAt.getTime() >= DEADLINE_MS || attempts >= MAX_ATTEMPTS;
  if (!expired) {
    return { done: false, retryAt: new Date(now.getTime() + delaySeconds(attempts + 1) * 1000) };
  }
  if (v === "NOT_APPLIED") return { done: true, outcome: "not_applied" };
  return { done: true, outcome: f === "OPERATOR_DEFECT" ? "blocked" : "unresolved" };
}
```

And three domains going through it:

| Domain | Timeline | Outcome |
| --- | --- | --- |
| `a.com` | t=0 pending, t=2min confirmed in the Workflow | Confirmed in 2 minutes |
| `b.io` | Workflow exhausts its three attempts, the cron resumes on the following passes at growing intervals | Confirmed on the cron's third attempt, in under an hour |
| `c.xyz` | First read returns "TLD doesn't support it" | Not applied immediately, no attempt spent |

The commented line in the code has a history. In an earlier version of the function, the "not eligible" check was nested inside another branch, which wasn't reached in this case, and a domain like `c.xyz` would spend all eight attempts and six hours before closing. Since the decision is a pure function, the case added to the test table exposed the error, and the fix was to move one line to the top.

## Result

The common case resolves in minutes, the slow case within six hours and the impossible case closes on the first response. Operations gets two distinct kinds of alert, one that asks for immediate action and another that only asks for follow-up. And the whole policy fits in a function tested line by line, with no database or network mocks.

## What I take from it

I model failure as data, not as an exception. When the failure has a type, the same code decides when to insist, when to stop and who needs to be notified. And I separate the decision (pure function) from the effect (database, network, cron): that's what lets a business rule bug show up in a table test instead of in production.
