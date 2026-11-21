---
title: Git from the very first plugin, on a homemade Minecraft server
summary: "My plugins shared classes and configuration, and the only environment I had was the server itself. I adopted Git early on to know what changed in each version and go back in seconds."
project: schannetwork
order: 4
tags: [Git, Version control, Java, Production]
---

Picture a Saturday night, a full server, and the urge to "just tweak one little thing" in the kits plugin. You edit the file, recompile, restart. The kits plugin starts working the way you wanted, and the combat one, which read the same configuration, stops working. Without knowing exactly what changed and with no copy of yesterday's version, the only way out would be undoing it from memory. That was the risk I saw in my way of working as a teenager with a server on the home PC, and it's why I learned, early on, what version control is for.

## The problem

My plugins started small and kept growing. Over time, a change in one place could affect another, because they shared classes and configuration. The server had real players connected, and the only environment where I could test was the server itself.

Without history, I would have no way to know what had changed nor how to go back to the state that worked. The "state that worked" would only exist in my memory, which is a great tool for many things and a terrible tool for storing code.

## Why it wasn't trivial

Without history, there's no way to compare the good version with the broken one. And I edited the files directly on the machine where the server ran, so there was no gap between having an idea and having it in front of the players. A typo went live along with the fix.

Learning Git on your own also has a curve. Repository, commit, branch, staging area: none of these concepts is obvious the first time, and almost all the material of the time assumed you were already working on a team, with a code server and review. I was a team of one, with a PC at home.

## The solution

I started versioning everything with Git, and the rules I adopted were few and simple.

### One commit per change, with a message that explains

Each change became a commit with one sentence saying what changed. It sounds like bureaucracy until the day something breaks and the history answers by itself "what did I touch last?".

### Going back a version instead of patching in a panic

If a change didn't behave the way I expected, I went back to the last good state in seconds and investigated calmly. Making mistakes became cheap.

### The server stopped being the place where you tinker

The code started being edited and tested off the machine where the server ran. The server received only what was already committed. This created the gap that was missing between the idea and the players.

## An example

The sequence below is **illustrative**, with plausible names and messages, showing the flow that would solve the Saturday-night scene:

```bash
git init
git add .
git commit -m "First version of the kits and combat plugins"

# days later, that "little thing"
git commit -am "Kits: increase soups in the starter kit and change cooldown"

# combat stops applying damage
git log --oneline
# a3f9c21 Kits: increase soups in the starter kit and change cooldown
# 7b1e044 Combat: fix knockback in HG mode
# 2c88d10 First version of the kits and combat plugins

git diff 7b1e044 a3f9c21    # shows exactly what changed
git revert a3f9c21          # undoes the change, keeping the history
```

Instead of trying to remember what was touched, `git log` shows the last change and `git diff` shows the responsible line. In the example, changing the cooldown landed on a shared setting that the combat plugin also read.

The difference, in time:

| Situation | Without Git | With Git |
| --- | --- | --- |
| Finding what changed | Remembering from memory, in a hurry | `git log` and `git diff`, seconds |
| Returning to the good state | Undo by hand and hope | `git revert`, seconds |
| Investigating the cause | In a hurry, on the server | With the server up, no rush |
| Understanding a decision months later | Impossible | Read the commit message |

`revert` creates a new commit that undoes the previous one, instead of erasing history. For me that mattered: I wanted to remember that the change had caused trouble, so I wouldn't take the same path the following week.

## Result

Every version that went to the server now had a history, and going back to the previous one took seconds. The bigger gain was psychological: with a reliable history, changing code stopped being scary, because undoing was cheap. That made me bolder with changes and more careful with deliveries at the same time.

I also learned the value of a clean history. A message like "tweaks" or "test" is useless a month later. A message that says what changed and why is free documentation.

## What I take from it

Version from the first line, even on a small, one-person project. The cost at the start is nearly zero, and the day a change misbehaves is exactly the day the history pays the whole bill.

And separate the place where you tinker from the place where people use it. I learned this on a homemade server. Today the same principle shows up in staging environments, code review and deploys, but the root is the same: production is no place for experiments.
