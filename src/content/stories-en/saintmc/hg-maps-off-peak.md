---
title: Generating the maps at 3 a.m. so the 9 p.m. peak belongs to the game
summary: "With the whole network on a single machine, generating a new map at peak hours would steal CPU from every game mode. I started generating a stock of maps overnight and rotating between them during the day, without buying another server."
project: saintmc
order: 8
tags: [TerrainControl, Batch processing, CPU, Minecraft, Operations]
---

Imagine nine p.m., peak time on the network. A Hardcore Games match ends and the room needs a new world for the next one. If the server started generating terrain, biomes and caves from scratch right then, within seconds a player in the lobby would see the chat lag and another in KitPvP would feel a hit land from far away. None of them would be in Hardcore Games. All of them would be on the same machine.

## The problem

Hardcore Games is a mode where every match starts on a new, randomly generated map: nobody can know the terrain beforehand, and exploring is part of the game. On SaintMC, what generated those maps was TerrainControl, a plugin that builds the world from rules of relief, biome and structures.

Generating a world is heavy CPU work. And SaintMC ran on a single dedicated machine, administered by hand by me, with the proxy, the lobbies and all the rooms sharing the same processor. A room generating a map doesn't steal CPU only from itself: it steals from everyone. The symptom would show up in the places farthest from the cause.

## Why it wasn't trivial

There was no other machine to send the work to. No cloud with on-demand instances, no job queue on another server. It was one machine.

The generator was third-party and did exactly what I wanted it to do. Rewriting a world generator to be lighter wasn't a realistic option. And reducing the number of matches was out of the question, because Hardcore Games was the network's main mode.

At first glance, the problem called for more hardware. But the processor wasn't short all day long. It was short at specific moments, precisely when everyone was online.

## The solution

### Changing the question

The question stopped being "how do I generate the map faster" and became "why generate the map exactly when someone is playing". A match's map doesn't need to come into existence only from the moment the match is requested. It can be made beforehand and stored.

### Batch generation overnight

Generation started happening between 3 a.m. and 5 a.m., when the network was nearly empty and the CPU was idle. In that window, the machine produced a stock of ready-made maps. Outside it, no new maps were generated.

### Rotating between ready maps during the day

The Hardcore Games server started rotating between 50 and 100 already-generated maps. Each new match only had to take a world from the stock and load it, which is fast and cheap compared to creating terrain from scratch. At the end of the match, the used world was unloaded and the room moved on to the next one in the rotation. The following night renewed the set.

Having dozens of ready maps also gave a product bonus: variety. Players didn't notice repetition, because the rotation had plenty to pick from.

## An example

I don't have the code of this routine to show, so the snippet below is illustrative: the shape of the idea, not the original implementation.

```java
public final class MapStock {

    private static final int TARGET_STOCK = 80;
    private final Deque<Path> ready = new ArrayDeque<>();

    /** Runs only in the overnight window, when the CPU is idle. */
    public void refill(MapGenerator generator) {
        while (ready.size() < TARGET_STOCK && isOffPeakWindow(LocalTime.now())) {
            ready.add(generator.generateNewWorld());
        }
    }

    /** Called on every new match, at peak time: it only picks, never generates. */
    public Path takeForNextMatch() {
        Path map = ready.poll();
        if (map == null) throw new IllegalStateException("Map stock is empty");
        return map;
    }

    private boolean isOffPeakWindow(LocalTime now) {
        return !now.isBefore(LocalTime.of(3, 0)) && now.isBefore(LocalTime.of(5, 0));
    }
}
```

And the difference on a typical day, with illustrative times:

| Time | Generating on demand | With a ready stock |
| --- | --- | --- |
| 03:00 to 05:00 | machine idle | map stock being replenished |
| 14:00, match ends | generates map, CPU maxed out for a few seconds | takes a ready map, loads it |
| 21:00, peak | every new match generates a map, lag across the whole network | every new match takes a ready map |
| 21:05, lobby and KitPvP | feel the generation lag | don't even notice a map change happened |

The total CPU work in the day is practically the same. What changed was when it happens. It left the hours when everyone was playing and moved to the hours when almost nobody was.

## Result

Map generation stopped competing with the game for CPU. During the day, the CPU was available for what mattered, which was the game, and the heavy work started happening hidden in the early morning, with nobody to hurt. I didn't need to buy another machine to solve a problem that, deep down, was one of scheduling.

## What I take from it

Not all work needs to happen at the moment of the request. If the result can be computed beforehand and stored, peak time stops paying for it. I had already run into this lesson on my first server, SchanNetwork; on SaintMC it became routine. Today I apply the same idea to pre-processing, warmed caches and batch jobs: before optimizing a heavy job, I ask whether it really needs to happen right now.
