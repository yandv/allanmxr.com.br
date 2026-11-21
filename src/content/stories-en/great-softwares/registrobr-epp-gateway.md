---
title: An HTTP gateway to speak EPP with Registro.br without losing the session
summary: "Registro.br only talks over one long session with a single login, and the Great Domains API runs on functions that live for seconds. I wrote a gateway that holds that session and lets the rest of the system talk to it over plain HTTP."
project: great-softwares
order: 18
tags: [EPP, Registro.br, TypeScript, TLS, Node.js]
---

A customer types `minhaloja.com.br` into the Great Domains search and wants to know, in under a second, whether the domain is available. The API that answers runs on Cloudflare Workers, which speak HTTP and live for a few seconds. On the other side is Registro.br (the .br registry), which has no REST API. It speaks EPP, a session protocol that requires an open connection, a client certificate and a login. The two worlds didn't fit together, and I needed a piece in the middle.

## The problem

EPP (Extensible Provisioning Protocol, RFC 5730) is the protocol domain registries use to receive requests from registrars. Each message is XML preceded by a 4-byte binary header with the total size. Everything travels over a TCP connection with mutual TLS, in which the client also presents a certificate. Registro.br adds its own extensions for `.br`, such as `brdomain` and `brorg`, which carry the holder's CPF or CNPJ (Brazilian individual and company registry numbers) and the registration tickets.

A Worker can't hold that connection. It's born in a request, responds and dies. Opening TLS, logging in and sending one command per search would be slow and, worse, aggressive toward the credential.

## Why it wasn't trivial

EPP is a session protocol. The connection stays open, the login happens once and the commands go back and forth in order, one at a time. Under Registro.br's policy, repeating the login on a connection that's already logged in brings the session down. So the code needs to know exactly what state it's in: connecting, ready, or draining to close.

The password is also delicate. A process looping on login with a wrong password hammers the registry and puts the company's credential at risk. I didn't want to find out their tolerance limit in production.

And EPP responses are not very useful on their own. Code `2306` only says "policy error". The real cause, such as an invalid holder document or an organization linked to another provider, comes in an extension field (`extValue`) that many implementations ignore.

## The solution

I wrote a small Node.js service that exposes EPP commands as simple HTTP resources: check availability, create contact, register, renew, read the next message from the registry's queue. It listens only on loopback (`127.0.0.1`), on the same machine as the fixed-IP relay, and is never exposed to the internet.

### One session per process

A session class opens the connection at startup, reads the server's greeting (the welcome message that lists the supported extensions) and maintains a keepalive: if the connection goes idle, it sends a `hello`. If the connection drops, it reconnects with exponential backoff starting at 1 second and with a cap.

Login is lazy. It only happens on the first request that needs it and again after a reconnect. While the session is logged in, the code simply has no path to log in again.

### A login budget

A small class counts consecutive authentication failures (code `2200` in EPP). On the third, it blocks new attempts and the gateway starts responding `503` without touching the registry, until someone looks. Each reconnect allows at most one login attempt.

The password doesn't come from an environment variable. Only the path to a file with restricted permissions does, and the file is re-read on each attempt. That way the password can be rotated without restarting the process.

### FIFO queue with a ceiling

All commands enter a queue that runs one at a time, in order of arrival. The queue has a maximum depth and a maximum wait time. If the session isn't ready or login is blocked, the request fails immediately with `503`, instead of piling up and blowing everything up when the connection comes back.

### Business responses are always 200

I separated transport failure from business response. Invalid body, unavailable session and timeout become 4xx or 5xx. Everything the registry answered becomes `200` with an envelope of four shapes: `ok`, `ticket` (the registry accepted, but the domain is pending review), `notFound` or `failed`. Every response carries the raw EPP code and the client and server transaction identifiers (`clTRID` and `svTRID`), which is what the registry's support asks for when something goes wrong. On failures, the envelope carries the reasons read from `extValue`.

### Refusing what the protocol doesn't have

Registro.br's EPP doesn't define a command to cancel a pending ticket, nor to discover a domain's ticket by name. Instead of faking success or guessing a command, the cancel route responds with an explicit error without going to the registry, and I wrote down why. The caller decides what to do with the ticket.

## An example

The core of the protocol is the framing. Each message has 4 bytes with the total size, counting the header itself, and a TCP read can bring half a message or two at once:

```ts
const HEADER_BYTES = 4;

function encodeFrame(xml: string): Buffer {
  const body = Buffer.from(xml, "utf8");
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32BE(HEADER_BYTES + body.length, 0);
  return Buffer.concat([header, body]);
}

class FrameDecoder {
  private pending = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    this.pending = Buffer.concat([this.pending, chunk]);
    const frames: Buffer[] = [];
    while (this.pending.length >= HEADER_BYTES) {
      const total = this.pending.readUInt32BE(0);
      // TCP may deliver half a frame; wait for the rest instead of parsing garbage.
      if (this.pending.length < total) break;
      frames.push(this.pending.subarray(HEADER_BYTES, total));
      this.pending = this.pending.subarray(total);
    }
    return frames;
  }
}
```

And what the caller sees, for a `.br` registration with the wrong holder CNPJ:

```json
{
  "outcome": "failed",
  "code": "EPP_2306",
  "eppResult": 2306,
  "message": "Parameter value policy error",
  "reasons": ["Documento do titular inválido"],
  "clTrid": "gdm-a91c-0042",
  "svTrid": "BR-7731905"
}
```

Without the `reasons` field, the dashboard could only say "policy error". With it, the screen tells the customer what to fix.

## Result

The rest of the system registers and queries `.br` with ordinary HTTP calls, without knowing there's a TLS session behind it. The credential is protected against duplicate login, against wrong-password loops and against bursts. I validated against Registro.br's beta environment with an integration test that does a real login and runs `domain:check`, without spending real documents or domains in a shared environment.

## What I take from it

A session protocol deserves an adapter with explicit state, not loose calls scattered through the code. Protecting the credential is part of the design, not an operational detail. And when the protocol doesn't offer a command, the honest answer is to refuse clearly, not to simulate a success that will turn into a problem weeks later.
