---
title: The same punishment rule on the proxy and in the game, written only once
summary: "The proxy and the game servers need the same rules, and two copies of a mute rule end up diverging until a mute doesn't hold on the other side. I designed a core shared by both platforms, and each rule is written only once."
project: saintmc
order: 7
tags: [Software architecture, Java, Maven, BungeeCord, Bukkit]
---

Imagine a moderator applying a one-hour mute through the proxy. The player switches servers and keeps talking in the match chat, because the game server's "is muted?" rule calculated the expiration slightly differently from the proxy's rule. Two implementations of the same idea, written at different times, silently diverging. It's the kind of bug nobody finds by reading the code on one side only, and it was exactly what I wanted to make impossible from the start.

## The problem

SaintMC had two kinds of process that needed to understand the same domain. The BungeeCord proxy, which receives all connections and routes the players. And the Bukkit/Spigot game servers, one for each lobby and room. Accounts, ranks, punishments, clans, reports, the server list and balancing were the concern of both.

Writing everything twice meant fixing everything twice. And, worse, it opened the door to the opening scenario: two versions of the same rule diverging without anyone noticing until a player finds the loophole.

## Why it wasn't trivial

The two platforms have completely different APIs. In Bukkit, the player is a `Player`; in BungeeCord, it's a `ProxiedPlayer`. The task schedulers are different, the events are different, commands are registered in a different way. If the punishment class imported anything from either platform, it would only compile for that platform.

I needed a clean cut between what is a network rule and what is a platform detail. And that cut had to be small, otherwise the "abstraction layer" would become a second framework to maintain, bigger than the problem it solved.

## The solution

### Layered modules

I split the Maven project into modules with a simple dependency rule: the lower down, the less it knows about the world.

- **Common core:** zero Minecraft dependency. Accounts, ranks, punishments, clans, reports, the server manager with the balancers, the format of messages between processes and data access on MongoDB and Redis.
- **Bukkit bridge:** listeners, commands, menus, holograms, tablist, packet filters and the anticheat.
- **BungeeCord bridge:** login, entry protection and moderation commands.
- **Game modes:** KitPvP, Hardcore Games, Gladiator, Skywars, lobbies and login, each one a plugin that depends only on the Bukkit bridge.

### A minimal platform interface

The point of contact between the core and the platform is an interface with only what the domain really needs to ask of the outside world: find a player by name or UUID, talk to the console and run something asynchronously. Each platform has its own implementation. The core never knows which one is running.

I started the interface from what the domain needed, not from what the platforms offered. Had I mirrored the Bukkit API, the interface would have dozens of methods and BungeeCord couldn't implement half of them.

### Messages with the same code on both sides

The core also defines the format of the messages exchanged between processes: punishment requests, alerts, server updates. Since both ends serialize and deserialize with the same class, there's no risk of the proxy expecting a field the game server stopped sending.

## An example

A simplified version, with generic names, of the platform interface and of a core rule that uses it:

```java
public interface Platform {
    Optional<UUID> findPlayerId(String name);
    void sendToConsole(String message);
    void runAsync(Runnable task);
}

public final class PunishmentService {
    private final Platform platform;
    private final PunishmentRepository repository;

    public boolean isMuted(Account account, Instant now) {
        // the same rule for proxy and game: there is no second version to diverge
        return account.mutes().stream().anyMatch(m -> m.isActiveAt(now));
    }

    public void mute(Account target, Duration duration, String reason) {
        Mute mute = Mute.starting(Instant.now(), duration, reason);
        target.addMute(mute);
        platform.runAsync(() -> repository.save(target.getId(), mute));
        platform.sendToConsole("Mute applied to " + target.getName());
    }
}
```

On Bukkit, `runAsync` uses the game server's asynchronous scheduler. On BungeeCord, it uses the proxy's scheduler. The punishment class imports nothing from either one and compiles on its own.

And what changed, in practice, when a rule needed adjusting:

| Change | Without a common core | With a common core |
| --- | --- | --- |
| New punishment type | implement on the proxy and in the game | implement once |
| Fix expiration calculation | remember to fix both | one fix, both inherit it |
| New account field | two models and two serializers | one model, one serializer |
| New game mode | reimplement account, rank, punishment | inherit everything, write only the game |

## Result

Business rules and data access came to be written once. Changing the format of a punishment or of an account field was a single change, seen by the proxy and the game servers in the same deploy. A mute slipping away on a server switch had no way to happen, because only one rule existed.

The biggest gain showed up in the game modes. Each new mode was born with accounts, ranks, punishments, clans and balancing ready, and I wrote only what belonged to the game: the match rules, the kits, the scoreboard.

## What I take from it

An interface between the domain and the infrastructure should be born from what the domain needs to ask for, not from what the infrastructure offers. That's why it ended up with few methods, and why it was easy to implement twice. It's the same idea I apply today in web systems: the business rule doesn't know whether it's running in a worker, in an HTTP server or in a scheduled job. It receives the few capabilities it needs and leaves the rest to whoever is around it.
