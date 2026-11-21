---
title: "Mobile app session on a flaky network: renew only when the server asks"
summary: "In Salte's Expo app, the real-time channel drops and comes back all the time on a phone, and the session uses a rotating refresh token, which does not forgive an interrupted renewal. I designed the app to renew only when the server says the session expired and to treat everything else as network."
project: salte
order: 14
tags: [Expo, React Native, WebSocket, Authentication, Mobile]
---

A doctor uses the Salte app on her phone between appointments. She leaves the clinic's Wi-Fi, 4G is slow to kick in inside the elevator, and the app's real-time channel drops and comes back a few times within minutes. None of that should touch her session: the password is right, the token has not expired, nobody logged out. On a phone, a flickering network is the normal state, and the app had to be designed for it.

## The problem

Salte's mobile app is built with Expo, on top of React Native, and talks to the same API as the web front end. The session uses two tokens: a short-lived access token and a rotating refresh token. On each renewal, the server issues a new pair and invalidates the previous refresh. It is a secure design, but it requires every renewal to reach the client intact: if the server completes the rotation and the response is lost, the app is left with a refresh that is no longer valid.

The app has a real-time channel over WebSocket, falling back to SSE (server-sent events over HTTP) when the socket cannot hold. The first version of reconnection renewed the session as a precaution on the first retry after every drop, and account loading and clinic switching treated any 401 as a terminated session. In tests with a degraded network, the cost of that precaution became clear: every drop turned into a token rotation, and every rotation done on a bad network was a chance to lose the response midway.

## Why it wasn't trivial

React Native's WebSocket does not expose the HTTP status of an open that failed. To the app, "the network dropped", "the server is restarting", and "your session expired" all look the same: the socket did not open. Without telling the cases apart, renewing as a precaution looks like the only safe option, which is why the first version did it that way.

The 401 is not a single thing either. It can mean an expired access token, which is fixed by renewing, or a refusal that has nothing to do with the session, such as lacking permission in that clinic. Ending the session in the second case throws the person back to sign-in over a problem that signing in does not solve.

And the renewal timeout has to account for the server possibly completing the rotation while the client waits. With the timeout of an ordinary read, on a slow network, the app would give up too early.

## The solution

### Ask the route instead of guessing

On the first retry after each drop, instead of renewing the session, the app probes the same socket route over plain HTTP. Without the upgrade header, the route answers in a way that says exactly what is going on:

- **426** (the server expects an upgrade): the session is fine, it was just the network. The socket reopens without renewing anything.
- **Renewable 401**: the error body carries a detail saying "session expired". The HTTP client renews and repeats the call by itself, and the socket reopens.
- **Session ended for good**: the app stops trying and takes the person to sign-in.
- **503**: the real-time service is unavailable, and the app goes straight to SSE.
- Any other error, including no network, reopens the socket at the next interval, without renewing.

The probe happens once per drop. The interval between attempts doubles from 2 seconds up to 60, with 20% random jitter up or down, so that many devices do not all come back at the same instant. On the third consecutive failure, the app uses SSE for ten minutes and goes back to probing the socket alongside it.

### Only an expired session ends the session

Account loading and clinic switching end the session only when the HTTP layer says it is over for good. A 401 that is not an expired session keeps the person signed in, marks the failure, and shows "Couldn't load your permissions for this clinic. Try again." When the session really ends, the app explains: "Your session expired. Sign in again."

### A renewal cannot be abandoned midway

The renewal timeout is that of a write, longer than that of a read. Aborting a renewal the server is still completing loses the rotation and revokes the session.

On the server side, a short tolerance covers the lost response: if the same refresh comes back within 30 seconds, from the same application (the same user agent) and while the new pair has not yet been used, the API answers again instead of refusing. At most one repeat per rotation.

## An example

The same afternoon, with the first version and with the final design, in illustrative values:

```text
14:02:10  socket drops (elevator)
          first version: retry in 2 s with session renewal
          final design: HTTP probe of the socket route
14:02:12  probe answers 426: session fine, socket reopens, no renewal
14:05:40  socket drops again, slow network
          first version: renewal goes out, the app gives up in 10 s, the server completes in 12 s
                 the app keeps the old refresh; next renewal: session revoked
          final design: probe gets no answer, reopens in 2 s, 4 s, 8 s, without renewing
14:06:00  network is back, socket opens
16:30:00  access token expires; the probe gets a 401 with detail "expired"
          HTTP client renews once, repeats, socket opens
```

The classification that decides whether the session is over:

```ts
type Probe = { status: number; detail?: string } | 'network-error';

const RENEWABLE_401_DETAILS = new Set(['Access token expired']);

function nextStep(probe: Probe): 'reopen' | 'renew-then-reopen' | 'sse' | 'sign-in' {
  if (probe === 'network-error') return 'reopen';
  if (probe.status === 426) return 'reopen'; // the session is fine, only the upgrade was missing
  if (probe.status === 401 && probe.detail && RENEWABLE_401_DETAILS.has(probe.detail)) {
    return 'renew-then-reopen';
  }
  if (probe.status === 401) return 'sign-in';
  if (probe.status === 503) return 'sse';
  return 'reopen';
}
```

In the real app, a 401 that is not renewable arrives as "session ended" from the HTTP layer, and the renewable details come from a package shared between the API and the clients, so both sides never read the same text differently.

## Result

A flickering network does not touch the session. The app renews only when the server says it needs to, once per drop, and only sends someone to sign-in when the session has truly ended, explaining why. Each rule became a test: the drop that reopens without renewing, the renewable 401 that renews only once even when repeated, the non-renewable 401 that does not renew, the 5xx that comes back at the interval, and the notice that only appears when it should.

## What I take from it

On a phone, a bad network is the normal state, not the exception. Any action that spends something irreversible, like a token rotation, has to be triggered by an unambiguous signal from the server, never by precaution. When the platform hides the information, as WebSocket hides the status, it is worth asking another way before acting in the dark.
