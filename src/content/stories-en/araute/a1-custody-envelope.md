---
title: Storing a merchant's A1 certificate so a database copy alone can't use it
summary: "Issuing invoices means storing each merchant's digital certificate, and anyone who stole one could impersonate the company. I isolated the keys in a separate service, so a copy of the database alone is no longer enough to use them."
project: araute
order: 9
tags: [Cryptography, AES-GCM, Cloudflare Workers, PostgreSQL, NFS-e]
---

When a merchant turns on automatic invoice issuing, they upload the company's A1 certificate and type its password. From then on, every invoice Araute issues on their behalf is signed with that private key. It's the same key they use to sign tax documents anywhere else. If it leaks, someone can impersonate their company before the tax authorities.

## The problem

To issue an NFS-e (Brazilian electronic service invoice) on the merchant's behalf, I have to sign the XML with their A1 certificate. The A1 is the file-based digital certificate from ICP-Brasil, the country's official public key infrastructure. In practice, that means holding the private keys of many merchants, indefinitely.

The design question was blunt: if someone gets a copy of the database, or exploits an API route, is that enough to use a merchant's key? The answer had to be no.

## Why it wasn't trivial

There was no HSM, the dedicated hardware that holds keys without ever handing them out. The control had to be software, and it had to be honest about the risk that remains.

The sensitive material also goes through several stages: ingestion, decryption, XML signing, and use as a client certificate in the mTLS transport. Each stage is a chance for the key to show up in a log, in a function's return value, or in a variable that lives longer than it should.

And the system is multi-tenant. A context mistake, like the wrong merchant ID in a call, must never end up signing one merchant's invoice with another merchant's key.

## The solution

### A service just for this

Custody is a separate Worker with no public HTTP route. The API talks to it through a service binding, Cloudflare's private Worker-to-Worker call that never goes over the internet. Only this service holds the master key, and the decryption code doesn't exist in the API. That's a stronger guarantee than "the API doesn't have permission": it simply doesn't know how to decrypt.

### Envelope encryption

Each certificate version gets a fresh, random 256-bit data key. It encrypts the private key with AES-256-GCM, a cipher mode that also detects any tampering with the ciphertext. The nonce, the unique value per encryption, is always generated inside the service and never accepted from the caller.

The data key, in turn, is encrypted by the KEK (key encryption key, the master key that only wraps other keys). The database holds only the ciphertext and the wrapped data key. A copy of the database, on its own, is noise.

### Context is part of the cryptography

AES-GCM accepts an AAD, additional authenticated data: information that isn't encrypted but is included in the integrity tag calculation. I use the AAD to bind the envelope to its owner and its use: merchant, establishment, certificate version, environment, and purpose.

Decrypting with any other context fails exactly as it would if a single bit of the ciphertext had been changed. A context mistake stops being a code path I could implement badly and becomes a cryptographic error.

### One-time authorization

Before any decryption, a policy decides whether that use is allowed and issues a one-time authorization with a short lifetime. It's consumed atomically, in a transaction with a per-credential lock, and consumption happens before decrypting. Two concurrent calls with the same authorization can't both get through.

### Decrypt once, zero always

Decryption happens once per operation, in memory. The plaintext data key and private key are zeroed in a `finally` block, even when something fails midway. The material never shows up in a log or a return value.

### Fail-closed revocation

Every credential starts as "unverified", and in production the service refuses to sign until it confirms the certificate hasn't been revoked. Revocation sources live in a fixed list inside the service, never in the URL carried by the certificate itself, so a malicious certificate can't make the service fetch an arbitrary address.

### Destroy and rotate

To destroy a credential, I delete the wrapped data key instead of the row. The ciphertext becomes useless and the audit trail stays. This is what's called crypto-shredding.

To rotate the KEK, I re-wrap every data key with the new one, without decrypting any private key.

## An example

The core idea of an envelope with AAD fits in a few lines using WebCrypto:

```ts
type EnvelopeContext = {
  tenantId: string
  establishmentId: string
  certVersion: number
  environment: 'production' | 'sandbox'
  purpose: 'xml_signature'
}

function encodeAad(ctx: EnvelopeContext): Uint8Array {
  // JSON with a fixed field order: the encoding must be unique per context
  return new TextEncoder().encode(JSON.stringify([
    ctx.tenantId, ctx.establishmentId, ctx.certVersion, ctx.environment, ctx.purpose,
  ]))
}

async function openEnvelope(dataKey: CryptoKey, blob: Uint8Array, ctx: EnvelopeContext) {
  const iv = blob.slice(0, 12)
  const sealed = blob.slice(12)
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: encodeAad(ctx) },
    dataKey,
    sealed,
  )
}
```

Now picture the envelope for merchant `t_8f2a`, establishment `e_01`, version 3. A call arrives with everything correct except `tenantId: 't_91c0'`, because of an upstream bug. `decrypt` doesn't return the other merchant's key or a partial result: it throws, because the tag doesn't match. The same happens if someone tries to use a sandbox envelope in production, or to use the signing key for another purpose.

The encoding detail matters. If the AAD were a plain concatenation of the fields, different contexts could produce the same bytes (`"ab" + "c"` and `"a" + "bc"`). The encoding has to be injective: two different contexts always produce two different AADs.

## Result

A copy of the database, or a compromised API route, is no longer enough to use a merchant's key. You'd have to reach the custody service itself, holding the right authorization.

I also wrote down what the design doesn't cover. KEK rotation handles a KEK leak with the database intact. If the KEK and the database leak together, the remedy is to destroy the credentials and ask merchants to upload their certificates again. In tests, the certificate is always synthetic, generated with a fake chain, never a real A1.

## What I take from it

When possible, turn a logic error into a cryptographic error. A check like "does this ID belong to this merchant" can be forgotten in a new code path. An AAD can't. And documenting what a guarantee doesn't cover is as important as what it does, because a written limit gets reviewed and an implicit limit becomes a surprise.
