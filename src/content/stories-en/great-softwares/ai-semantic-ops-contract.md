---
title: "AI editing through operations: the model says what to change, it doesn't rewrite"
summary: "Asking the model for a whole element back lets the AI make up colors, delete attributes and charge for edits that change nothing. I designed editing so the model only says what to change, using the brand's colors, and the server refuses without charging a request that leaves everything the same."
project: great-softwares
order: 3
tags: [LLM, AI editing, API contracts, Usage-based billing, Zod]
---

Someone selects a button in the Great Pages editor and types "make this border rounded and use the brand's main color". On the other side, a language model receives the request. The shortest way to implement this is to send the element's HTML and ask for a new element back. It works in the demo and fails in real use: the model invents a hex code close to the brand color, deletes an attribute it didn't understand and, when the button was already rounded, charges credits for an edit that changed nothing.

## The problem

I wanted three things at once. For the model to say only what to change, in terms the product understands. For colors and sizes to come from the page's design system, not from a guess. And for the person not to pay for a request that leaves the element the same.

## Why it wasn't trivial

- **The model's output is untrusted input.** An operation's name comes from the model. If I validate with `catalog[name]` on a plain object, a name like `toString` finds the function inherited from `Object.prototype` and passes as if it existed.
- **The editor and the backend are deployed separately** and share the operation catalog by file copy. If one side ships a new version and the other doesn't, the protocol silently diverges.
- **Charging fairly requires knowing the element's current state**, and deciding that in the wrong place leaves room to charge for a useless edit or fail to charge for a real one.
- **The cost of a call varies with tokens**, but the person sees a price in credits and expects predictability.

## The solution

### A closed catalog of operations

The model stopped emitting elements and started emitting operations from a catalog with a few dozen items: background color by style guide slot, border preset, shadow, size, position, create element and so on. Each operation declares which element types it applies to, its scope and its arguments, validated by schema.

The prompt describes the element in the vocabulary of operations, never in raw DOM. The style guide comes in with an explicit rule: if the requested color doesn't exist in the brand, the operation is refused with an unknown-slot error, instead of inventing a value. When the prompt's character budget gets tight, the guide loses color lines and the text says how many were omitted. Cutting silently would make the model conclude the color "doesn't exist".

The catalog is built with `Object.create(null)`, an object with no prototype. A name that isn't there is always refused.

### Contract hash between the two repositories

Both sides compute an FNV-1a hash (a fast, deterministic non-cryptographic hash) over the contract's surface: version and, per operation, accepted types, scope and arguments. Descriptions and help texts are left out on purpose. If the text went into the hash, fixing a comma in a description would bring the protocol down until both deploys went out together.

The editor sends the hash with every request. If it doesn't match, the service falls back to the old editing path, instead of applying operations the other side might not recognize.

### A simulator before charging

For each operation there's a reader that looks at the element's current state on the server and returns one of three verdicts: changes, already satisfied (inert) or unreadable. If the whole batch is inert, the response is "the element is already like this" and nothing is charged.

The rule guiding all the readers is asymmetric: the only expensive mistake is saying "inert" about something that would change, because then the person asks for something and nothing happens. So any doubt falls into unreadable, which proceeds and charges.

### Predictable pricing

The cost of an edit now comes from the tokens consumed, rounded up to a multiple of 5 credits. The person sees round numbers and the price tracks the real work.

## An example

The button already has a rounded border from the guide's `rounded-lg` preset. The person asks to "round the border". The model responds with an operation:

```ts
type Verdict = { kind: 'changes' } | { kind: 'inert'; reason: string } | { kind: 'unreadable' };

type Op = { op: 'set_border_preset'; preset: string } | { op: 'set_border_radius_px'; px: number };

function simulate(op: Op, el: { borderPreset: string | null; radiusPx: number | null }): Verdict {
  if (op.op === 'set_border_preset') {
    if (el.borderPreset === op.preset) return { kind: 'inert', reason: `the "${op.preset}" preset is already applied` };
    return { kind: 'changes' };
  }
  // A literal px on top of a preset detaches the element from the guide: that is a real change.
  if (el.borderPreset !== null) return { kind: 'changes' };
  if (el.radiusPx === null) return { kind: 'unreadable' };
  return el.radiusPx === op.px ? { kind: 'inert', reason: 'the radius is already this' } : { kind: 'changes' };
}
```

With `{ op: 'set_border_preset', preset: 'rounded-lg' }`, the verdict is inert and the request comes back as "the element is already like this", with no debit. With `{ op: 'set_border_radius_px', px: 12 }`, the verdict is changes, even if visually the result looks similar: swapping the preset for a fixed value makes the button stop following the theme when the brand changes.

An implementation detail shows the kind of care the reader requires. To read an image's adjustments, the reader strips `drop-shadow(...)` from the filter. A regular expression that stops at the first `)` gets it wrong when that parenthesis closes an inner `rgba(...)`: one parenthesis is left over, reading fails and the verdict becomes unreadable instead of inert. That's why the removal is a scan that counts parenthesis depth, not a regex.

## Result

The AI now changes what the person asked for using the page's design system values, and a request that changes nothing is refused before billing. When the editor and the backend diverge on the catalog, the system falls back to a known path instead of applying half an edit. The prompt also got more useful on mixed requests: the possible part is applied and the rest is explained, instead of refusing everything.

## What I take from it

When two repositories share a contract by copy, put a hash on the contract, but only over what changes behavior. In anything involving billing, choose in advance which way doubt falls, and write that in the code. I'd rather charge for a doubtful edit and improve the reader later than deny a real edit.
