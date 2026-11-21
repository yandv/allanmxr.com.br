---
title: I learned Java by opening other people's plugin .jar files
summary: "I wanted plugins nobody had made, but I didn't know how to program and had no one to ask. I learned Java by opening other people's plugins and changing one line at a time until I understood what each piece did."
project: schannetwork
order: 1
tags: [Java, Bukkit, Decompilation, Bytecode, Code reading]
---

I was a kid, with a Minecraft server running on my home PC and a huge list of ideas that no ready-made plugin did the way I wanted. I didn't know how to program, had no course and didn't know anyone in the field. What I had was a `plugins/` folder full of `.jar` files written by people who knew what they were doing. One day I opened one of them in a decompiler just to see what was inside. It was my first Java lesson, and the teacher didn't even know he was teaching.

## The problem

I wanted specific behaviors on the server: a different message on join, a kit with items chosen by me, a combat rule that only made sense in my game mode. For that I needed to write plugins. To write plugins I needed Java. And to learn Java I had no method other than curiosity.

The material within my reach was other people's code, already running on my server. Only that code didn't come in text form.

## Why it wasn't trivial

A Bukkit plugin (Bukkit being the API that lets you extend a Minecraft server with Java code) is distributed as a `.jar`, which is a compressed file with classes already compiled to **bytecode**, the format the Java virtual machine executes. The original text the author wrote isn't there.

The second obstacle was worse: I was learning the language and the platform at the same time. Someone who doesn't know Java can't separate what belongs to the language (a `for`, a class, an exception) from what belongs to the Bukkit API (an event, a command, a player). Everything looked like a single mass of unfamiliar words, and any compilation error felt like the universe's fault.

## The solution

### Turning bytecode back into text

There are **decompilers**, tools that do the opposite of the compiler and rebuild readable Java from the bytecode. The result isn't identical to the original: local variable names disappear, some loops show up rewritten. But it's good enough to follow the logic.

### Finding the front door

Every plugin has a main class that extends `JavaPlugin`, and the `plugin.yml` file inside the `.jar` says which one it is. That's where the server starts executing the plugin. Finding that class became my first step every time, because from it you can pull the thread: which events the plugin listens to, which commands it registers, what it does in each one.

### Changing one thing at a time

The method was repetitive on purpose:

1. Open the `.jar` of a plugin that did something I liked.
2. Follow the flow starting from the main class.
3. Change **a single thing**, recompile, put it on the server and see the effect.

Changing just one thing is what turns reading into learning. If I swapped a number or a condition and the behavior changed the way I predicted, I had understood that piece. If it changed in an unexpected way, I had discovered something new and went back to reading. It was the scientific method applied to a server made of little blocks.

## An example

The code below is **illustrative**, written now to show the shape of what I found when opening a simple plugin. It's practically the skeleton of every Bukkit plugin of the time:

```java
public class WelcomePlugin extends JavaPlugin implements Listener {

    @Override
    public void onEnable() {
        // the server calls this when loading the plugin
        getServer().getPluginManager().registerEvents(this, this);
    }

    @EventHandler
    public void onJoin(PlayerJoinEvent event) {
        Player player = event.getPlayer();
        player.sendMessage("Welcome, " + player.getName() + "!");

        if (!player.hasPlayedBefore()) {
            player.getInventory().addItem(new ItemStack(Material.STONE_SWORD));
        }
    }
}
```

Looking at this for the first time, I asked questions one at a time, and each answer came from an experiment:

| Question | Experiment | What I learned |
| --- | --- | --- |
| Who calls `onEnable`? | Put a console message inside it | The server calls it when loading the plugin: it's the entry point |
| What does `@EventHandler` do? | Removed the annotation | The method stopped being called: the annotation registers the method as a listener |
| What is `extends`? | Compared with other plugins | They all extended `JavaPlugin`: inheritance, the server expects that shape |
| Why `if (!player.hasPlayedBefore())`? | Flipped the condition | The item started being given on every login: I understood the `!` and the `if` |

None of these answers came from a book. They came from breaking and fixing, over and over, until the pattern appeared.

## Result

I learned Java by reading code from people who already knew it, before mastering the syntax. As a bonus, I learned the Bukkit API by seeing dozens of plugins solving similar problems in different ways, which taught me early that there's more than one right way and a few very wrong ones.

The first SchanNetwork plugins were born from this process: they started as a mental copy of something I had read and, little by little, became my own code. It was a crooked kind of learning, but it left a skill I use every day.

## What I take from it

To this day, when I arrive at a system I didn't write, I do exactly the same thing: find the entry point, follow the flow, change one thing at a time and observe. At any company, getting into unfamiliar code and changing it without breaking it is half the job, and I trained that before I knew what a `for` was.

The other lesson is about technical humility. Reading other people's code with curiosity, instead of judgment, teaches faster than any tutorial. Production code shows what really works, with all the hacks and wins that teaching material hides.
