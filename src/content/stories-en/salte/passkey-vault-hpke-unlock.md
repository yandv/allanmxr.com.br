---
title: A password vault that even my own server can't open
summary: "The agent needed to type passwords into external systems, and storing them under our own key would expose every one in a breach. I built a vault that even my server can't open, unlocked by a passkey when an authorized person approves."
project: salte
order: 23
tags: [HPKE, WebAuthn, Passkeys, X25519, Durable Objects, Cryptography]
---

A Salte agent operates a remote browser on behalf of a clinic's team, for repetitive tasks in external systems. At some point the task reaches a login screen. The agent has to type a username and password. The question that cost me sleep was: where was that password one second earlier? If the answer was "in our database, encrypted with a key of ours", then anyone with access to the database and the key could open every password of every customer.

## The problem

Encrypting with a platform key protects against someone who only sees the database, but not against someone with access to both. I wanted a vault where the server only stores envelopes it doesn't know how to open. And I wanted the agent to type a password only when an authorized person was present, approving that specific use.

## Why it wasn't trivial

The agent needs the password in plaintext to type it into the field. And the one running the agent is the server. So someone has to hand the password to the server at the time of use, without it passing through any persistent place, and without a captured request being reusable later.

There were also people problems. An organization has more than one person in charge. When one of them leaves, the key has to rotate. And passkeys get lost along with the phone.

## The solution

### Seal in the browser

Whoever registers the login types the password in their own browser. Right there, the content (system origin, allowed domains, username, password) is sealed with the vault's public key using HPKE (Hybrid Public Key Encryption, RFC 9180: a standard for encrypting a message to a public key). The suite is X25519 for key exchange, HKDF-SHA256 for derivation and AES-256-GCM for encryption.

The server receives only the envelope and metadata. The API rejects any body that carries a plaintext password field, without echoing the value in the error. No platform key opens the envelope.

### Who holds the vault key

The vault's private key is sealed separately for each guardian, a responsible person flagged in the organization, and only opens with their passkey, requiring user verification (biometrics or PIN). This uses the WebAuthn PRF extension, which lets the passkey derive a stable secret without exposing its key. For those without a PRF-capable passkey, there's a recovery phrase with a derivation function whose minimum cost the database itself enforces.

### Unlock with the person present

When the agent reaches a sealed login, a guardian has to approve the unlock. The request is born inside a Durable Object (a Cloudflare object with in-memory state and a single instance per key, which gives a natural coordination point). There an ephemeral, non-extractable X25519 key pair is generated, which never goes to storage.

The request has a one-time identifier, is valid for 120 seconds, and carries a challenge that binds organization, system, request and the ephemeral public key. The guardian's browser signs that challenge with the passkey, opens the envelope locally, shows "the agent will log into such system as such user" and re-seals, now to the ephemeral key.

### Refuse anything that isn't exactly that

The server checks the passkey assertion before anything reaches the object: the passkey belongs to the guardian, the site origin and identifier match exactly, the usage counter went up. The object refuses a request that is nonexistent, expired, already used or carrying another request's challenge. If two guardians respond at the same time, the first wins and only one login gets typed. If the origin stored in the envelope doesn't match the login's site, the operation stops.

The password opens in memory, goes to the typing and leaves memory right after.

### Departure and loss

Removing a guardian deletes their envelopes and flags the vault to rotate its key. Revoking a passkey on suspicion of loss takes the guardian out of the vault, even if it's their only one, because whoever has the device can open what it protects.

## An example

A timeline of an unlock, with illustrative times:

| Time | What happens |
| --- | --- |
| t=0 s | The agent reaches the login of a system with a sealed password and pauses. |
| t=0.1 s | The Durable Object generates the ephemeral pair, the one-time id and the challenge. Deadline: t=120 s. |
| t=8 s | The guardian opens the request in the browser and confirms with biometrics. The passkey signs the challenge. |
| t=8.3 s | The browser opens the envelope locally and re-seals it to the ephemeral key. |
| t=8.5 s | The server validates the assertion. The object checks id, deadline and challenge and marks the request as used. |
| t=8.6 s | The password is opened in memory, typed into the field and discarded. The ephemeral key dies with the request. |
| t=9 s | A second guardian responds to the same request and is refused: already used. |

The central piece on the server side fits in a few lines:

```ts
const pending = new Map<string, { keyPair: CryptoKeyPair; challenge: string; expiresAt: number }>();

async function openUnlockRequest(context: string) {
  // extractable = false: the private key never leaves the object nor goes to disk
  const keyPair = await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
  const requestId = crypto.randomUUID();
  const challenge = await sha256(`${context}|${requestId}`);
  pending.set(requestId, { keyPair, challenge, expiresAt: Date.now() + 120_000 });
  return { requestId, challenge };
}

function claim(requestId: string, challenge: string) {
  const request = pending.get(requestId);
  pending.delete(requestId); // single use, even when verification fails
  if (!request || request.challenge !== challenge || Date.now() > request.expiresAt) return null;
  return request.keyPair;
}
```

The `delete` before the verification is deliberate: a request never gets a second chance, even if the first attempt comes wrong.

## Result

The server stores only what it can't open. A database leak hands out envelopes with no key. Each unlock became an event with a person, a passkey, a deadline and a key that ceases to exist when the request ends. And the question "where was the password one second earlier?" got a good answer: in the browser of an authorized person who had just said yes.

## What I take from it

When the server needs a secret for a few seconds, make the secret arrive through an ephemeral channel, bound to the request and protected by a non-extractable key. A stored key is a key that will one day be in the wrong place.
