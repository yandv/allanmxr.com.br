---
title: "Team invitations as a pending contract: access profile and plan seat"
summary: "Inviting someone to a clinic looks like just sending an email, but the invitation promises a role and, sometimes, a limited seat in the plan. I designed the invitation to carry the chosen profile and to reserve the healthcare professional seat until it is accepted or canceled."
project: salte
order: 7
tags: [Multi-tenant, Permissions, PostgreSQL, Plans and limits, Hono]
---

A clinic owner opens the team screen, invites a new person, and picks the occupation "salesperson" and the access profile "commercial". The person may accept within the minute or two days later, already having a Salte account or creating one through the link. In between, the owner can resend the invitation with a different profile, fix the email, or give up. When I designed this flow, the question was: what exactly does the invitation promise, and how do I make sure the promise reaches the other side intact?

## The problem

At Salte, someone joining a clinic has two different things: the occupation, taken from the CBO catalog (the Brazilian Classification of Occupations), and the access profile, which decides what the person sees and does in the ERP. They usually go together, but they are not the same thing. A nurse may have the healthcare professional profile; a manager can come from many occupations.

In the first version of the flow, the invitation stored only the occupation, and the profile was derived from it on acceptance. End-to-end tests with occupation and profile combinations showed the limit of that approach: for some occupations, the derivation landed on a profile different from the chosen one, such as a salesperson joining with the front desk profile. Deriving was not enough; the profile had to travel with the invitation.

The second constraint comes from the plan. The clinic has a limit of healthcare professionals, because that is the seat that weighs the most in the product. If only members counted toward that limit, a clinic with one seat left could send five invitations, and the five acceptances would fight over a single spot. The pending invitation had to take up a seat too.

## Why it wasn't trivial

Storing the profile on the invitation solves the first part, but the invitation has a life of its own. It can be resent with another profile, have its email corrected, be canceled, or expire. Each of those transitions changes what the invitation promises.

Acceptance also has two paths: the person who already has a Salte account and joins one more clinic, and the person who creates the account through the invitation itself. Both must end in the same state, with the same audit trail.

And the seat count has a self-counting trap. If the pending invitation holds a seat, then at the moment of acceptance it cannot count again, or the last seat would reject the very person who reserved it.

## The solution

### The invitation carries the profile

The invitation now stores the chosen profile and also the product it came from: the ERP or the Salte agents app, which has its own sign-in screen. That way, the invitation link and the resend link always point to the right place.

On resend, the chosen profile wins over the profile of the first message. Whoever resent it changed their mind, and the invitation follows.

### Both acceptances pin the profile the same way

By design, member creation does not write the profile. So both acceptance paths go through a single step that pins the invitation's profile to the newly created member and writes the same audit line as a manual profile change. For anyone auditing, "joined as commercial through the invitation" and "became commercial by a change" have the same shape.

### Two doors for the healthcare seat

The seat count is explicit at two doors:

- **At invitation time**, the question is "is there still room, counting who is already in and who has already been invited?". Members holding a seat plus pending, non-expired invitations holding a seat, compared against the plan limit.
- **At acceptance time**, the question is "is there room for this person to join?". Here pending invitations are left out of the count, because the invitation being accepted is one of them.

An invitation holds a seat if the occupation is a healthcare one in the catalog or if the chosen profile is the healthcare professional one. The second condition matters: without it, a receptionist invited with a healthcare profile would join without taking a seat.

### Resend that changes the profile

If a pending invitation that did not hold a seat is resent with a healthcare profile, it now holds one, so the invitation door is checked. If it already held one, it is not checked again, so it is not counted twice and rejected at the limit.

Along with that, I delivered what was missing for the invitation to be manageable: canceling a pending invitation and correcting the email of an invitation sent to the wrong address. Both routes have a body size limit, like the rest of the API.

## An example

A fictional clinic with a three-healthcare-professional plan, two already on the team:

| Step | Action | Members with a seat | Pending invitations with a seat | Result |
| --- | --- | --- | --- | --- |
| 1 | Invites a nurse | 2 | 0 | Accepted: 2 + 0 < 3 |
| 2 | Invites a physiotherapist | 2 | 1 | Rejected: 2 + 1 = 3 |
| 3 | Invites a salesperson, commercial profile | 2 | 1 | Accepted: holds no seat |
| 4 | Nurse accepts | 2 | 1 (hers) | Accepted: 2 < 3, pending ones left out of the count |
| 5 | Resends the salesperson's invitation with a healthcare profile | 3 | 0 | Rejected: 3 + 0 = 3 |

The two doors, in short form:

```ts
type Door = 'invite' | 'accept';

function hasHealthSeat(
  limit: number | null,
  membersHoldingSeat: number,
  pendingInvitesHoldingSeat: number,
  door: Door,
): boolean {
  if (limit === null) return true; // plan with no seat limit
  // on accept, the invitation coming in is one of the pending ones
  const promised = door === 'invite' ? pendingInvitesHoldingSeat : 0;
  return membersHoldingSeat + promised < limit;
}
```

In step 4, if the acceptance door counted the pending ones, the math would be 2 + 1 = 3 and the nurse would be rejected from the very seat her invitation reserved.

## Result

The profile chosen on the screen is the profile the person joins with, in both acceptance paths, with auditing identical to a manual change. The plan's healthcare professional limit also applies to promises: you cannot invite beyond what fits and only find out at acceptance. Each case became an end-to-end test, including the resend that swaps the profile.

## What I take from it

An invitation is a pending contract, and everything it promises has to be stored in it, not deduced later. And every seat count has two different questions, "can I still promise?" and "can I honor this promise?". Mixing the two is the most common way to reject the right person or accept one person too many.
