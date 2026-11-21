---
title: Stopping bots at the proxy door, from the cheapest filter to the most expensive
summary: "Bot waves filled the server and the chat before being kicked out, burning game resources. I put filters at the entrance, from cheapest to most expensive, that stop these attacks without bothering players with original accounts."
project: saintmc
order: 5
tags: [BungeeCord, Rate limiting, Bot protection, Guava Cache, Java]
---

Ten p.m., the player counter jumps by dozens in less than a minute. It isn't a tournament or a new video from a YouTuber. It's accounts with random names, all coming from the same handful of addresses, joining and leaving nonstop. Each one that gets past the door loads an account, takes up a slot and enters a lobby. Real players start seeing "server full" and the chat turns into spam.

## The problem

An open Minecraft network is an easy target for bots: programs that open connections in bulk, each with a different nickname, to fill the server, pollute the chat or just annoy people. On SaintMC, the network accepted original accounts (authenticated by Mojang) and also non-original ones (cracked accounts, with no paid license), which is common on Brazilian servers and greatly increases the room for abuse.

The deeper a fake connection got, the more expensive it became. Blocking at the first byte costs almost nothing. Blocking after loading the account, querying the database and placing the player in a lobby costs all of that plus the kick.

## Why it wasn't trivial

The useful checks depend on slow external services. Knowing whether a nickname belongs to an original account requires asking the Mojang API. Knowing which country an IP comes from requires a geolocation API. Both have usage limits. Calling each one on every connection attempt would make the attack also an attack against those APIs, and the result would be getting blocked by them right when I needed them most.

On top of that, the BungeeCord proxy has a network thread that can't sit waiting on HTTP. And a legitimate player with an unstable connection, who drops and comes back, couldn't be treated as a bot.

## The solution

I organized the defenses in layers, from the cheapest to the most expensive, so that each connection only reached an expensive check if it had passed all the cheap ones.

### 1. A blocked IP doesn't even get to talk

On the client connection event, the first one on the proxy, the address is compared against an in-memory set of blocked IPs. If it's there, the connection is canceled before any heavier handshake.

### 2. Heavy work off the network thread

The pre-login uses BungeeCord's "intent" mechanism: I register the intent, run the checks on an asynchronous thread and release the connection at the end. The first question goes to Mojang, to find out whether the nickname belongs to an original account. Original accounts have already proven who they are and go straight through. The rest go through the following filters.

### 3. One attempt per IP every few seconds

The IP of a non-original account goes into a Guava cache (a Google library with an in-memory cache that expires entries on its own) with a five-second lifetime. A new attempt from the same IP within that interval is refused with a "too many attempts at once" message. The expiring cache plays the role of the rate limit with no cleanup task.

### 4. Many nicknames on the same IP

Each IP has a record of the nicknames already seen. On the tenth different name, the IP is blocked for a long period. These records live in a cache that expires after one hour, so the proxy's memory doesn't grow with every address that has ever passed through.

### 5. Country outside the served area

The IP's geolocation is queried once, saved to the database and kept in memory. Addresses from countries the network didn't serve were marked as not allowed. Since the result is persisted, the same IP doesn't spend another external call even after restarting the proxy. For false positives, such as a Brazilian player traveling, there was a staff command to whitelist the IP by hand.

### 6. Failing closed

If any check throws an exception, the connection is refused with a message and a link to support. A failure in the geolocation API couldn't turn into an open door in the middle of an attack.

## An example

A simplified version of layers 3 and 4, with generic names:

```java
private final Cache<String, Boolean> recentAttempts = CacheBuilder.newBuilder()
        .expireAfterWrite(5, TimeUnit.SECONDS).build();

private final Cache<String, Set<String>> namesByIp = CacheBuilder.newBuilder()
        .expireAfterWrite(1, TimeUnit.HOURS).build();

Verdict check(String ip, String nickname) throws ExecutionException {
    if (blockedIps.contains(ip)) return Verdict.BLOCKED;

    if (recentAttempts.getIfPresent(ip) != null) return Verdict.TOO_FAST;
    recentAttempts.put(ip, true);

    Set<String> names = namesByIp.get(ip, HashSet::new);
    names.add(nickname.toLowerCase());
    if (names.size() >= 10) {
        blockedIps.add(ip);
        return Verdict.BLOCKED;
    }

    // only reaches here whoever passed the in-memory filters
    return geoService.isAllowed(ip) ? Verdict.OK : Verdict.BLOCKED;
}
```

Now the same bot wave, coming from a single IP, on an illustrative timeline:

| Time | Attempt | Result | Cost |
| --- | --- | --- | --- |
| t=0 s | nick 1 | passes, geolocation queried and saved | 1 external call |
| t=0.4 s | nick 2 | refused, too fast | in-memory lookup |
| t=5.1 s | nick 3 | passes, geolocation already in memory | in-memory lookup |
| ... | nicks 4 to 9 | pass spaced out or are refused | in-memory lookup |
| t=48 s | nick 10 | IP blocked | in-memory lookup |
| t=49 s onward | any nick | canceled on the first event | almost zero |

Throughout the whole wave, the external geolocation API received one call. Mojang received one per nickname, and only because that was the question that decided whether the account followed the original-account path.

## Result

Simple bot attacks started being stopped at the door, and the network stopped spending loaded accounts, slots and lobbies on them. The external APIs received one call per new IP, not one per attempt, which kept the network away from usage limits even during the waves. Original accounts never went through the funnel, so legitimate players with paid accounts felt nothing. I didn't keep numbers on blocked traffic to cite.

## What I take from it

Order filters by cost: everything that can be settled with an in-memory lookup comes before what requires the network or the database. Cache the result of every external query, with a lifetime designed for the attack and not for normal use. And decide in advance what happens when the defense itself fails. Today, designing rate limits on HTTP APIs, I follow the same order: cheap first, expensive only for whoever passed, and fail closed.
