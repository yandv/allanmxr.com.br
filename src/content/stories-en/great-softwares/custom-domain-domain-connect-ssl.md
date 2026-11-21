---
title: Custom domain in one click and an SSL that tells you when it's ready
summary: "Connecting a custom domain meant copying DNS records in another dashboard and waiting for HTTPS with no feedback, the classic point where people give up. I made the connection one click and an automatic notice when the certificate is ready."
project: great-softwares
order: 7
tags: [Domain Connect, DNS, SSL, Cloudflare for SaaS, Webhooks, RSA]
---

Imagine someone who finishes the sales page on Great Pages and wants it to open at `www.minhaloja.com.br`. The screen shows two DNS records to copy. They open the DNS provider's dashboard in another tab, find three similar menus, paste the CNAME in the wrong place and return to the editor not knowing whether it worked. Even when they get it right, they still wait for the HTTPS certificate with no feedback. That is exactly the point where someone gives up.

## The problem

There were two halves. The first was configuring DNS without asking the person to understand DNS. The right records change depending on whether the address is `www`, the root domain or a subdomain, and every provider has a different dashboard. The second was knowing when the SSL certificate became active. Tracking through a queue, with one message per domain polling the status repeatedly, has a design limit: when the queue's attempts run out, the tracking stops, and the domain can stay pending forever with nobody looking.

## Why it wasn't trivial

For DNS I chose **Domain Connect**, an open standard in which the DNS provider applies a record template after the person confirms in its dashboard. Great Pages comes in as a *Service Provider*, the side that asks for the configuration. The standard is simple on paper and full of details in practice.

- **The signature depends on DNS.** The provider checks the request with a public key published in a TXT record, at a name derived from the service identifier. Each environment (staging and production) has its own domain, so each one needs its own key pair and its own templates.
- **One template doesn't cover every case.** The official template validator rejects a CNAME on the root domain without the option that requires a host, and a template with that option can't reach the root domain's A record. The way out was to keep two templates per environment.
- **Providers interpret the standard differently.** One of them requires the signature always, with the `sig` parameter necessarily at the end of the query, and ignores the `state` parameter, which the standard provides for returning context to the service.
- **Detecting support involves three external calls**: a DNS-over-HTTPS query, reading the provider's settings and checking the template. A network failure in the middle can't become "your domain doesn't support it".

For SSL, the certificate is issued by Cloudflare for SaaS, the product that lets a platform serve HTTPS on customers' domains. The status changes asynchronously, and queue polling put an arbitrary end to the tracking.

## The solution

### Sign what the provider will check

The query sent to the provider is signed with 2048-bit RSA, using the PKCS#1 v1.5 scheme with SHA-256. The private key is kept as a Worker secret, and the public one is derived from it at runtime to be published in the TXT. That way there's no second copy of the key to drift out of sync.

### Carry the context in the path, not in `state`

Since one provider ignores `state`, I put the signed context in the **path** of the return URL. The path comes back intact on any provider. On return, the server verifies the signature and redirects the person to the screen they came from, with success or error.

### Say why it can't be done

Detection returns a readable reason when the domain doesn't support the flow: no TXT record, no settings, unsupported template, missing key or provider down. A transport failure always falls into "provider unavailable", and the text asks to try again instead of stating there's no support. With no key configured, the front end falls back to the manual flow without showing an error.

### Replace polling with an event, with a safety net

For SSL, the fast path became a Cloudflare **webhook**. It's authenticated by a header compared in constant time and immediately reconciles the hostname of that delivery. A delivery from another zone is ignored. If reconciliation fails, the webhook responds with an error and doesn't try to compensate, because there's a second path.

That second path is a **cron job every 30 minutes** that takes up to 200 pending domains, oldest to newest, and reconciles each one. Every pending domain got a final destination: after 7 days without activating, the cron removes the hostname on Cloudflare, marks the domain as failed and notifies the person by email. If the removal fails, nothing is marked, and the next cycle tries again. This avoids declaring failed a hostname that still exists on the other side. Pending items that are too old, above 14 days, expire without an email, so nobody is notified about something they already abandoned.

## An example

This is the idea of the signature, in a minimal version with Web Crypto. The names and values are fictional.

```ts
async function signApplyQuery(params: Record<string, string>, privateKey: CryptoKey) {
  // The provider rebuilds the same string, so the order must be deterministic.
  const query = Object.keys(params)
    .sort()
    .map((key) => `${key}=${encodeURIComponent(params[key])}`)
    .join('&');

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    new TextEncoder().encode(query),
  );
  const sig = btoa(String.fromCharCode(...new Uint8Array(signature)));

  // One of the providers only accepts `sig` as the last parameter.
  return `${query}&sig=${encodeURIComponent(sig)}&key=_dck1`;
}

const query = await signApplyQuery(
  { domain: 'minhaloja.com.br', host: 'www', target: 'pages.example.net' },
  privateKey,
);
```

And the lifecycle of a domain's certificate, on the server side:

| Moment | Event | What happens |
| --- | --- | --- |
| t=0 | person connects the domain | hostname created, status pending |
| t=4 min | webhook arrives | reconciles immediately, status active |
| alternative: webhook is lost | 30-minute cron | reconciles and marks active on the next cycle |
| day 7 still pending | cron | removes the hostname, marks failed, sends email |
| removal fails | cron | marks nothing, tries on the next cycle |

## Result

The person clicks once, confirms in the provider's dashboard and returns to the editor with the domain connected. Those using a provider without support follow the manual flow as before, with no broken screen. The certificate closes by event in most cases, and a domain that never activates gets out of limbo with a reason and a notice, instead of staying pending with no owner.

## What I take from it

With a third-party system that confirms asynchronously, use the event as the fast path and a cron job as the safety net. The two together are simpler than trying to make either one infallible. And every pending state needs a final destination written in the code, otherwise it becomes an invisible queue of forgotten things.
