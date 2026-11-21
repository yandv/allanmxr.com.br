---
title: SchanNetwork
role: Founder and developer
period: 2014 to 2016
summary: "My first Minecraft server, running on my home PC, with no course and nobody to ask. Every problem became a lesson: I learned Java by opening other people's plugins, versioned with Git and understood networking with every outage."
order: 11
stack: [Java, Bukkit/Spigot, TerrainControl, Git, Allatori, Twitter API, OAuth, Linux, DNS, iptables, NAT]
videos:
  - id: -o5d7bxu5ww
    title: SchanNetwork gameplay
  - id: ABNkgo_PLeI
    title: SchanNetwork gameplay, part 2
  - id: Bckbfy9yHNo
    title: SchanNetwork gameplay, part 3
---

## Context

SchanNetwork was my first Minecraft server, between 2014 and 2016. I was a kid, in love with the game and set on having a server with my own stamp on it. I didn't know how to program and had nobody to ask. The server ran on my home PC, and every problem that came up, from a broken plugin to a player who couldn't get in, became a lesson I had to teach myself.

I'm very proud of this project, not for its size, but because it's where I learned how to learn: read other people's code, break it, fix it and understand why.

## My role

Founder and sole developer. I chose the plugins, wrote my own, administered the machine, took care of the network and answered whenever something went down, including at the worst hours.

## Architecture at a glance

- **Bukkit/Spigot server** (the platform that lets you extend Minecraft with Java plugins), with third-party plugins and my own.
- **Custom Java plugins**, versioned with Git and protected with the Allatori obfuscator.
- **Twitter API integration**, authenticated with OAuth, to post every ban to the @SchanBan account.
- **TerrainControl map generator** to create the terrain for the Hardcore Games matches.
- **Linux machine at home**, with its own domain, DNS, port forwarding on the router (because of the residential internet's NAT) and an iptables firewall.

## Architecture decisions

- **Learning by reading production code.** With no course, I decompiled the plugins already running on the server and followed their logic line by line. That was how I learned Java and the Bukkit API at the same time.
- **Protecting what I wrote, knowing the limits of protection.** After learning to read obfuscated code, I started obfuscating my own plugins with Allatori, understanding that obfuscation raises the effort for whoever copies, but doesn't keep a secret.
- **Taking moderation outside the game.** Every ban became a tweet, posted off the server's main thread so a slow external API would never freeze the game.
- **Versioning everything with Git.** To roll back a version in seconds when a change broke the server, and to stop editing directly in production.
- **Not generating maps during play.** Terrain generation competed with players for CPU and sometimes took the server down. I started generating maps beforehand, outside play hours, an idea I later systematized at SaintMC.
- **Learning infrastructure through failure.** Every connection drop taught me DNS, NAT, ports and firewalls, and every JVM crash taught me memory and garbage collection.
