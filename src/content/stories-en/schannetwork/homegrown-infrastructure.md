---
title: "Hosting a server on the home PC: DNS, NAT, firewall and the JVM, one layer at a time"
summary: "Making a server running on my home PC reachable from outside required layers I didn't even know existed. I learned them one at a time, from DNS and NAT to the firewall and JVM memory, and each one solved a real constraint of the environment."
project: schannetwork
order: 5
tags: [Linux, DNS, NAT, iptables, JVM, Networking]
---

The SchanNetwork server ran on the PC in my house. I'd start the server, join through my own game, and everything worked. Then a friend would message: "I can't get in". On my side everything was green. On his side, timeout. That "it works here, but nobody from outside can join" was the first of many mysteries of a home network, and each one taught me a layer that seems obvious today, but that I learned on my own, hands on.

## The problem

Starting the Minecraft process is the easy part. For players to get in, the machine had to be reachable from the internet, have a name that's easy to type, not be left wide open to any traffic and stay up when the number of people grew. Nobody taught me any of this, and a residential connection was never meant to host anything. Each requirement ran into a different constraint of the environment, and I had to figure out which.

## Why it wasn't trivial

All the layers hide behind the same symptom. "Nobody can join" could be the domain pointing to the wrong place, the router blocking the connection, the Linux firewall refusing, the Minecraft process dead or the JVM stuck out of memory. Without understanding what each layer does, there's no way to know which one failed. And I didn't even know layers existed.

## The solution

I learned one layer at a time, always because a new requirement called for it.

### Linux

I installed and administered the machine's Linux. I learned to view processes, read logs, check open ports and restart the server from the command line, which is everything you need to run a machine with no screen in front of it.

### DNS

An IP is hard to remember and, on residential internet, can change. **DNS** translates a name into an IP. I set up a domain of my own pointing to the machine, and players started joining through a name instead of a string of numbers.

### NAT and port forwarding

At home, the router has one public IP and every device sits behind it with private IPs. **NAT** (network address translation) is what makes that split work. The side effect is that a connection coming from outside reaches the router and it doesn't know which device to hand it to. **Port forwarding** solves this: a rule on the router sends the traffic of a specific port to an internal IP. It was exactly the missing piece in the "works in here" mystery.

### Firewall with iptables

**iptables** is the Linux kernel's firewall: a list of rules that decides what comes in and what goes out. A machine exposed to the internet receives all kinds of access attempts, so the golden rule was to open only what's necessary.

### JVM, memory and Garbage Collection

The Minecraft server is a Java program, and the JVM manages memory by itself with the **Garbage Collector**, which collects objects nobody uses anymore. Sizing the process forced me to understand one piece at a time: how much memory it gets, what happens when it runs out and why the server freezes during a big collection. Memory stopped being a number on the computer's box and became something I had to plan.

## An example

Everything below is **illustrative**, with documentation IPs and generic values, not the real configuration of the time. The path of a player's connection:

```text
player types play.example.com
  -> DNS answers 203.0.113.45 (public IP of the home router)
  -> connection reaches the router on port 25565
  -> port forwarding: 25565 -> 192.168.0.10:25565 (the server PC)
  -> iptables on the PC accepts port 25565
  -> Minecraft's Java process receives the player
```

Each arrow is a place where the connection can die. The mystery of the friend who couldn't join was the third arrow: without the port forwarding rule, the router dropped the connection. Inside the house it worked because I connected directly through the private IP, without going through the router.

On the firewall side, the "close everything and open what's needed" logic looks like this:

```bash
iptables -A INPUT -i lo -j ACCEPT
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A INPUT -p tcp --dport 22 -s 192.168.0.0/24 -j ACCEPT   # SSH only from the home network
iptables -A INPUT -p tcp --dport 25565 -j ACCEPT                  # Minecraft for the world
iptables -P INPUT DROP
```

And the JVM, with explicit memory limits instead of letting the default decide:

```bash
java -Xms2G -Xmx2G -jar server.jar nogui
```

`-Xmx` is the JVM's memory ceiling. When live objects get close to it, the Garbage Collector works harder and harder, the server stutters, and if there's still no room, `OutOfMemoryError` comes. Setting `-Xms` equal to `-Xmx` keeps the JVM from growing and shrinking memory during the game.

## Result

The server became reachable by name, protected by a firewall I understood and with memory configured on purpose, not by luck. Opening the server to the outside taught me NAT, ports and firewall. Sizing the JVM taught me memory and Garbage Collection.

The foundation I have today in networking and infrastructure started here, on a home PC, solving real constraints so players could get in.

## What I take from it

When the symptom is "can't connect", I check layer by layer, from the outside in: name, route, port, firewall, process. It's the same diagram above, only today with a load balancer, a proxy and the cloud in place of the home router.

And administering your own infrastructure, at least once, changes the way you write software. Anyone who has seen a process die from lack of memory thinks twice before loading everything into a list.
