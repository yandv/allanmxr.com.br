---
title: "Choose the protocol before searching the passage: router and hybrid search"
summary: "In a clinical question, the case brings diseases the question doesn't ask about, and a search that looks at everything tends to pick the wrong protocol. I separated choosing the document from searching the passages, and the engine cites the protocol the question asks for."
project: salte
order: 19
tags: [Cloudflare D1, SQLite FTS5, Hybrid search, Embeddings, RAG]
---

A healthcare professional asks: "what's the blood pressure target for this patient?". The case context has a 68-year-old patient, type 2 diabetes, chronic kidney disease and a list of medications. The question is about hypertension. If the search in Salte's clinical evidence engine looked at all of that, it could come back with passages from the diabetes protocol, properly cited but from the wrong source. That was the case the retrieval had to get right by design.

## The problem

To cite the right protocol, the engine first has to find it. The question arrives in natural language, mixed in with the patient's case. If the search considers all of the case's diseases, it returns the document that best matches the whole set, not the one that answers the question. In the evals, the questions with a rich clinical case were precisely the ones that pulled the search most toward the neighboring protocol.

## Why it wasn't trivial

The corpus lives in Cloudflare D1, which is managed SQLite. I had FTS5 (SQLite's full-text index, which ranks by bm25, a classic term-based relevance measure). And I had three difficulties.

The first was vocabulary. The PCDTs (Protocolos Clínicos e Diretrizes Terapêuticas, the official SUS clinical protocols and therapeutic guidelines for each disease; SUS is Brazil's public health system) almost never write "conduta" or "manejo" (management). They write "tratamento" (treatment) and "abordagem terapêutica" (therapeutic approach). And a generic word like "tratamento" appears in nearly every passage, which flattens bm25. The protocol's core course of action ended up outside the top positions.

The second was the router. The model that interprets the question tended to throw the patient's diseases into the search terms.

The third was accents. Someone typing on a phone writes "hipertensao". The document says "Hipertensão".

## The solution

I split the problem into three layers, each doing the minimum.

### A router with a narrow vocabulary

A model classifies the question (course of action, drug, calculation or coding) and extracts the condition and the requested aspects. Two tweaks made a difference.

First, the condition is only the disease the current question asks about, never the other diseases described in the case. The router doesn't even see the patient data: it only sees whether it exists.

Second, the closed list of aspects is the vocabulary protocols use as section titles: treatment, target, criteria, monitoring, discontinuation. When the list was too generous, terms like "dose" and "adjustment" pulled the question to the wrong place. Less vocabulary, less invention.

### Choose the document without a model

The document comes from a normalized alias (lowercase, no accents, whole word) mentioned in the question or the condition. An alias that is part of another found alias counts for less. That way, "hipertensão" doesn't pull the arterial hypertension protocol when the question says "hipertensão pulmonar" (pulmonary hypertension). If the question names a protocol that no current document has, the engine abstains instead of searching another one.

### Full text plus vector

Inside the chosen document, FTS5 returns a pool of 40 passages ranked by bm25, with more weight on the section title than on the body. If the pool has more than 8, an embedding of the question reorders the passages by cosine similarity and the top 8 stay. bm25 finds the vocabulary. The vector recovers the core course of action that the generic word was hiding.

### Choose the tokenizer by test

Instead of choosing the FTS5 configuration by opinion, I wrote a test that creates temporary tables with each tokenizer and measures what matters for my case. I ran it on local D1 and repeated it on remote.

## An example

The tokenizer test is short. This is a simplified version:

```ts
const cases = [
  { tokenizer: 'unicode61 remove_diacritics 2', query: 'hipertensao', expected: 1 },
  { tokenizer: 'trigram', query: 'hipertensao', expected: 0 },
  { tokenizer: 'trigram', query: 'perten', expected: 1 },
  { tokenizer: 'trigram remove_diacritics 1', query: 'hipertensao', expected: 1 },
];

for (const { tokenizer, query, expected } of cases) {
  const table = `probe_${crypto.randomUUID().replaceAll('-', '')}`;
  await db.exec(`CREATE VIRTUAL TABLE ${table} USING fts5(body, tokenize = '${tokenizer}')`);
  await db.prepare(`INSERT INTO ${table} (body) VALUES (?)`).bind('Hipertensão arterial').run();
  const { results } = await db.prepare(`SELECT rowid FROM ${table} WHERE ${table} MATCH ?`).bind(query).all();
  expect(results.length).toBe(expected);
  await db.exec(`DROP TABLE ${table}`);
}
```

The result became this table:

| Tokenizer | Matches without accent | Matches substring |
| --- | --- | --- |
| `unicode61 remove_diacritics 2` | yes | no |
| `trigram` | no | yes |
| `trigram remove_diacritics 1` | yes | yes |

I chose `unicode61 remove_diacritics 2`. The search is by whole word, and a trigram index would be larger without bringing real gain for clinical questions.

Back to the opening question, the path through the three layers looked like this:

| Step | Input | Output |
| --- | --- | --- |
| Router | "what's the blood pressure target for this patient?" | type: course of action; condition: hypertension; aspect: target |
| Alias | "hipertensão" | arterial hypertension protocol |
| FTS5 | condition + aspect | 40 passages by bm25 |
| Vector | question embedding | 8 passages, with the targets section on top |

Diabetes and kidney disease stay in the case, and the answer generator can take them into account. They just no longer decide which document gets read.

The test also revealed a gotcha in remote D1: creating the virtual table together with other statements in a single command-line call failed. Each statement now goes separately.

## Result

Retrieval became deterministic where it can be (choosing the document) and semantic only where it helps (the final order of the passages). The engine cites the protocol for the disease the question mentions, not for the neighboring diseases in the case. And the tokenizer choice isn't opinion: it's a test that keeps running and warns me if anything changes.

## What I take from it

Measure what the search engine does with your data before choosing the configuration. Limit what the router sees: the less irrelevant context, the less it makes things up. And don't ask a model to decide what an alias table decides better.
