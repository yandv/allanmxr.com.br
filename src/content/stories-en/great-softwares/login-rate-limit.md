---
title: Login attempt limits on two axes, by email and by IP
summary: "How to stop bulk password testing without blocking someone who just mistyped their password or an office sharing one IP. I designed limits by email and by IP, evaluated together, and switched them on behind a flag after observing them in staging."
project: great-softwares
order: 14
tags: [Rate limit, Cloudflare Workers, Security, Multi-tenant]
---

While working on the Great Apps login flow for another reason, one threat-model question kept coming back: what stops a script from calling the login route a thousand times a minute testing passwords? The protection was simple to describe and easy to postpone, and I decided to design it properly.

## The problem

The routes that accept a password or a code (login, password change and second-factor confirmation) had no attempt ceiling. Without one, there is room for brute force against one account and for *credential stuffing*, which is testing lists of emails and passwords leaked from other sites.

The limit had to stop both attacks without bothering someone who mistyped their password three times in a row, or an entire office that reaches the internet through the same IP.

## Why it wasn't trivial

**One limit axis isn't enough.** Limiting only by IP lets through an attack distributed across many IPs against the same account. Limiting only by email lets through a single IP trying a common password against thousands of accounts. I needed both, evaluated together.

**The IP doesn't come from the socket.** The API sits behind the app, so the connection's IP is the app's. The user's real IP arrives in the request body, along with the session data the app was already sending.

**The platform is multi-tenant.** The same email can exist in different whitelabels, which are independent brands running on the same backend. The limit key has to include the tenant, otherwise one brand consumes another's quota.

**Getting the ceiling wrong takes down legitimate people.** A limit that's too tight becomes login downtime, and that's the worst place to cause one.

## The solution

### Rate limit with the native Workers binding

Cloudflare Workers has a rate limit binding: you declare a limiter with a ceiling and a window in the configuration file and call `limit({ key })` in the code. I created two, one by normalized email (lowercase, no spaces) and another by IP, both prefixed by the tenant. Both run in parallel and the request only passes if both allow it.

### Neutral response and useful log

The blocking response is `429` with a stable code and a neutral message, "too many attempts, wait a minute". It doesn't say which axis was exceeded or whether the email exists. The log does: it records which axis was exceeded and masks the email, so I can calibrate the ceiling by looking at data instead of guessing.

### Behind a flag

The middleware goes in before authentication and is switched on by a configuration flag. That let me ship the code turned off, turn it on in staging, observe and only then turn it on in production.

## An example

The limits ended up at 10 attempts per minute per email and 30 per minute per IP. The IP value is higher on purpose: an entire office can leave through the same IP.

See how the two axes complement each other in three fictional scenarios:

| Scenario | Email axis | IP axis | Result |
| --- | --- | --- | --- |
| One person mistypes the password 4 times | 4/10 | 4/30 | Passes |
| One IP tries 1 password on 200 accounts | 1/10 on each | exceeded at the 31st | Blocked by IP |
| 50 IPs try 3 passwords on the same account | exceeded at the 11th | 3/30 on each | Blocked by email |

The core of the middleware is small:

```ts
async function loginRateLimit(req: LoginRequest, env: Env) {
  const email = req.body.email?.trim().toLowerCase();
  const ip = req.body.ip;
  const tenant = req.params.tenantId;

  // Both axes in parallel: one alone lets through a distributed attack
  // (IP only) or one IP sweeping many accounts (email only).
  const [byEmail, byIp] = await Promise.all([
    email ? env.EMAIL_LIMITER.limit({ key: `${tenant}:${email}` }) : { success: true },
    ip ? env.IP_LIMITER.limit({ key: `${tenant}:${ip}` }) : { success: true },
  ]);

  if (byEmail.success && byIp.success) return null;

  logger.warn({ limitedByEmail: !byEmail.success, limitedByIp: !byIp.success, email: mask(email) });
  return json({ code: "LOGIN_RATE_LIMITED", message: "Too many attempts. Wait a minute." }, 429);
}
```

## Result

Bulk password attempts now hit a `429` on the right axis, and the log says which one. No legitimate user was blocked at activation, because the ceilings were chosen with margin and observed in staging before turning them on in production.

## What I take from it

Login rate limiting needs more than one axis, because each attack escapes a different axis. And every control that can block legitimate people is born behind a flag. The flag turns a risk of downtime into an adjustment you can observe and revert in seconds.
