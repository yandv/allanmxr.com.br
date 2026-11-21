---
title: "Obfuscation on both sides: reading scrambled code and protecting my own"
summary: "Plugins scrambled on purpose closed off my way of learning, and later I wanted to protect my own against copying. I learned to read obfuscated code and to obfuscate mine, and understood what this protection holds and where it leaks."
project: schannetwork
order: 2
tags: [Java, Obfuscation, Allatori, Bytecode, Reverse engineering]
---

My study method was simple: open a plugin's `.jar`, decompile it and read. It worked very well until the day I opened a plugin and found classes named `a`, `b` and `c`, methods named `a`, variables named `a` and a flow that jumped to places that made no sense. It was like opening a book and discovering someone had swapped every word for "blah". Years of learning (well, a few months) seemed to have hit a wall. It was **obfuscation**, and it ended up teaching me more than clean code did.

## The problem

Many plugins came obfuscated on purpose. The author wanted nobody to open and copy their work, which is fair. For me, who learned precisely by opening and reading, this closed the main door.

Some time later the problem flipped. I started writing plugins of my own for SchanNetwork and I also didn't want just anyone to open the `.jar`, copy it and publish it as theirs. Suddenly I was on the other side of the same wall.

## Why it wasn't trivial

Obfuscating doesn't hide the code. The `.jar` is still executable, so all the behavior is still there, whole. What obfuscation removes are the clues a human uses to understand: meaningful names, predictable structure, readable messages. The same short name appears in several classes with different meanings, and the decompiler sometimes returns snippets that don't even compile.

On the protecting side, there's a hidden cost. Each transformation touches the bytecode and can leave the plugin bigger, slower or simply broken. In a Minecraft plugin this is very concrete: the server looks up some things by name, like the main class declared in `plugin.yml` and the methods annotated with `@EventHandler`. If the obfuscator renames the wrong thing, the plugin loads without doing anything, or doesn't load at all.

## The solution

### Reading obfuscated code: starting from what can't change

Without names, I started reading by behavior. Instead of asking "what does this name mean?", I asked "what does this receive, what does it return and who does it talk to?".

The key was realizing that calls to the Bukkit API **can't be renamed**. The obfuscator only touches the plugin's code, and the server needs to recognize `Player`, `sendMessage`, `PlayerJoinEvent`. Those calls become anchors. If a mysterious method calls `setHealth` and receives a number, you can already guess what it does. From the anchors, I renamed each unknown piece in my head (and later in an editor) until the puzzle closed.

### Protecting my own: Allatori without a black box

When I started protecting my own plugins, I used Allatori, a commercial Java obfuscator that runs over the already-compiled `.jar`. It renames identifiers, scrambles the control flow and encrypts strings. I didn't want to use it in "press the button and pray" mode. I tested each transformation, saw what it did to the bytecode and learned to configure exceptions: keeping the main class and the event listeners with their original names, because the server needs to see them.

## An example

The code below is **illustrative**, written to show the kind of transformation, not copied from any real plugin. Before obfuscation, a combat snippet:

```java
public class CombatListener implements Listener {
    private final Map<UUID, Integer> killStreaks = new HashMap<>();

    private double calculateDamage(Player attacker, double baseDamage) {
        int streak = killStreaks.getOrDefault(attacker.getUniqueId(), 0);
        return baseDamage * (1.0 + streak * 0.05);
    }
}
```

After a typical obfuscator, the decompiler would return something like this:

```java
public class a implements Listener {
    private final Map<UUID, Integer> a = new HashMap<>();

    private double a(Player a, double b) {
        int c = this.a.getOrDefault(a.getUniqueId(), 0);
        return b * (1.0 + c * 0.05);
    }
}
```

Notice what **survived**: `Listener`, `Player`, `getUniqueId`, `Map`, `UUID`. Everything that belongs to the Bukkit API or to Java itself stayed intact. To read it, I did exactly the reverse path of the obfuscator:

| Clue that survived | Deduction |
| --- | --- |
| The class implements `Listener` | Listens to game events |
| The map is indexed by `UUID` | Stores something per player |
| The method receives `Player` and a `double` and returns `double` | Transforms a number based on the player |
| `1.0 + c * 0.05` | A 5% bonus per unit of something that comes from the map |

Four lines of deduction and `a(Player, double)` becomes "calculates damage with a bonus per kill streak". When I obfuscated my own plugins, this table was my test: if I myself could reconstruct the meaning in a few minutes, I knew exactly how much the protection was worth.

## Result

I gained two opposite skills that complete each other. The first was reading code without depending on pretty names, which helps much more than it seems when debugging legacy systems or an undocumented library. The second was using obfuscation with open eyes, knowing the cost and the limit of each transformation.

And I gained a realistic sense of what it protects. Obfuscation raises the effort for whoever wants to copy, discourages the casual curious and that's it. Whoever is determined gets there, and I knew that because I was that person.

## What I take from it

Obfuscation is a cheap layer, not a vault. Any real secret, like an API key or a rule that can't be bypassed, shouldn't travel inside code that goes to someone else's machine. What truly needs protecting stays on the server side.

The other lesson is about security in general: understanding how the attack works is what lets you evaluate the defense. I only knew where my code leaked because I had already spent hours extracting meaning from other people's code.
