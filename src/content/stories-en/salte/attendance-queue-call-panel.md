---
title: "Attendance queue and call panel: unique ticket numbers, legal priority and a TV with no login"
summary: "A front desk needs ticket numbers that never repeat within a day, legally mandated priority respected and a waiting room TV that calls the patient without exposing who they are. I designed numbering with a per-day, per-prefix lock, ordering by priority and then arrival, and a public panel behind a secret link that announces each call exactly once."
project: salte
order: 4
tags: [ERP, PostgreSQL, Concurrency, TanStack Query, Privacy, Front desk]
---

Monday, eight in the morning, packed front desk. Two receptionists check patients in at the same time. A 78-year-old woman arrives after a young man, but she has legal priority. The doctor calls the next person, and the waiting room TV plays a chime and speaks the name and the room. The patient doesn't show up, so the doctor calls again. To anyone in the room it all looks trivial. Behind it, every step has a rule that can't fail in front of twenty people.

## The problem

Salte's attendance queue follows the patient through stages: cashier, triage and consultation. Each stage is a queue entry with a state (waiting, called, in service, done or cancelled), and the next stage inherits the same ticket number (in Brazil, a "senha", the number printed on the ticket).

The module had four requirements: ticket numbers that never repeat within a day, even with simultaneous check-ins; an order that respects legal priority without scrambling everyone else's arrival; a way to undo and redo a check-in without the patient losing their place; and a call panel on a TV that has no logged-in user, can't show sensitive data and has to announce each call exactly once.

## Why it wasn't trivial

A sequential ticket number is the classic race: two transactions read the highest number, add one and write the same value. "Day" isn't obvious either: it's the clinic's day, in the clinic's timezone, not the server's UTC day.

The TV is a public device. Anyone in the room can see the screen and, if the address leaks, open it from outside. It can't log in, it gets switched on and off without warning, and it loses the network and comes back. And if, on startup, it announced every call from the morning, the whole room would hear a list of names.

## The solution

### Ticket number per clinic, day and prefix, with a lock

The ticket has a prefix (A for a scheduled appointment with check-in, S for a walk-in ticket for someone who arrived without booking) and a three-digit number. The counter is per clinic, clinic day and prefix, and the day is computed in the clinic's configured timezone and stored as a plain date, so no timezone travels with it.

Generation takes a Postgres transaction lock (an advisory lock keyed by clinic, day and prefix) before reading the highest number and adding one. Two receptionists in the same second wait for each other and get consecutive numbers. A unique index over the same fields is the safety net: if anything slips through, the transaction fails with a conflict instead of writing a duplicate ticket.

Another index guarantees a single open entry per appointment and stage, and the "already checked in?" check is repeated after taking the lock. Two simultaneous clicks on check-in return the same ticket.

### Legal priority first, then arrival

Queue priority has three levels: normal, priority and urgent. It's separate from the legal reason (elderly, pregnant, person with a disability, autism, reduced mobility, nursing mother, child in arms), which is stored alongside for the record. At check-in, any legal reason becomes priority; urgent can only be set explicitly, on a walk-in ticket.

The order comes from a column generated in the database with the priority weight, and the queue sorts by weight descending, then arrival time, then id. An index covers exactly that order. The one who calls is always a person, picking from the list; the system never calls on its own.

### Undo without losing your place

Undoing a check-in cancels the entry with its own reason. Checking in again recovers the same entry: same ticket number and same original arrival time, hence the same place in the queue. Recalling someone increments the call counter in the SQL itself, so two simultaneous calls can't lose one.

### A TV with a secret link, no login

A manager creates a TV link in the settings, with a scope (front desk, consultation or everything) and, optionally, tied to one room. The link carries a token of 32 random bytes. The database stores the hash, to look the token up, and an encrypted copy, so the manager can see the link again. Revoking marks the link; a nonexistent, malformed or revoked token all get the same 404.

The public route builds the response field by field: ticket number, display name, room, type and call count. The name is shortened on every read: first name plus the initial of the last surname, skipping "da", "de", "dos" and the like. The feed carries only calls from the clinic's day, within the scope, one row per ticket, at most five.

### Periodic polling, announce once

The TV asks the server every five seconds. For a panel that shows five rows, that's simpler and more robust than keeping a socket open on a device that gets switched on and off, and five seconds is a delay nobody in the room notices.

The announcement is decided in the TV's browser. The first response after startup is treated as history and plays nothing. A call is announced when its id is new or when its call count went up, which covers the recall; calls that arrive during an announcement wait in line. The announcement plays three notes and speaks in Portuguese, a bit slower than normal, because the room has a lot of elderly people. With no new data for 60 seconds, the screen shows it's offline and for how long, with call ages computed from the server's time. If the browser blocks audio, the TV asks for a tap on the screen.

A daily job closes entries left open on previous days, with a one-day grace period for anyone still in service.

## An example

A fictional morning, São Paulo timezone:

| Time | Event | Queue (in order) | TV |
| --- | --- | --- | --- |
| 08:02 | Carlos checks in, no priority | A001 | nothing |
| 08:05 | Maria, 78, checks in | A002 (priority), A001 | nothing |
| 08:06 | Rafael arrives without an appointment | A002, A001, S001 | nothing |
| 08:10 | Doctor calls A002 to Room 3 | A001, S001 | "Senha A002. Paciente Maria L., dirija-se ao Consultório 3" (ticket A002, patient Maria L., please go to Room 3) |
| 08:13 | Maria doesn't show; doctor calls again | A001, S001 | announces again, on the same row |
| 08:20 | Two receptionists check in together | ... A003, A004 | nothing |

The announcement decision, simplified:

```ts
type Call = { id: string; recallCount: number };

function callsToAnnounce(feed: Call[], seen: Map<string, number>, firstLoad: boolean): Call[] {
  const fresh = feed.filter((call) => (seen.get(call.id) ?? -1) < call.recallCount);
  for (const call of feed) seen.set(call.id, call.recallCount);
  // on startup, what's already on screen is history: nobody wants to hear the whole morning
  return firstLoad ? [] : fresh;
}
```

## Result

Ticket numbers never repeat within a day, even with simultaneous check-ins, and the database rejects whatever the lock lets through. Legal priority is respected predictably, and undoing a check-in doesn't push anyone out of their place. The TV works with a link that can be revoked, shows only what a person needs to recognize themselves and announces each call once, even after the network drops or the TV gets unplugged.

## What I take from it

Sequential numbering is a concurrency problem before it's a formatting problem. A public device needs the minimum of data and a revocable credential, not a session. And not all real time needs a socket: when the screen is small and a few seconds of delay is acceptable, polling and deciding on the client what's new is simpler and harder to break.
