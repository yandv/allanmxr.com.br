---
title: SaintMC
role: Lead developer and architect
period: 2019 to 2021
summary: "On a Minecraft network with more than 320 concurrent players, any database wait turned into lag and every change had to reach all servers. I was the lead developer of the core, the data layer and the network's protection."
order: 10
stack: [Java, Bukkit/Spigot, BungeeCord, ProtocolLib, TerrainControl, Redis, MongoDB, Linux, Dedicated server]
cover: ../../assets/projects/saintmc/logo.png
gallery:
  - src: ../../assets/projects/saintmc/270-players.png
    alt: Server list showing 270 players connected to SaintMC
  - src: ../../assets/projects/saintmc/jackster-pvp.png
    alt: A KitPvP match on SaintMC
videos:
  - id: B-hNJ2i42rw
    title: SaintMC promotional video
  - id: JHokO9vaUb4
    title: KitPvP gameplay
  - id: u0VW_UXNA74
    title: SaintMC CopaHG
  - id: yK0xWOpb2No
    title: HungerGames gameplay
resume:
  summary: Lead developer of a Minecraft network with more than 320 concurrent players, with layered caching on Redis, MongoDB and a custom anticheat in Java.
  order: 3
---

## Context

SaintMC was a competitive Minecraft network I operated between 2019 and 2021, focused on Hardcore Games (survival matches on a fresh map every round) and KitPvP (combat with ready-made kits). It peaked above 320 concurrent players. There were several game servers behind a proxy, and everything ran on a dedicated machine I administered myself, with no managed cloud, no containers and no automated deploy pipeline.

A game server works in 50 ms cycles, the ticks. Anything that blocked the main thread turned into lag right in the player's face, and any change made on one server had to show up on the others immediately. A good part of what I built there I still use today: taking I/O off the hot path, invalidating cache by event, filtering with the cheapest check first.

## My role

I was the lead developer. I designed the shared core, the data layer, the communication between servers, the proxy's protection, the anticheat and the machine's operations routine.

## Architecture at a glance

- **Proxy (BungeeCord):** receives the connection, validates the player, loads the account and picks the destination server.
- **Game servers (Bukkit/Spigot):** lobbies and Hardcore Games, KitPvP and other modes, each one a plugin on top of the same core.
- **Common core:** a module with business rules and data access, used by both the proxy and the game servers.
- **MongoDB:** source of truth for accounts, clans, reports and servers.
- **Redis:** account cache, server registry and a Pub/Sub bus between all processes.
- **ProtocolLib:** access to packets at the network layer, used by the malicious packet filter and the anticheat checks.

Each server registers itself in Redis on startup and announces changes on Pub/Sub channels. The proxy listens to those channels, keeps the list of active servers and picks the player's destination. Account, clan and report changes also travel over Pub/Sub, and each process updates its own in-memory copy.

## Architecture decisions

- **No database I/O on the game tick.** Mongo and Redis are accessed on async threads and the account is loaded during the async pre-login. The cost of waiting for the database is paid before the player enters, never during the match.
- **Layered cache with event-based invalidation.** Memory, then Redis, then Mongo. When a field changes, the server that changed it publishes the event and the others update their own copy, instead of querying the database again.
- **One core, two platforms.** Business rules and data access are written once and run on both the proxy and the game servers behind a small platform interface.
- **Balancing strategy per server type.** Lobbies use lowest occupancy, matches use highest occupancy to fill one room before opening another.
- **Defense in depth at the entrance.** The proxy filters bots and countries before any game logic, from the cheapest filter to the most expensive, and the game server drops packets whose only purpose is to crash it.
- **Heavy work outside peak hours.** Map generation, which consumed the whole machine's CPU, moved to the early hours of the morning, and matches only chose among ready-made maps.
