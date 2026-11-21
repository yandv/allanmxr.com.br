---
title: "Integrating mTLS with the tax authority from a Worker: four layers to the first response"
summary: "On the first real issuance against the tax authority, still during integration, the response came back empty, with no error message and a green suite. I solved one layer at a time, from the certificate to the platform, until the invoice went out, and made the tests exercise the same code that runs in the egress container."
project: araute
order: 8
tags: [mTLS, TLS, Cloudflare Workers, Containers, NFS-e]
---

The fiscal integration was written, reviewed, and the suite was green. What was left was the step no local test replaces: issuing the first real invoice against the issuing authority's environment, before any merchant used issuing. The response came back empty. No useful status, no body, no error message. Just an "http 0" in the log, which is the transport's way of saying the connection ended before any response. There was nothing to read, not even a code to search for.

## The problem

To issue an NFS-e (Brazilian electronic service invoice), Araute has to open an mTLS connection to the issuing authority. mTLS is TLS where the client also presents a certificate. Here, that certificate is the merchant's A1, the file-based digital certificate issued within ICP-Brasil, the country's official public key infrastructure. Without it, the server won't accept the invoice.

The API runs on Cloudflare Workers, and the connection left from inside the Worker. That outbound call was where everything died.

## Why it wasn't trivial

"Empty response" is the worst possible symptom, because it's the sum of anything that can go wrong before the first byte. And here there were several stacked causes. Fixing one didn't change the symptom, it only revealed the next.

On top of that, the tests proved something else. The suite ran on Node, where the client certificate is actually presented. Once deployed, the code ran on the Worker runtime, which behaves differently. Green on Node said nothing about the Worker.

## The solution

### 1. Full chain, in the right order

The first layer was simple. The first version presented only the leaf certificate, the merchant's. An A1 is issued by an intermediate authority, and the server isn't obliged to know it. Without the intermediate, it can't validate the client and silently closes the connection.

I started sending the whole chain. With one catch: the certificate file carries the certificates in arbitrary order, with the root in the middle. TLS expects the leaf first, then whoever issued it, and so on. The root is left out, because the server already has it.

### 2. TLS 1.2

The response was still empty. I instrumented the secure-connect callback and the log showed two strange things: protocol and cipher unavailable, and the end of the connection arriving in the same millisecond as the send. In other words, there was never a TLS session.

I reproduced it from outside with `openssl`. Forcing TLS 1.3, the connection died with no cipher negotiated. On 1.2, it connected. The server advertises 1.3 but doesn't complete the handshake on it, and the runtime prefers 1.3. I capped the maximum version at 1.2.

### 3. Close the write side

Still empty. The request went out with `Connection: close`, and in that mode the server only knows the request is over when the client closes the socket's write side. The code wrote the body and did not yet call `end()`. The server kept waiting for more data and dropped the connection on its own timeout.

The proof came again through `openssl`, which closes the write side when it finishes. The same certificate got 405 on GET and 400 on POST, real responses. Through the integration code, silence.

The most annoying part: the fake server in the tests answered as soon as it read the end of the headers, so it would never have caught the missing `end()`. I rewrote the fake to answer only after the end of the request and to fail by timeout if `end()` is missing.

### 4. The runtime that ignored the certificate

With the three fixes in, the response was still empty. That's when I found the root cause. The Worker runtime's `node:tls` accepts the `key` and `cert` options without error and simply doesn't use them. The methods that should confirm the handshake, like the ones reporting the protocol and whether the connection was authorized, don't reflect what actually happened.

And there was a second blocker. The authority's server only asks for the client certificate through TLS renegotiation, triggered after the initial handshake, depending on the URL path. Cloudflare's TLS stack doesn't renegotiate. The platform's native mTLS certificate feature doesn't help either, because it only presents the certificate in the initial handshake.

Before concluding anything, I measured. I made the same request through three paths inside the same deployed Worker, and only one of them returned a complete response: a Node container.

## An example

The side-by-side measurement is what ended the discussion. The same request, to the same path that requires renegotiation:

| Outbound path | What came back |
| --- | --- |
| Worker raw socket | 0 bytes, connection closed |
| Worker `fetch()` | 520, generic origin error |
| Node container | Full 403, with a body |

A full 403 looks worse than a 520, but it's the opposite. The status itself didn't matter in that measurement: what mattered was that there was a TLS session, a renegotiation and a real response from the server. It was the only path able to talk to it.

The transport inside the container ended up small. The core idea fits here:

```ts
import { request } from 'node:https'

function sendWithClientCert(req: EgressRequest): Promise<EgressResponse> {
  if (!ALLOWED_HOSTS.includes(req.host)) throw new Error('host not allowed')

  return new Promise((resolve, reject) => {
    const out = request(
      {
        host: req.host,
        path: req.path,
        method: req.method,
        key: req.keyPem,        // arrives in memory, per request, never on disk
        cert: req.chainPem,     // leaf first, root left out
        timeout: req.timeoutMs,
      },
      (res) => collectBody(res).then(resolve, reject),
    )
    out.on('error', reject)
    if (req.body) out.write(req.body)
    out.end() // with Connection: close, without this the server waits forever
  })
}
```

The container has no public port or route. Only the custody Worker talks to it, through a Durable Object, the object with a unique identity that Cloudflare uses to coordinate state and, here, to address the container. It keeps its own allowed-hosts list, independent from the one the Worker already enforces, and a test fails if the two diverge.

## Result

The first invoice went out, and the test harness now exercises exactly the same outbound function that runs inside the container image. The test stopped proving something else.

There were costs. The container has a cold start of tens of seconds, so the timeout for fiscal calls now includes that margin, otherwise the reconciliation lookup would never even go out. And the custody's security guarantee changed shape: before it was "the key never leaves the isolate", now it's "the key never leaves the custody's deployment unit". I wrote down the new guarantee instead of pretending the old one still held.

A rule also came out of it: a transport change is only accepted after being measured on a deployed Worker. The local development environment proxies sockets and doesn't count as evidence.

## What I take from it

A green test on a runtime different from the one the code will run on is not evidence. When the symptom is an empty response, instrumenting what exists and what should exist is worth more than guessing: it was the absence of a TLS session in the log that pointed the way. And when the platform is a suspect, a side-by-side measurement in the real environment settles it faster than any reading of the documentation.
