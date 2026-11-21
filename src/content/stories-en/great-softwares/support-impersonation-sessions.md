---
title: "Signing in as the customer: support links with a deadline, single use and a trail"
summary: "Support needed to see the dashboard exactly as the customer sees it, without asking for a password and without creating a master key. I created access links that work once, expire in minutes and record who entered which account."
project: great-softwares
order: 15
tags: [Authorization, Sessions, Impersonation, Rate limit, Security]
---

A customer opens a ticket saying a dashboard button doesn't show up for them. The support agent looks at their own screen and the button is there. The difference could be the plan, the user's role, a brand setting, a piece of data specific to the account. Without seeing what the customer sees, support keeps asking for screenshots and guessing. Asking for the customer's password is out of the question. What the team needed was a real "sign in as" in Great Apps, and I knew this is one of the most dangerous features you can put in a system.

## The problem

"Sign in as" (*impersonation*) means opening an authenticated session as another user. Badly designed, it becomes a master key: a curious operator gets into any account, a leaked link gives permanent access, or an ordinary user finds a way to pose as someone above them.

The system also has two dashboards: the app, which the customer uses, and the admin, where whitelabel owners (brands that resell the platform under their own identity) manage their customers. Access issued for one dashboard can't open the other.

## Why it wasn't trivial

The requirements pull in opposite directions.

- **Fast for the operator**, but without turning into an eternal login.
- **Working in both dashboards**, with different rules for each.
- **Hierarchy enforced on the server.** Within an account, a lower role can't sign in as a higher role. Admin access only makes sense for whoever owns an active whitelabel.
- **An audit trail.** Every action taken inside the session has to be attributable to whoever is actually on the other end.
- **No endless renewal.** An operator inside a support session can, in theory, issue another link from it. If each new link reset the clock, the session would never end.

## The solution

I split the flow into two calls: issue and redeem.

### Issue

The operator, authenticated with their own operator session, requests access for up to 20 targets at once. Each target is a user and audience pair (`app` or `admin`). The server evaluates each target by rule, without trusting anything the client says about permissions:

- the operator's role must be on the list of roles that can issue;
- `admin` audience is only issued from the main whitelabel and only for users of accounts that own another active whitelabel;
- if the target is in the same account as the operator, the operator's role must be equal to or higher than the target's;
- a nonexistent target is refused with its own code.

For each approved target, the server generates a random 32-byte token and returns it only once. Only an HMAC of the token with a server secret (a *pepper*) goes into the database. Whoever has a copy of the database has no usable link. The token is valid for 5 minutes.

### Redeem

Redeeming first goes through a per-IP rate limit and a format validation of the token, to stop guessing attempts before touching the database. Then, the server finds the record by the hash and consumes the link with a conditional update: it only marks it as used if it hasn't been used yet and hasn't expired. If two tabs try the same link at the same time, the database decides, and one of them gets "link already used".

The opened session carries two marks: the login method is `impersonation` and the `impersonated_by` field holds the real operator. This holds even when the link was issued from another support session: the identity that travels is always the original human's.

When the link was born inside a support session, redemption does three extra checks: the original operator still has a valid role, the issuing session still exists, and the new session inherits the 12-hour ceiling counted from the start of the issuing session.

Errors come out with a stable code and a coherent HTTP status: 400 for an invalid request, 403 for forbidden, 404 for a nonexistent target, 410 for an expired or already used link, 429 for too many attempts.

## An example

A fictional timeline shows the ceiling in action. Operator O opens a whitelabel's admin and, from within it, issues a link to sign in to the app of a customer of that brand.

| Time | Event | Expires at |
| --- | --- | --- |
| 09:00 | O redeems a link and opens a support session in the brand's admin | 21:00 |
| 09:02 | From inside that session, O issues a link for customer C (app) | link: 09:07 |
| 09:03 | O redeems C's link | C's session: 21:00, not 21:03 |
| 09:03 | Another tab tries the same link | 410, already used |
| 20:50 | O issues another link from C's session | link: 20:55 |
| 20:51 | O redeems it | new session: 21:00 |
| 21:00 | All sessions in the chain expire together | |

Chaining links stretches nothing. The clock is the first session's.

The heart of the redemption is the conditional consumption, in a single statement:

```ts
async function consumeSupportLink(tokenHash: string, now: Date) {
  // The condition in the UPDATE itself eliminates the window between "read" and "mark":
  // of two simultaneous redemptions, only one gets the row back.
  const rows = await db.query(
    `UPDATE support_links
        SET used_at = $2
      WHERE token_hash = $1
        AND used_at IS NULL
        AND expires_at > $2
      RETURNING target_user_id, operator_id, issuer_session_started_at`,
    [tokenHash, now],
  );
  if (rows.length === 0) return { error: "LINK_USED_OR_EXPIRED", status: 410 };
  return rows[0];
}

function sessionCeiling(issuerStartedAt: Date | null): Date | null {
  if (!issuerStartedAt) return null;
  return new Date(issuerStartedAt.getTime() + 12 * 60 * 60 * 1000);
}
```

## Result

Support gets into the account with a link that lasts minutes, works once and leaves a record of who acted. An intercepted link is useless after use. A copy of the database is useless, because only the hash is there. And no support session goes past 12 hours, however much the operator chains links.

In the same design, I revisited two ties that would get in the way of legitimate operators without adding real security: the operator session bound to the browser's user agent and link issuing bound to the operator's IP. Both change for mundane reasons, such as a browser update or a network switch, and would kick out someone in the middle of helping a customer. I removed both and kept the controls that matter: deadline, single use and hierarchy.

## What I take from it

Every "sign in as" needs five things: a short deadline, single use, a hash at rest, a hierarchy rule enforced on the server and an absolute ceiling for chaining. And the session has to carry the operator's identity, not just the target's. Without that, the audit log says the customer did something that was actually done by support.
