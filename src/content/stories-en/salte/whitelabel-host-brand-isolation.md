---
title: "Two-level multi-tenancy: the clinic in the route and the brand in the Host"
summary: "The same Workers serve several ERP brands, each with its own domain, accounts and emails, and inside each brand several isolated clinics. I designed the brand to be resolved once, from the Host, and carried into everything that depends on it: identity, token, cookie, CORS, sender and limits."
project: salte
order: 1
tags: [Multi-tenant, Whitelabel, Cloudflare Workers, CORS, Cookies, Hono]
---

A clinic network wants to offer Salte's ERP under its own brand: its own domain, its own logo, emails sent from its own address. The same receptionist might work at a clinic in that network and, at night, at a clinic that uses Salte under the original brand, with the same email on both. To her, those are two products. To the infrastructure, it's the same code, on the same Workers, against the same database. The design had to let both truths coexist without one brand ever seeing the other.

## The problem

Salte is multi-tenant on two levels. On the lower level, each clinic is an isolated tenant: a clinic's patients, schedule, finances and team never show up for another. On the upper level, each whitelabel brand is a universe of accounts: the same email can have one account per brand, each with its own password, Google login and MFA.

The clinic level is visible in the URL: every business route carries the clinic id in the path. The brand level isn't anywhere in the request except the Host. That's where the API has to figure out, on every call, which brand is talking, and from that decide who can sign in, where the browser may call from, which domain the cookie is valid for, which address the email is sent from and which bucket the rate limit counts in.

## Why it wasn't trivial

A badly resolved brand doesn't fail loudly. It writes the row with the wrong brand, accepts another brand's session or sends the email from the wrong sender, and everything keeps looking like it works.

Cookies and CORS have browser rules of their own. A cookie scoped to one brand's domain can't be valid on another brand's domain, and the check for "this host belongs to this domain" has to look at the suffix with a dot, otherwise a domain like `malsalte.app` would pass for `salte.app`. The same goes for the list of origins allowed to make credentialed calls.

And background work has no Host. A nightly job that sends appointment reminders needs to know the clinic's brand with no request to ask.

## The solution

### The brand is resolved once, at the entry point

A middleware at the very start of the stack normalizes the Host (lowercase, no port, no trailing dot, careful with IPv6) and looks the brand up by equality on a single domains column. The same normalization applies to the request Host, to the Origin and to the domain an operator types into the registration form, so there are no two ways to write the same address. The result is stored in the request context, and everything else reads from there.

Salte's own domains and the local hosts fall back to the default brand through a constant, with no lookup. For customer brands, the lookup goes through a cache that is refreshed when the registration changes.

An unknown host and a suspended brand get the same neutral 404, without saying what was looked up. If the lookup fails on a customer host, the response is a 503, never an "if in doubt, it's Salte". Falling back to the default brand would accept the wrong session there and write the wrong brand into new rows.

### Per-brand identity, enforced by the database

Email is unique per brand, not globally: a partial unique index on email plus brand. The user's brand column has no default value on purpose: an insert that forgets the brand fails instead of silently landing on the original brand. Signup and recovery codes are also consumed by email and brand, so a code issued on one brand is neither accepted nor burned on the other.

### The token carries the brand

Both the access token and the refresh token carry the brand as a claim. Authentication compares that claim with the Host's brand and rejects a mismatch with the same generic expired-token message, so it teaches nothing to someone probing. On refresh, the brand check happens before the refresh token is consumed, so an attempt on one brand doesn't burn the legitimate session on the other. Google login stores the flow state with the brand in the key and uses the return URL of the API of the brand that started the flow.

### Cookie, CORS, sender and limits

Session cookies are host-only, with the `__Host-` prefix, `Secure` and `SameSite=Strict`: the browser only sends them to the exact host that created them. A customer brand's CORS accepts only that brand's origins. A custom sender is only used when the address is configured, verified with the active email provider and belongs to the registered domain; otherwise, the email goes out through Salte. And the rate limiter keys carry the brand prefix, so one brand's login attempts never count against the other.

### The clinic, inside the brand

Inside each brand, the clinic route goes through a membership check that answers 404 both for a nonexistent clinic and for someone else's clinic, so nobody can discover clinic ids by probing. Permissions are computed in layers: the owner gets everything; everyone else starts from the profile default (manager, healthcare professional, front desk, sales), receives the clinic's rules and finally the per-person exceptions, switched on or off one by one. An action only counts if its module is also enabled. The result sits in a short cache and is invalidated right away when the profile, the membership or a permission changes.

Jobs, crons and webhooks resolve the brand through the clinic, never through a request.

## An example

Two fictional brands: "Vitalis", with app and API on `vitalis.com.br`, and "Odonto+", on `odontomais.com.br`. Ana uses both with the same email.

| Step | Request | What the API decides |
| --- | --- | --- |
| 1 | Ana signs up on both brands | Two accounts, allowed by the email plus brand index |
| 2 | Login on `api.vitalis.com.br` | Token with the Vitalis brand, `__Host-` cookie on that host only |
| 3 | A script replays that token against `api.odontomais.com.br` | 401 with the expired-token message |
| 4 | The same script tries to refresh with Vitalis's refresh token on Odonto+ | Rejected before the refresh token is consumed: the Vitalis session stays alive |
| 5 | Ana, a receptionist at Vitalis, gets an exception that unlocks finances | Only applies if the finance module is also enabled for her |
| 6 | Her clinic sends an invitation | Goes out from Vitalis's sender if the domain is verified; otherwise, from Salte |

The token check, in short form:

```ts
type Claims = { sub: string; wl?: string };

function brandMatches(claims: Claims, requestBrandId: string, defaultBrandId: string): boolean {
  // old tokens without the claim count as the default brand during the migration
  return (claims.wl ?? defaultBrandId) === requestBrandId;
}

// on a mismatch, the response is the same as for an expired token
```

## Result

A new brand is a registration, not a deploy: domains, visual identity, cookie domain and sender. Each brand sees only its own accounts and sessions, and each clinic sees only its own data, with the database rejecting the combinations the code might forget. The boundary cases, such as one brand's token on another brand, a crossed recovery code and a failed brand lookup, became tests.

## What I take from it

When the tenant isn't in the URL, it has to be resolved at a single point and carried explicitly into everything that depends on it, including the database and the token. And when in doubt about whose request it is, the right answer is to refuse, never to pick a default owner.
