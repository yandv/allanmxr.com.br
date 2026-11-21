---
title: "A rank granted in the lobby already valid in the match: a three-layer cache"
summary: "If each server on the network kept its own copy of the account, a player promoted in the lobby would reach the match without the rank. I designed a layered cache where any change shows up across the whole network almost instantly."
project: saintmc
order: 2
tags: [Redis, Pub/Sub, MongoDB, Cache, Cache invalidation]
---

Imagine a player who buys VIP in the store: someone on the staff applies the rank from the lobby and he sees the colored tag appear on his name. Happy, he clicks to join a Hardcore Games match. Inside, the tag is gone and the exclusive kit is locked. He goes back to the lobby, and the tag is there. In his head, he paid and the server is broken. All it would take is the match looking at an old copy of the account. That was the scenario the design of the data layer had to make impossible.

## The problem

On SaintMC, the same player went through several Java processes over the course of a session: the BungeeCord proxy in front, a lobby, a match room, another lobby. All of them needed to read his account (rank, coins, punishments, clan, preferences) constantly, to build the tablist, unlock kits and filter the chat.

I had two bad options. If every process went to MongoDB on every read, the database became a bottleneck and each query competed for time with the game. If every process kept its own copy without telling the others, reads were cheap, but a change made in one place never reached the rest. That is exactly the case of the vanishing tag.

## Why it wasn't trivial

Caching is easy, invalidation is not. I needed three guarantees at the same time:

1. **Cheap reads.** Most reads couldn't leave the process.
2. **Changes visible across the network quickly.** Without waiting for the player to reconnect.
3. **Memory under control.** Redis couldn't accumulate forever the account of someone who played once and never came back.

And all of this on a dedicated machine I administered by hand, with no managed cache service, no orchestrator and nobody on call except me.

## The solution

### Three layers, from the cheapest to the most expensive

A read goes through local memory, then Redis, then MongoDB, which is the source of truth. In Redis, the account is a hash (a dictionary of fields inside a key) with one field per attribute. If the hash comes back incomplete, I treat it as missing and let Mongo decide. Reading half an account would be worse than going to the database.

### A TTL that follows the player's presence

While the player is online, their Redis key doesn't expire. When they leave the network, I apply a TTL (time to live, after which Redis deletes the key on its own) of five minutes. If they come back within that window, because they dropped or switched modes, the `PERSIST` command removes the TTL and the account stays warm. If they don't, Redis does the cleanup and I don't need any cleanup routine.

### Invalidation that already carries the answer

Every field change writes to Mongo and publishes a message on a Redis Pub/Sub channel (a mechanism where the publisher doesn't know who's listening, and all subscribers receive the message). The message doesn't just say "the account changed". It carries the player's UUID, the field name, the new value and the id of the originating server. Whoever receives it doesn't need to reread anything from the database: it applies the change directly.

Each process subscribes to this channel and follows three rules. It ignores the message if the origin is itself, because its own change is already applied. It ignores the message if it doesn't have that player loaded, because there's nothing to update. And, on the game server, it fires an internal "field changed" event, so the modules can react (the tablist redraws the tag, the kit menu unlocks the item).

I used the same design for clans and for reports, each with its own channel.

## An example

The code below is simplified and uses generic names. First, whoever makes the change publishes the field and the value:

```java
void updateField(Account account, String field, JsonElement value) {
    repository.setField(account.getId(), field, value); // Mongo, source of truth

    JsonObject msg = new JsonObject();
    msg.addProperty("accountId", account.getId().toString());
    msg.addProperty("field", field);
    msg.add("value", value);
    msg.addProperty("source", serverId);

    try (Jedis redis = pool.getResource()) {
        Pipeline pipe = redis.pipelined();
        pipe.hset("account:" + account.getId(), field, value.toString());
        pipe.publish("account-updates", msg.toString());
        pipe.sync();
    }
}
```

And whoever subscribes applies only what matters:

```java
void onAccountUpdate(JsonObject msg) {
    if (serverId.equals(msg.get("source").getAsString())) {
        return; // echo of our own change
    }
    Account local = online.get(UUID.fromString(msg.get("accountId").getAsString()));
    if (local == null) {
        return; // this server doesn't have the player, nothing to do
    }
    local.apply(msg.get("field").getAsString(), msg.get("value"));
}
```

Now the same VIP scene, with the mechanism working. The times are illustrative:

| Time | Where | What happens |
| --- | --- | --- |
| t=0 ms | Lobby 1 | Staff applies the VIP rank, the local copy changes immediately |
| t=8 ms | Lobby 1 | Mongo receives the field, Redis receives the hash and the message |
| t=9 ms | Lobby 1 | Receives its own message and ignores it because of the origin |
| t=9 ms | Lobby 2 | Doesn't have the player, ignores |
| t=9 ms | Proxy | Has the player, updates the rank |
| t=4 s | HG room 3 | Player joins, reads the account from Redis already with the VIP |

The "only if loaded" detail is what keeps the cost low. Traffic grows with the number of changes, but the work on each server grows only with the players it actually has.

## Result

MongoDB started being queried only when the account was in no layer, which in practice meant each player's first entry of the day. A promotion, a punishment or a clan switch made in any process showed up in the others without an extra database query, at the cost of one small message per change. The tag had no way to vanish on the path between the lobby and the match.

The account of someone who left stayed warm for a few minutes, which made switching modes and reconnecting after a drop cheap, and then disappeared from Redis on its own.

## What I take from it

An invalidation message should carry what changed, not just the notice that something changed. That way nobody rushes to the database at the same time to find out the news. The origin field costs one line and keeps the process from reprocessing its own change. And tying the TTL to the entity's real lifecycle (online doesn't expire, offline expires) solves cleanup with no extra job. I use this same reasoning today whenever two processes need to see the same data.
