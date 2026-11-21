---
title: Getting the database out of the tick and loading the account before the player joins
summary: "Reading the account from the database inside the Minecraft tick would make the whole room stutter whenever many players joined at once. I designed loading to happen before the player enters the world, and the game never waits on the database."
project: saintmc
order: 1
tags: [Java, Bukkit, BungeeCord, MongoDB, Redis, Concurrency]
---

Imagine a Saturday night, a packed Hardcore Games lobby, a match about to start. A group of players joins all at once and, for half a second, everyone already in the room sees the others "teleporting", arrows hang in mid-air and the chat freezes. Nobody did anything wrong. All it would take is the server waiting for the database to return the account of whoever had just arrived.

## The problem

A Minecraft server runs in fixed cycles called ticks: twenty per second, one every 50 ms. In each tick it moves entities, processes hits, updates the world and sends the result to the players. If something inside the tick takes 200 ms, that tick lasts 200 ms and the next three simply don't happen on time. The player experiences this as lag.

On SaintMC, the player's account (rank, coins, punishments, clan, preferences) came from MongoDB, with Redis as a cache in front. Any read done on the main thread, even one taking only a few tens of milliseconds, would steal time from the tick. With a lot of people joining together, like at the turnover of a match, those waits would add up and the whole room would pay the price, not just the people arriving. That platform constraint was what the design had to respect.

## Why it wasn't trivial

The obvious answer would be "throw the query onto another thread". The catch is that the Bukkit API is not thread safe: almost anything that touches a player, the world or an inventory has to run on the main thread. If I fetched the account in parallel and the player was already in the world, there would be a gap in which they exist without a loaded account. In that gap, a command, the tablist or the chat would ask for their rank and find nothing.

There was also a discipline problem. The account is read in many places: on join, on server switch, when looking up another player by name. A single forgotten synchronous read anywhere would make the tick stutter. I needed a design where the right path was also the easiest path.

## The solution

### Finding the moment when waiting is cheap

Bukkit has an event designed for exactly this: `AsyncPlayerPreLoginEvent`. It fires on a separate thread, after the client authenticates and before the player exists in the world. There I can take as long as I need without delaying any tick, because the player is still on the "Connecting..." screen, where a few hundred milliseconds go unnoticed.

I put the entire account loading in that event. First the cheap rejections (maintenance, invalid address, account already online in another session), then the account lookup across memory, Redis and Mongo, and finally the clan, if the player has one. If anything fails, the player is turned away at the door with a clear message, instead of entering in a half-baked state.

### Making sure no garbage is left behind

Another plugin may reject the login after me. To cover that case, a second handler, with `MONITOR` priority (the last to run), checks the final result of the event and drops the account from memory if the login wasn't accepted.

### Doing the same on the proxy

On BungeeCord, the proxy that sits in front of all the servers, the reasoning was the same. The proxy's login event has an "intent" mechanism: I register an intent, do the work on an asynchronous thread and release the connection when I'm done. The proxy holds the player without blocking the network thread.

### Writes outside the tick too

For writing, the rule was symmetric. A field change updates the in-memory account right away and hands the Mongo write, the Redis update and the notification to the other servers off to an asynchronous task. The shared core called a `runAsync` exposed by the platform, without knowing whether it was running on Bukkit or BungeeCord.

## An example

The code below is a simplified version of the listener with generic names, just to show the shape:

```java
public class AccountLoginListener implements Listener {

    private final AccountRepository repository;
    private final Map<UUID, Account> online = new ConcurrentHashMap<>();

    @EventHandler(priority = EventPriority.LOW)
    public void onPreLogin(AsyncPlayerPreLoginEvent event) {
        // runs off the main thread: free to wait on the database
        Account account = repository.load(event.getUniqueId());
        if (account == null) {
            event.disallow(Result.KICK_OTHER, "Could not load your account.");
            return;
        }
        online.put(event.getUniqueId(), account);
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onPreLoginResult(AsyncPlayerPreLoginEvent event) {
        // another plugin may have rejected the login after us
        if (event.getLoginResult() != Result.ALLOWED) {
            online.remove(event.getUniqueId());
        }
    }

    public Account get(UUID id) {
        return online.get(id); // on the main thread, just a map read
    }
}
```

The difference shows up better on a timeline. If the read stayed inside the tick:

| Time | What happens |
| --- | --- |
| t=0 ms | Tick starts, new player enters the world |
| t=5 ms | Code asks for the account, cache is empty, goes to Mongo |
| t=180 ms | Mongo responds, tick ends |
| t=180 ms | Three ticks lost, the whole room feels it |

With the pre-login:

| Time | What happens |
| --- | --- |
| t=0 ms | Client authenticated, pre-login fires on another thread |
| t=180 ms | Account loaded in memory, login released |
| t=181 ms | Player enters the world, the account is already there |
| always | Ticks keep running every 50 ms, nobody notices anything |

The 180 ms still exist. They just moved: they left the cycle everyone shares and went to the connection screen of whoever is arriving.

## Result

The game tick never waits on the database on the join path. Inside the match, reading the account became a lookup in an in-memory map, and the rest of the code could trust that if the player exists in the world, their account exists too. That eliminated a whole class of null checks scattered across the game modes.

I didn't keep latency measurements from back then, so I won't invent numbers. What I can state is the mechanism: the cost of going to the database started being paid once per connection, on the loading screen, and no longer in the middle of a fight.

## What I take from it

Before optimizing a query, I ask when it needs to happen. Almost every system has a point in its lifecycle where waiting is cheap: a game's pre-login, a page's build, the job that runs before the user asks. Moving the I/O to that point usually pays off more than any new index. And designing the flow so that the right way is also the easiest way is worth more than counting on everyone's discipline.
