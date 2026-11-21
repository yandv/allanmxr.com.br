---
title: One trip to Redis instead of four, with pipelining and a pool
summary: "At peak times, every room state change takes several Redis commands, and with few connections tasks would queue up. I batched the write and the notification into a single trip and sized the connections to the real volume."
project: saintmc
order: 4
tags: [Redis, Jedis, Pipeline, Connection pool, Java]
---

End of a match in several rooms at the same time. Each one announces the winner, switches phase, draws the next map, sends the players back to the lobby. Each of those steps touches Redis: it writes the room's state, updates the player list, notifies the proxy. In that minute, dozens of asynchronous tasks want to talk to Redis at once, and each one asks several questions in sequence, waiting for the answer to each before asking the next.

## The problem

On SaintMC, Redis was the network's meeting point. The server registry, match state, players joining and leaving, the account cache and notifications between processes via Pub/Sub all went through it. A single room state update was, in practice, three or four commands: write the phase, write the map, write the remaining time and publish the notification to the proxy.

Written the naive way, each command would be a full round trip: send, wait for the reply, send the next one. Multiply that by all the rooms and by every player event, and the time spent waiting for replies grows fast, precisely in the busiest moments.

## Why it wasn't trivial

Almost all of the cost of a simple Redis command is the trip, not the processing. Redis answers an `HSET` in microseconds. What weighs is the cycle of sending, waiting for the packet to come back and only then sending the next one, plus the system calls on each side. Even with Redis on the same machine, this accumulates when you're counting thousands of commands.

The second problem was concurrency. Moving all I/O off the game's main thread has a consequence the design had to absorb: several asynchronous threads ask for a connection at the same time. A Jedis connection can't be shared between threads, so each one needs its own. With few connections available, tasks would queue up exactly at the peaks, and the queue would turn into delay everywhere: in the notification to the proxy, in the account update, in the player registration.

And there was the Pub/Sub subscription, which occupies an entire connection while active and can't be used for anything else.

## The solution

### Pipeline: send everything and wait once

Jedis, the Redis client I used in Java, lets you open a pipeline: I queue several commands on the client, send them all at once and read the replies at the end. For the Redis server nothing changes, it executes the commands in the order they arrived. For me, four waits become one.

The detail that matters is the order. Since the Pub/Sub notification goes at the end of the same pipeline, whoever receives the notification and rushes to read the hash already finds the new values written. There is no window in which the proxy is notified of a change that isn't yet in Redis.

I applied the same pattern everywhere there was a "write and notify": server registration on startup, players joining and leaving, whitelist changes, account field updates, report publishing.

### A pool sized for the concurrency model

Connections come from a `JedisPool` with up to 128 connections. Each asynchronous task grabs a connection in a `try-with-resources`, uses it for a few milliseconds and returns it. Since operations are short and the number of simultaneous threads at peaks is high, a generous ceiling keeps anyone from waiting for a free connection. An idle connection in the pool costs little memory, and a missing connection costs cascading latency.

### Subscription on a dedicated connection

The Pub/Sub listener runs in its own asynchronous task, which grabs a connection and keeps it. If the subscription drops due to an error, the code cancels and subscribes again, instead of leaving the process deaf to network notifications without anyone noticing.

## An example

A simplified version of a room state update:

```java
void publishMatchState(String serverId, MatchState state) {
    String key = "server:" + serverId;
    try (Jedis redis = pool.getResource()) {
        Pipeline pipe = redis.pipelined();
        pipe.hset(key, "phase", state.phase().name());
        pipe.hset(key, "map", state.mapName());
        pipe.hset(key, "secondsLeft", String.valueOf(state.secondsLeft()));
        // the notification goes last: whoever receives it already finds the updated hash
        pipe.publish("server-updates", serverId + ":UPDATE");
        pipe.sync();
    }
}
```

The difference on a timeline, with illustrative times for a 0.3 ms trip:

| Without pipeline | With pipeline |
| --- | --- |
| t=0.0 ms sends `HSET phase` and waits | t=0.0 ms sends the four commands |
| t=0.3 ms reply, sends `HSET map` and waits | t=0.3 ms the four replies arrive |
| t=0.6 ms reply, sends `HSET secondsLeft` and waits | connection goes back to the pool |
| t=0.9 ms reply, sends `PUBLISH` and waits | |
| t=1.2 ms reply, connection goes back to the pool | |

One millisecond looks like little, until you multiply it by every event of every room at a simultaneous end of match. And the gain that matters most isn't the time of one task, it's the time the connection stays held. With pipelining, each task returns the connection to the pool four times faster, which reduces contention for connections precisely at the peak.

## Result

Each "write the state and notify the network" pair started costing one round trip instead of several, with an ordering guarantee between the write and the notification. With the pool sized for the asynchronous threads, I/O tasks didn't queue up waiting for connections at peaks. I didn't keep before-and-after measurements, so I don't cite production gains in milliseconds. What I can state is the mechanism and the guaranteed order.

## What I take from it

When a state needs to be written and announced, both go in the same batch, with the announcement last. That solves performance and consistency at the same time. And a connection pool should be sized from how many threads actually ask for a connection at the same time, not from a default number copied from the documentation. Today, with other tools, I follow the same principle: group what goes to the same destination and never let a shared resource become the system's hidden queue.
