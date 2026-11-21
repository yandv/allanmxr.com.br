---
title: When the corpus has no answer, an asynchronous search with a spending cap
summary: "Questions outside the clinical protocols ended in abstention, leaving the professional with nowhere to go. I made the system open a background search over open literature, with a spending cap and the same citation rules."
project: salte
order: 20
tags: [Cloudflare Workflows, LLM, RAG, Idempotency, AI cost]
---

A healthcare professional asks the clinical engine about a course of action that the official SUS protocols (SUS is Brazil's public health system) don't cover. The engine does the right thing: it says it has no source and doesn't answer. But "I don't know" on its own leaves the person stranded. In those cases, I wanted the system to say "I don't have this in the corpus, but I've opened a search over open-access articles and I'll let you know when it's done", without blocking the chat and without loosening any citation rule.

## The problem

The engine answers from a closed corpus of clinical protocols and drug labels. When the question falls outside it, abstention is the correct answer. But there's a band of questions where the open scientific literature has something to say: guidelines from medical societies, systematic reviews, consensus statements published under an open license.

The second attempt needed three guarantees. It couldn't block the conversation. It couldn't spend without limit on a language model. And it had to go through the same answer contract as the fast path, because an answer coming from an article can't have looser rules than one coming from a protocol.

## Why it wasn't trivial

Searching the literature takes tens of seconds: search, read, decide what to search next, read again. A regular HTTP request can't hold that. In Cloudflare Workers, `waitUntil` (the mechanism that lets work run after the response goes out) has a short deadline and keeps no state if something crashes midway.

There were also limits that aren't technical. Not every article can be read: the text needs a license that allows its use. Model spending needs a cap per item, not just per run, otherwise a single expensive item eats the others' budget. And drug dosages still come only from the drug label, even if an article cites one.

## The solution

### A Workflow instead of a request

I built the search as a Cloudflare Workflow, a durable execution engine: each step has native retries and each step's result is persisted. If the platform kills a long step, it runs again without redoing the previous ones. That fit well with the articles API, which returns 429 now and then: only the network steps retry, with exponential backoff. The Workflow status became the status the API exposes to the client: in progress, completed or failed.

### A planner with an action budget

Inside the Workflow runs a short loop. A low-cost planner picks one action per turn, between search and read, with at most 10 actions. Reading an article with an unknown or repeated id also counts as an action and comes back as an error observation, without going to the network. That way the planner has no way of looping.

Only articles with open-access full text and a compatible license get in. A missing or restrictive license refuses the read, and the action counts all the same. I preferred syntheses (guidelines, reviews, consensus statements) over primary studies, because a single study covers one outcome and one exposure window, and answering a course of action from it alone reassures by omission.

### Same generator, same contract

After the reads, an embedding model ranks the read passages against the question and the planner's queries. The top 8 go to the same generator and the same checks contract as the fast path. If the draft fails the contract, the search ends in abstention, as in the chat.

### Idempotency and isolation

The search only opens for an eligible abstention: a course-of-action question with no source to support the answer. The Workflow instance id is derived from the request id, so repeating the request doesn't open a second search. And the result lookup only answers for whoever opened it. Any other client gets the same "unknown search" error, without confirming the id exists.

## An example

The cap rule is the part I reviewed the most. The budget available for an item is the smaller of the item's cap and what's left of the whole run. Exploration (search and read) can only use half of that, and before generating the answer the spend is checked again. The code below is a simplified version of the idea, with generic names:

```ts
type Budget = { itemCap: number; runCap: number; runSpent: number };

function availableFor(budget: Budget): number {
  return Math.min(budget.itemCap, budget.runCap - budget.runSpent);
}

async function research(budget: Budget, ledger: CostLedger) {
  const limit = availableFor(budget);
  // exploring too much leaves the item with no money to generate the answer
  const exploreLimit = limit * 0.5;

  while (ledger.spent() < exploreLimit && planner.hasActionsLeft()) {
    await planner.nextAction();
  }

  // the ledger records even failed steps, so the bill is real
  if (ledger.spent() >= limit) {
    return abstain("ITEM_BUDGET_EXCEEDED");
  }
  return generateWithContract(await rankChunks(), ledger);
}
```

With made-up values: an item cap of 10 cents, a run cap of 1 real (R$ 1.00) and 95 cents already spent. What's available is `min(10, 5) = 5` cents. Exploration stops at 2.5 cents. If, because of retries, the spend reaches 5 before generation, the item ends in abstention without calling the generator. An expensive item doesn't eat the next one's budget.

The point that made me change the design: the spend comes from a cost ledger, not an estimate. An attempt that failed midway also cost money, and the ledger records that. Without it, every retry looked free and the cap lied.

## Result

I measured the prototype on the same evaluation set as the engine's other strategies. On the items that required abstention, it abstained on all of them. On the guideline items, it answered some of them with no critical error and far better numerical accuracy than a generator with no source. The price was undue abstention in some cases, and time: tens of seconds per item. That number confirmed the decision to keep the search out of the fast chat, as a task that notifies when it finishes.

## What I take from it

Any task that runs for more than a few seconds and spends money deserves three things: persisted state, idempotency by the request id, and a cap that applies to the whole and to each item. And the cap only works if the bill comes from what was actually spent, including the attempts that failed.
