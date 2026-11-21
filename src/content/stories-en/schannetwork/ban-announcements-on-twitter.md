---
title: Every ban became a tweet on @SchanBan
summary: "Banned players came back with another account claiming they were punished for nothing. I wired the server's bans to Twitter so every punishment was published on a public account, in my first integration with an external API."
project: schannetwork
order: 3
tags: [Twitter API, OAuth 1.0a, Java, API integration, Bukkit]
---

Every Minecraft server has the same scene: a player gets banned, opens another account and goes to the chat swearing it was unfair, that the staff is picking on them, that they've never cheated in their life. Players who play clean are left not knowing whether moderation really acts. On SchanNetwork I solved this in a way that was fairly bold for a kid: every ban started being published automatically on a public Twitter account, @SchanBan. Moderation left the game and went out onto the internet.

## The problem

I wanted transparency without depending on someone remembering to post. Banning someone was already a command inside the game. What was missing was making that command tell the outside world, on its own, every time.

In theory it was "just send a tweet". In practice it was my first integration with a third-party API, and I didn't even know where to start.

## Why it wasn't trivial

The Twitter API didn't accept a username and password. It used **OAuth 1.0a**, a protocol in which the application receives its own credentials (an app key pair and an account token pair) and **signs** each request with them. Twitter's server recalculates the signature and, if it matches, accepts the call as if it were the account. The password never travels.

Understanding signatures without ever having done an integration was the first wall. Any detail out of place (parameter order, the encoding of one character, the machine's clock running ahead) turned into a "401 Unauthorized" with no further explanation.

The second wall was subtler. A Minecraft server runs everything that matters on a main thread. If I called the API inside the ban command and Twitter took a while to respond, the entire server would freeze waiting for a tweet. Nobody wants lag because someone was banned.

## The solution

### Understanding the signature before using a library

I read the OAuth documentation until I understood what was being signed and why. Reimplementing cryptography is never the idea, but knowing what happens underneath is what let me debug authentication errors instead of guessing.

### Getting the call out of the game's path

The ban happens first, right away, inside the server. The publishing goes to an asynchronous task, off the main thread. If Twitter is slow or down, the player stays banned and the server keeps running. The tweet is a complement, never a condition.

### Keeping credentials as credentials

This is where it clicked: whoever has these keys posts as the account. They can't end up in the repository or inside a `.jar` that circulates around, and treating secrets as secrets became a habit from this integration onward.

## An example

The names and values below are **illustrative**. First, what happens in a call signed with OAuth 1.0a, as a timeline:

```text
t=0     staff runs /ban player123 "autoclick usage"
t=1ms   server applies the ban and kicks the player (main thread)
t=2ms   async task builds the tweet text
t=3ms   generates oauth_nonce (random) and oauth_timestamp (now, in seconds)
t=4ms   builds the base string: POST & encoded url & sorted parameters
t=5ms   signs with HMAC-SHA1 using "consumer_secret&token_secret"
t=6ms   sends POST with header Authorization: OAuth ..., oauth_signature=...
t=350ms Twitter recalculates the signature, checks nonce and timestamp, publishes
```

The `nonce` and the `timestamp` exist to stop someone from capturing the request and replaying it later. That's why a wrong clock on the machine was enough to break authentication, and I learned that in the most confusing way possible.

Now the game side, also illustrative:

```java
public void ban(Player target, String reason) {
    target.kickPlayer("You have been banned: " + reason);
    banStorage.save(target.getUniqueId(), reason);

    // the tweet runs off the main thread: a slow Twitter can't freeze the server
    Bukkit.getScheduler().runTaskAsynchronously(plugin, () -> {
        try {
            twitter.updateStatus(target.getName() + " was banned. Reason: " + reason);
        } catch (Exception e) {
            plugin.getLogger().warning("Failed to publish ban: " + e.getMessage());
        }
    });
}
```

The order is the whole decision: first the action that matters, then the notice, and a failed notice becomes a log line, not a stalled server.

## Result

@SchanBan became a talking point in the community. Players followed it, commented on it and, above all, saw that moderation existed. It's much harder to say "I was banned for nothing" when the reason is published.

Technically, it was the first time I dealt with real authentication, credentials, rate limits and a service that sometimes responds differently from what the documentation promises. I learned to read API documentation carefully, because every detail I skipped came back as a 401.

## What I take from it

An external integration never goes on the critical path of the main operation. The user's action happens first, the outside notice comes after, and a failed notice is handled without undoing the action. This pattern shows up in every system that publishes events, sends email or calls a webhook, and I learned it from a ban bot.

And understanding the protocol before trusting the library saves hours. When authentication fails, whoever knows what is being signed debugs it in minutes. Whoever doesn't keeps changing settings in the dark.
