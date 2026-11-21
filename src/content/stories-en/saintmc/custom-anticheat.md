---
title: An anticheat that gave the staff one minute to disagree
summary: "Autoclick and instant-heal cheats were driving good players away, and the staff couldn't be in every room. I wrote a custom anticheat that alerts the staff with context and bans automatically if nobody disagrees within a minute."
project: saintmc
order: 6
tags: [Anticheat, ProtocolLib, Bukkit, Fraud detection, Java]
---

End of a KitPvP match. Two players, both low on health, trading blows. One of them seems immortal: every time his health drops, it comes back full before the next hit lands. In the chat, the loser types "autosoup" and leaves the server. In a competitive network, every scene like that is one good player fewer, because nobody stays where they lose to someone who cheats.

## The problem

KitPvP and Hardcore Games (a survival match mode where every round starts on a fresh map) of that era revolved around two things: clicking fast and drinking soup. In that Minecraft version, mushroom stew heals instantly, so a skilled player alternates between hitting and "souping" as fast as possible. That was exactly what the cheats automated:

- **Autoclick and macro:** programs that click for you, at a frequency nobody can sustain.
- **Autosoup:** the modified client moves the soup from the inventory to the hand and consumes it right away, with no human interval.
- **Reach and hitbox:** landing hits from farther than the game allows, or enlarging the area of the opponent that counts as a hit.
- **Full cheat clients**, which bundle all of this into a single program.

Manual moderation didn't solve it. The staff wasn't in every room, and the cheaters knew it. I also didn't want to depend on a closed commercial anticheat, which I couldn't tune to the specific rhythm of the network's PvP.

## Why it wasn't trivial

Detecting cheating is, first of all, a false-positive problem. A player with high ping looks like they're hitting from far away. A really good player looks like they're using autoclick. Banning an honest player costs more than letting a cheater slip by for a few more matches: they tell their friends, and trust in the network drops.

And all the checks run on hot events, like movement, click and damage, which fire dozens of times per second per player. Any heavy computation there would turn into lag for the whole room.

## The solution

### One check per cheat, small and isolated

Each type of cheat became a small class that listens only to the events it needs to measure and fires an alert when a limit is exceeded. The main checks:

- **Autoclick.** Listens to the arm-swing animation packet through ProtocolLib (a library that gives access to the game's network packets) and counts clicks per second. Above two dozen per second, sustained, it alerts. It ignores players with high ping, in creative mode or breaking blocks, because in those cases fast clicking is legitimate.
- **Macro.** Counts inventory clicks per second, not counting shift-click, which is normal use.
- **Autosoup.** Records the instant the soup was moved to the hand and compares it with the instant it was consumed, only when health isn't full.
- **Reach and hitbox.** Calculate the distance between the attacker's eyes and the target and compare it with a maximum reach that grows with angle, speed and height difference. Hits with high ping on either side are discarded. For hitbox, they test whether the attacker's line of sight actually crosses the target's box.
- **Known cheat client.** A popular client of the time announced itself on a characteristic plugin channel. The server listened to that channel and sent a message that only the client recognized. If the channel answered, there was no doubt.

### Alerts with context

Each alert went to staff members who had the permission and had turned the anticheat on, in the format "player is using X (n of max)", with details (clicks per second, distance, ping) in a hover text in the chat. The alerts also went up to the proxy, so staff in another room could follow along.

### Automatic ban with a window to intervene

Each type of cheat had a maximum number of alerts and a punishment duration. On reaching the maximum, the player entered a ban queue with a countdown, and the staff received warnings during the countdown to check up close and cancel if it was a mistake. If the player left the server before the end, the ban was applied immediately, so nobody could escape by logging out. The punishment was requested from the proxy, which applied it across the whole network.

## An example

The autosoup check is the most didactic, because it measures something no human can do. A simplified version with generic names:

```java
public class AutoSoupCheck implements Listener {

    private static final long MIN_HUMAN_INTERVAL_MS = 2;
    private final Map<UUID, Long> soupMovedAt = new HashMap<>();

    @EventHandler
    public void onShiftClickSoup(InventoryClickEvent event) {
        if (event.getAction() != InventoryAction.MOVE_TO_OTHER_INVENTORY) return;
        if (!isSoup(event.getCurrentItem())) return;
        soupMovedAt.put(event.getWhoClicked().getUniqueId(), System.currentTimeMillis());
    }

    @EventHandler
    public void onDrinkSoup(PlayerInteractEvent event) {
        Player player = event.getPlayer();
        if (!isSoup(event.getItem()) || player.getHealth() >= player.getMaxHealth()) return;

        Long movedAt = soupMovedAt.remove(player.getUniqueId());
        if (movedAt == null) return;

        // moving and consuming at the same instant only happens when a program does it for you
        if (System.currentTimeMillis() - movedAt <= MIN_HUMAN_INTERVAL_MS) {
            alerts.raise(player, AlertType.AUTOSOUP);
        }
    }
}
```

The difference between a fast player and a modified client, with illustrative timings:

| Moment | Skilled player | Client with autosoup |
| --- | --- | --- |
| Moves the soup to the hand | t=0 ms | t=0 ms |
| Switches slot and aims | t=120 ms | not needed |
| Consumes the soup | t=180 ms | t=1 ms |
| Check result | nothing | alert |

And the fate of whoever accumulates alerts:

| Time | Event |
| --- | --- |
| t=0 s | Player hits the maximum alerts, enters the ban queue |
| during the countdown | Staff receives warnings with the remaining time and can watch and cancel |
| countdown ends | Ban requested from the proxy and applied across the network |
| if they leave early | Ban applied at the moment of leaving |

## Result

The most common cheats started being detected and punished without depending on someone from the staff being in the right room at the right time. The staff stopped hunting and started reviewing: they received the alert with context, looked at the player and decided, with the automatic ban as the default if nobody disagreed. Not every check I wrote stayed active in the network's final version. I didn't keep statistics on bans or false positives to cite.

## What I take from it

A detection system without context turns into noise, and noise makes people stop looking. Every alert has to say what was measured and by how much. Automating the punishment while giving a human a window to disagree combined scale with common sense. I take this to any fraud or monitoring rule: measure one objective thing, show the number and leave room for review.
