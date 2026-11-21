---
title: When the refresh cookie is reused, I take down the whole device
summary: "With a plain refresh token, a stolen cookie stays valid for weeks, and login and password screens tend to reveal who has an account. I designed authentication so reusing a cookie takes down the whole device and responses look identical with or without an account."
project: yield
order: 3
tags: [Refresh token, Authentication, User enumeration, Security, bcrypt]
---

Imagine someone copies a Yield user's refresh cookie, whether through a malicious browser extension or a shared computer. With an ordinary refresh token, that person gets a session that renews itself for weeks. On another front, someone types emails into "forgot my password" and watches the response: "we sent the code" for one, "email not found" for another. In a few minutes they have a list of who uses a finance app. The two scenarios look different, but call for the same care: don't let a subtle difference become information for an attacker.

## The problem

First, a stolen refresh token can't be a lasting credential. Second, signup, password recovery and login can't reveal whether an email has an account. And I wanted all of that without getting in the way of normal use: the user needs to see a stable list of "connected devices" and be able to end one of them.

## Why it wasn't trivial

Rotating the token on every use, the common recommendation, solves only half. If the owner and the attacker have the same cookie, whoever uses it first gets the new token. The other one, later, presents an already swapped token. The server has to decide what that means and act. And since each rotation creates a new row in the database, the interface needs an identifier that doesn't change on each swap, otherwise the user's "device" changes id every time they open the app.

In enumeration, the difference is rarely just in the text. It's in the HTTP status, in whether an email is sent or not and, above all, in timing. Verifying a password with bcrypt (a deliberately slow hash algorithm) takes hundreds of milliseconds. If the server answers "wrong password" in 300 ms when the account exists and in 5 ms when it doesn't, an identical message protects nothing.

## The solution

### Session families

Each login creates a family, an id that represents that device. The database stores only the SHA-256 hash of the refresh token, never the token. Rotating inserts a new row with the same family id and revokes the previous one with the reason "rotated". The interface lists families, not rows, so the device remains the same across rotations, and ending a device means revoking the family.

### Reuse detection

If a token arrives whose hash matches a row revoked by rotation, someone is using a cookie that has already been swapped. There's no way to know whether it's the owner or the attacker, so I revoke the whole family with the reason "reuse detected". Both lose the session and the legitimate owner logs in again with their password. It's the behavior the OAuth security specification recommends for rotating refresh tokens. Changing the password and changing the email also revoke families, each with its own reason, which makes it easier to audit later why a session dropped.

### Uniform responses

On signup, requesting the verification code for an already registered email returns the same success, without generating a code and without sending an email. If two signups with the same email run in parallel, the database's uniqueness constraint settles it. On password recovery, a nonexistent email also gets success with no email sent, and code verification returns the same "invalid code" error for a nonexistent account and for a wrong code.

On login, what matters is cost. When the email doesn't exist, the server verifies the typed password against a fake bcrypt hash, generated once, and returns the same invalid credentials error. Both paths pay the same CPU price. On top of that there's escalating lockout: every five failures the account is locked for longer, from five minutes up to two hours.

## An example

A fictional timeline of a copied cookie:

| Time | Who | Token presented | What the server does |
|---|---|---|---|
| 09:00 | Owner | R1 | Issues R2, revokes R1 as "rotated" |
| 09:20 | Attacker (copied R1 at 08:55) | R1 | R1 is revoked by rotation: reuse. Revokes the whole family |
| 09:21 | Owner | R2 | R2 was revoked too. Goes to login |
| 09:22 | Owner | password | New family, new device. The attacker is out |

If the order were reversed (attacker at 09:00 and owner at 09:20), the outcome would be the same: whoever arrives with the old token takes everyone down, and only whoever knows the password gets back in. The core of the decision, in a simplified version:

```ts
async function refresh(presented: string) {
  const hash = await sha256(presented)
  const session = await sessions.findByTokenHash(hash)
  if (!session) throw unauthorized()

  if (session.revokedAt) {
    // A swapped token being used again: someone has a copy.
    if (session.revokeReason === 'rotated') {
      await sessions.revokeFamily(session.familyId, 'reuse_detected')
    }
    throw unauthorized()
  }

  const next = randomToken()
  await sessions.rotate(session, await sha256(next)) // same family, new row
  return next
}
```

And login, comparing the two paths (illustrative times):

| Scenario | Status | Body | Approximate time |
|---|---|---|---|
| Email exists, wrong password | 401 | "Invalid email or password" | ~250 ms (real bcrypt) |
| Email doesn't exist | 401 | "Invalid email or password" | ~250 ms (bcrypt against fake hash) |

## Result

A stolen cookie stops being a lasting credential: on the first collision with the owner, the family drops. The device list stays stable across rotations. And the three email entry points don't reveal who has an account, not through the text, not through the status, not through the stopwatch.

## What I take from it

Rotation without reuse detection is half a solution: it only works if the server remembers the tokens it already swapped. And to test for enumeration, I compare the two responses by body, status, side effects and timing. If any of those four differs, the form is still an oracle.
