---
title: Filling one room before opening another, without an orchestrator
summary: "Spreading players evenly across rooms would leave all of them below the minimum, and the match would never start. I made each room register itself and the proxy fill one before opening another, with no hand-maintained server list."
project: saintmc
order: 3
tags: [Redis, Pub/Sub, Load balancing, Service discovery, BungeeCord]
---

Forty players click "Hardcore Games" in the lobby almost at the same time. If the proxy spreads that crowd evenly across four rooms, each one ends up with ten people, none reaches the minimum to start and everyone stares at a stuck counter. In two minutes half of them give up and go back to the lobby. What the player wants is the opposite: one room filling up fast and the match starting.

## The problem

The network had lobbies, a login server and several match rooms, each one a separate Java process. Rooms came up when I needed more capacity and went down for maintenance or updates. The BungeeCord proxy, which receives all connections and decides which server the player lands on, needed to know at every instant:

- which servers exist and what type they are;
- how many players each one has and how many fit;
- what phase the match is in and whether it still accepts people.

With that, it had to decide where to send each player without me editing a configuration file for every new room.

## Why it wasn't trivial

There was no orchestrator and no ready-made service discovery. It was a dedicated machine, administered by hand, with processes that I started myself. The server list had to build itself.

And the selection rule couldn't be a single one. Spreading players is great in a lobby, where the goal is to split the load. Spreading players across match rooms is terrible, for the reason in the scene above. A generic "fewest connections" balancer would solve one case and break the other.

## The solution

### Each server introduces itself

On startup, the server writes a hash to Redis with its data (type, slots, whether it accepts entry, address) and adds its own id to the set of its type. In the same network trip, it clears the data from the previous run and tells the network it was born. A proxy that comes up later reads this state straight from Redis, so it doesn't depend on having heard old messages.

### Changes travel by Pub/Sub

A Redis Pub/Sub channel carries typed events: server started, stopped, player joined, player left, entry opened, and match updates (phase, map, time remaining). The proxy subscribes to the channel and keeps an in-memory map of active servers. When a room stops, the stop event removes it from the list immediately.

### A selection strategy per room type

The proxy associates a balancer with each server type:

- **Lowest occupancy** for lobbies and login, where the goal is to split the load.
- **Highest occupancy** for match rooms, to fill one before opening another.
- **Round robin** available for cases where even distribution matters more than occupancy.

All of them respect the same question asked of the server: "can you be chosen right now?". A full room says no. A Hardcore Games room with a match in progress says no. And a room in the countdown only says yes while there are at least 15 seconds left to start, so nobody lands in a match that will begin before the world loads.

The rest of the proxy just asks for "the next server of this type". The go-to-lobby command, reconnection after a drop and the join-a-match button all use the same entry point.

## An example

A simplified version of the highest-occupancy strategy and the room's eligibility rule:

```java
class MostPlayers<T extends GameServer> implements Balancer<T> {
    public T next(Collection<T> servers) {
        T best = null;
        for (T server : servers) {
            if (!server.canBeSelected()) continue;
            if (best == null || server.online() > best.online()) best = server;
        }
        return best; // null: no room available, the proxy tells the player
    }
}

class MatchServer extends GameServer {
    @Override
    boolean canBeSelected() {
        if (isFull() || state == State.IN_PROGRESS) return false;
        // during the countdown, only accept if there's still time to load
        return state == State.WAITING
            || (state == State.COUNTDOWN && secondsToStart >= 15);
    }
}
```

And the proxy's decision for five players arriving in sequence, with made-up values:

| Player | Room A | Room B | Room C | Choice | Reason |
| --- | --- | --- | --- | --- | --- |
| 1 | 18/24, waiting | 6/24, waiting | in progress | A | fullest eligible |
| 2 | 19/24 | 6/24 | in progress | A | fullest eligible |
| 3 | 20/24, countdown 40 s | 6/24 | in progress | A | still 40 s left |
| 4 | 21/24, countdown 12 s | 6/24 | in progress | B | A starts in under 15 s |
| 5 | 21/24, countdown 9 s | 7/24 | in progress | B | B is now the fullest |

Room C never appears as an option because the match has already started. Room B, which was nearly empty, only starts receiving people when A stops being eligible. In a lobby, the same sequence would give the opposite result: each player would go to the emptiest server.

## Result

Bringing up a new room became just starting the process. It registered itself, the proxy started considering it and players started arriving. Shutting down a room was emitting the stop event. There was no hand-maintained server list on the proxy, and I could bring rooms up or down in the middle of the day without restarting anything in front.

On the player's side, matches started faster because the queue was concentrated, and nobody landed in a room already in progress or about to start without time to load.

## What I take from it

The selection policy is a product decision, not an infrastructure one. "Where to send the player" depends on what they're going to do there. Separating the strategy from the candidate list cost a few lines and let me change the behavior of one game mode without touching the others. And putting the eligibility rule in the server itself, which knows the match phase, was simpler than teaching the proxy about every mode. It's the same reasoning I apply today when designing queues, routing or work distribution: the right question comes before the algorithm.
