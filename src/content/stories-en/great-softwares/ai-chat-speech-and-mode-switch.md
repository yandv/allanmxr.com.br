---
title: "Holding back, mid-stream, the assistant's speech that only narrates behind-the-scenes work"
summary: "An assistant that works by calling tools tends to narrate backstage work, repeat sentences and run destructive switches without asking. I made the chat filter that narration as the response streams in and require confirmation, in code, before any switch that deletes content."
project: great-softwares
order: 4
tags: [LLM, AI agents, Streaming, Tool calling, Prompt engineering]
---

Imagine someone opening the editor chat and asking "turn this page into a blog". The response starts to appear on screen: "I'll note down your preferences before starting." A pause. "I'll note down your preferences before starting. Done, now I'll transform the page." The first sentence is about an internal memory tool the person should never have to see, and it even comes out twice. Or someone asks to turn a presentation back into a regular page, and the assistant does it on the spot, discarding the slides without asking. Those were the two behaviors the chat's design had to prevent.

## The problem

The Great Pages editor chat creates and changes pages by calling tools: write to the session memory, edit blocks, change the page type, ask the person a question, close with a summary. Two model behaviors needed handling.

The first was about speech. The model announced in text the call to silent tools (those whose effect the person doesn't need to follow) and, when resuming, repeated the same opening. A sentence like "Here's the summary:" came out glued to the final message that came right after, saying the same thing.

The second was about action. The tool that turns the page into a blog, quiz or presentation, or back into a regular page, sometimes destroys content. Nothing stopped the model from calling it without asking.

## Why it wasn't trivial

- **The response arrives as a stream.** By the time I find out the text was only a backstage announcement, part of it has already gone to the screen. You can't unsay it.
- **The information arrives in the wrong order.** The text comes before the tool call. Only at the end of the response do I know whether that sentence was real speech or narration of something silent.
- **A rule in the prompt is a request, not a guarantee.** The model only has to get it wrong once for an entire blog to vanish.
- **Some conditions are only known to the server**, such as whether the account has the sites feature enabled. The client isn't a trustworthy source for that.

## The solution

### Hold short speech until we know what it is

For the human audience, the agent engine holds the start of each response in a buffer until the first line break appears or it goes past 280 characters. A long or multi-line response is real speech and flows normally. If the provider signals a tool that isn't silent, the buffer is also released immediately.

If the response ends with nothing but silent calls, the held text goes to a waiting area:

- if the next response brings text, the held text is discarded, because it was backstage chatter or the same speech rewritten;
- if it doesn't, the held text comes out in its place;
- if the loop ends, it's released before the closing, and on a cancel it's discarded without appearing.

The first version held too much and stalled the streaming of normal responses. I restricted the hold to short one-line notices, and speech that already reached the screen is never pulled back. Held text also never goes to logs: I only record how many characters, and whether it was held, released or discarded.

For the announcement glued to the final message, the rule is deliberately narrow. If the response has a single call, to a tool that closes the turn with a filled-in message, and the held text ends in a colon, it's treated as an announcement and discarded. A complete sentence with no colon remains speech. For the repeated opening, I cut the duplicated prefix, always at a word boundary. Cutting mid-word produced broken sentences.

### A code-level lock for the destructive switch

The mode-switch tool receives the target mode and a strategy: transform the existing content or add alongside it. Before any write, it passes through refusals in a fixed order, all in code:

1. without server confirmation that the feature is enabled on the account, it doesn't switch, and the message distinguishes a momentary failure from a feature that wasn't purchased;
2. a presentation with the add-alongside strategy is refused, because the two don't coexist;
3. asking for the mode the page is already in gets a one-sentence reply;
4. switching to or from a presentation, or from blog to page, is destructive and requires confirmation.

Who decides whether the account has the feature is the server, which queries the account's feature list with the request's own authorization and caches the result for 5 minutes. The confirmation is a ready-made question, with a fixed identifier, and it only counts if the person's answer arrived after the refusal and after their last message. On a blog-to-page switch, the question is what to do with the articles, with "keep" as the recommended option.

## An example

Timeline of a turn in which the person asks to turn a presentation into a page:

| t | What happens | What the person sees |
|---|---|---|
| 0 ms | Model starts: "I'll record your preference" | nothing yet (buffer, one line, under 280 characters) |
| 400 ms | Response closes with only the memory call, which is silent | nothing (text goes to waiting) |
| 900 ms | Model calls the mode switch to page, transform strategy | nothing |
| 905 ms | Tool refuses: leaving a presentation is destructive | nothing |
| 1.2 s | Model replies with text and the ready-made question | "Turning this into a page will discard the slides. Do you want to continue?" |
| 1.2 s | Waiting text is discarded, because the new response brought speech | the sentence about preference never appears |
| 8 s | Person answers "yes" | their answer |
| 8.6 s | Model calls the switch again; the confirmation is later than the refusal and the last message | the page changes type |

If at the 8 s step the person had sent another message instead of answering, the old confirmation would no longer count and the switch would be refused again.

## Result

The chat talks about what matters and asks before destroying content. Backing out of a switch that already happened is just undoing back to before it. Every point has a test: holding, discarding, releasing at the end of the loop, refusals in the right order and the validity of the confirmation.

## What I take from it

Put the lock where the error is expensive, in the tool's code, and leave the prompt as guidance. In streaming, decide what to hold based on what you know before showing the first character, and keep that window small: holding too much ruins the experience you wanted to protect.
