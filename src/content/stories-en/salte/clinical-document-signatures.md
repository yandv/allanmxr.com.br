---
title: Electronic signatures for clinical documents that an expert can verify
summary: "A consent form signed through a link is only worth something if, years later, someone can prove who signed and that the file didn't change. I built two signature tracks, with an evidence dossier that any expert can check by recomputing a hash."
project: salte
order: 9
tags: [Electronic signature, ICP-Brasil, PDF, SHA-256, Cloudflare R2, Law 14.063]
---

A patient is about to start a treatment and the clinic needs the signed consent form. She isn't at the front desk. The receptionist uploads the PDF, the patient receives an email link, types a code that arrived on her phone and signs from her couch at home. The same day, the doctor signs the prescription with his digital certificate. Both documents look settled. The question that guided me was a different one: if three years from now someone challenges that signature, what does the clinic have to show?

## The problem

Salte is an ERP for clinics, and clinical documents flow through it all the time: consent forms, medical certificates, prescriptions, reports. A "sign" button that just writes a "yes" to the database proves nothing. When challenged, the clinic has to demonstrate three things: who signed, how that person was identified, and that the signed file is exactly the file they saw.

On top of that, not all signatures are equal. Law 14.063/2020 (the Brazilian law on electronic signatures) separates the advanced electronic signature, which requires an unambiguous link to the signer and exclusive control of the signing means, from the qualified signature, made with an ICP-Brasil certificate (ICP-Brasil is Brazil's official public key infrastructure). A doctor's prescription and a consent form signed by the patient call for different paths.

## Why it wasn't trivial

The first obstacle is that the patient has no account in the system. The link she receives is her only credential, so it can't be guessable or enough on its own to sign.

The second is integrity. If I "stamp" the signature inside the PDF itself, I change the file's bytes, and the original's hash stops matching. I need a readable final copy that doesn't destroy the proof of the original.

The third is the environment. The API runs on Cloudflare Workers, with no filesystem and a memory limit. Generating PDFs there takes care with fonts and with characters the default font can't draw: an exotic accent in the signer's name can't bring the seal down with a 500 error.

## The solution

### Two tracks, one per signature type

Each signer has a type. The electronic one signs through the public portal, with code verification. The qualified one signs with a cloud ICP-Brasil certificate, through a signing provider: authorization uses OAuth with PKCE (an OAuth extension that prevents an intercepted authorization code from being redeemed by someone else) and the result is a signed PDF in the PAdES standard.

The signer also carries the form of representation: themselves, legal guardian, attorney or curator. This goes into the dossier, because "who signed" and "on whose behalf" are different questions.

### The link isn't enough, the code decides

The link token is 32 random bytes, the same level of entropy as a session id. The link is valid for 30 days. Opening the link signs nothing: the signer requests a code, which arrives by email or SMS and is valid for five minutes. That short-lived code is what meets the exclusive control requirement of the advanced signature. For in-person service, there's a third verification method.

If the token needs to be replaced, the signer keeps a stable 16-byte recovery reference. It serves to find the signature request, not to sign. The code that gets sent is still the gate.

### Hash the original before storing it

When the PDF arrives, I check the first bytes (`%PDF-`) before any write, because the content type header sent by the client can't be trusted. Then I compute the file's SHA-256 and only then store the original in R2, Cloudflare's object storage. That hash is the anchor of all the proof. The original is never rewritten.

### An event trail that only grows

Each step becomes an event with a timestamp and IP: created, sent, viewed, code sent, wrong code, code verified, signed, completed, declined, expired, canceled, consent revoked. Events are never edited. They form the history that the dossier prints.

### The seal: the original plus a manifest page

When everyone has signed, I generate the sealed copy: the original with a manifest page appended at the end. The manifest lists the original's SHA-256, each signer's identity, the verification method, IP, timestamps and the full event trail. Integrity doesn't depend on trusting the manifest. You just recompute the hash of the stored original and compare it with the printed value.

The seal is generated only once. The sealed file's key has a unique index, so two simultaneous completions don't produce two different copies. To run inside the Worker, the manifest uses only the standard Helvetica font, and every character outside its encoding is replaced before drawing.

### What's prepared, not faked

A trusted timestamp (RFC 3161, a standard where an authority attests the instant a hash existed) only carries real legal weight when it comes from an authority accredited by ICP-Brasil. I left an interface ready to plug that authority in without touching the seal flow, but it does nothing until the contract exists. I preferred not to use some free timestamp, which would give the look of proof without its weight.

## An example

A made-up timeline for a consent form with one signer:

| Time | Event | What gets recorded |
| --- | --- | --- |
| 09:02 | Front desk uploads the 180 KB PDF | Hash `3f9a…c41e` computed, original stored |
| 09:02 | Request created and sent | Link with a fresh token, valid for 30 days |
| 19:40 | Patient opens the link on her phone | Viewed, with IP and device |
| 19:41 | Requests the code by SMS | Code sent, expires at 19:46 |
| 19:43 | Types one wrong digit | Wrong code |
| 19:44 | Types the right code | Code verified |
| 19:44 | Signs | Signed, completed, sealed copy generated |

Years later, the check is mechanical:

```ts
async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// the manifest prints the hash; the original stays intact in storage
async function originalIsIntact(original: ArrayBuffer, hashOnManifest: string) {
  return (await sha256Hex(original)) === hashOnManifest;
}
```

If someone had changed a single comma in the form after signing, the recomputed hash would be different, and the event trail would show exactly when and from where each step happened.

## Result

The clinic started signing documents without paper, with the patient at home or the doctor in the office, and each signature comes with a dossier that explains itself. Access control follows: prescriptions and certificates can only be read by whoever created them or by someone with permission to see other professionals' records. PDFs of canceled signatures are deleted after seven days, and anyone who tries to open them gets a 410, which says "it existed and was removed" rather than "it never existed".

## What I take from it

Proof isn't a boolean field, it's a story that someone else can reconstruct without trusting me. Keeping the original intact, anchoring everything in a hash and recording events that only grow costs little on the day you write the code and is worth a lot on the day someone asks. And when a piece doesn't really exist yet, like the accredited timestamp, I leave the slot ready instead of pretending it's there.
