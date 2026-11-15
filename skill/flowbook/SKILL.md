---
name: flowbook
description: Create or update Flowbook flow diagrams — JSONL files under `.flowbook/` that document how a C/C++ codebase works as named scenarios (nodes = functions, steps = calls in order). Use when asked to document, diagram or explain a code path, flow, subsystem or scenario with Flowbook, or to fix stale Flowbook flows.
---

# Flowbook

Flowbook diagrams live in the repository they describe, so they are reviewed, diffed and
versioned with the code. Humans read them in the Flowbook VS Code extension; you write them.

```
.flowbook/
  config.jsonl          optional: named components (groups) for paths
  flows/<flow-id>.jsonl one scenario per file
  connections.jsonl     optional: rules and connections for queues, events, timers, callbacks
```

The full record reference is in [references/schema.md](references/schema.md). Read it before
writing your first flow in a session.

## The CLI is your feedback loop

Run it from the repository root (or anywhere below a directory containing `.flowbook/`); all
anchor paths are relative to the directory that contains `.flowbook/`. If `flowbook` is not on PATH, ask the user where the
Flowbook CLI is installed (e.g. `node /path/to/flowbook/packages/cli/dist/flowbook.js`).

| Command                            | Use it to                                                          |
| ---------------------------------- | ------------------------------------------------------------------ |
| `flowbook resolve <file>`          | list every definition in a file as a ready-to-paste `anchor`       |
| `flowbook resolve <file> <symbol>` | check one anchor; suggests qualified names and overload `sig`s     |
| `flowbook check`                   | validate schema, references and anchors (exit 1 on errors)         |
| `flowbook stamp <flow-id>`         | record each node's code fingerprint + commit after you verified it |
| `flowbook stale`                   | list nodes whose code changed since they were stamped              |
| `flowbook sites [--rule <id>]`     | list send/receive sites found by the rules and what they pair to   |

Never write `fp` or `verified` by hand — `stamp` owns them.

## Writing a new flow

0. **First flow in a repo?** Create `.flowbook/flows/` at the repository root.
1. **Pick one scenario** with a clear trigger and end: "Server startup", "Packet handling",
   "Config reload". Not "the networking module". Choose a kebab-case id; the file is
   `.flowbook/flows/<id>.jsonl`.
2. **Read the code path** end to end before writing. Follow the real calls, including
   callbacks, function pointers, virtual dispatch and thread hand-offs. Use any code-navigation
   tools you have (LSP, call-graph or code-graph tools) to find callers and callees, then confirm
   each step in the source.
3. **Get exact anchors** with `flowbook resolve <file>` for each file you touch. Copy the anchor
   JSON as printed: it includes `sig` only when the name is overloaded. Anchor to the
   _definition_ (the `.cpp` for out-of-line methods, the header for inline ones/templates).
4. **Write the file** in this order: one `flow` record, then `node`s in scenario order, then
   `step`s by `seq`, then `block`s. One JSON object per line, no trailing commas, no comments.
5. **Validate**: `flowbook check`. Fix every error; warnings about unstamped nodes are expected.
6. **Stamp**: `flowbook stamp <flow-id>`, then `flowbook check` again — it should be clean.

## Updating stale flows

`flowbook stale` (or the extension's "Copy agent prompt") tells you which nodes changed. For each:
re-read the code, update the node's `title`/`notes` and any steps whose behaviour changed (add,
remove, renumber), fix anchors that moved or were renamed, then `check` and `stamp <flow-id>`.
Stamping says "I verified this flow matches the code" — only stamp what you actually reviewed.

## What makes a good flow

- **Small**: about 5–15 nodes. When a node hides a substantial sub-story, give it its own flow
  and link it with the node's `"flow": "<other-id>"` (drill-down) instead of inlining it.
- **Labels explain intent**, not names: `"reject negative fd"`, not `"call helper"`. The callee is
  already visible on the arrow's target.
- **Titles are human**: node `title` is what it does ("Parse packet"); the anchor carries the symbol.
- **Notes carry the non-obvious**: invariants, ownership, threading, error handling, gotchas.
  Markdown is fine. Skip notes that would just restate the code.
- **Step types**: `call` (default), `return` (only when the returned value matters to the
  story), `async` (queued/posted work, other thread), `callback` (invoked through a registered
  pointer/handler), `signal` (signals, interrupts, events).
- **Branches**: put alternatives in an `alt` block with a `guard` on each step; alternatives in
  the same `alt` may share a `seq`. Repetition → `loop` block; concurrency → `par` block. Blocks
  may nest but must not partially overlap.
- **Multi-step branches**: every step of a branch goes in the `alt` block and carries that
  branch's `guard` (e.g. three steps with `"guard":"C function"`, two with `"guard":"Lua
function"`). For an optional branch, use an `alt` block with a single guarded branch. A
  `guard` outside any block is fine for a one-off conditional step.
- **Self-steps** (`from` = `to`) express recursion, retries or re-entry (`goto` back to the top).
- **What to anchor**: anchor definitions with bodies — functions, methods, function-like
  macros, classes/structs. When a public macro just forwards to a function (e.g.
  `luaL_loadfile` → `luaL_loadfilex`), anchor the function that holds the logic and mention the
  macro in the title or notes. Code _inside_ a function (a `switch` case, a VM opcode handler,
  a lambda) is anchored to the enclosing function; name the case in the title and notes, e.g.
  title `"OP_CALL handler"` on an anchor to `luaV_execute`. Enum constants, variables and
  declarations without bodies cannot be anchored.
- **Preprocessor variants**: a function defined in several `#if` branches is one symbol; its
  fingerprint covers all branches.
- **External actors** (kernel, database, network peer, user) are nodes without `anchor`.
- **Reuse nodes**: the same function appears once per flow; across flows, use the same anchor so
  the extension can link them ("also in other flows").
- **Groups**: diagrams group nodes by module ▸ folder ▸ file automatically. If the repo's
  components don't follow top-level folders, add `group` records to `.flowbook/config.jsonl`
  (first matching glob wins).

## Connections

Code often hands work over without a direct call: a job is posted to a queue and a `switch` in
another task handles it, a callback is stored in a struct and invoked later, a timer fires a
handler. A flow step can show that hop, but the reader also wants to jump from the sending line
to the code that reacts. Flowbook finds those hops from **rules** and lets you pin them down
with **connections**, both in `.flowbook/connections.jsonl` (full reference in
[references/schema.md](references/schema.md)). Neither carries line numbers or fingerprints.

- A **rule** describes a mechanism: which calls/fields/cases are the _send_ side and which are the
  _receive_ side. Flowbook scans the whole repository for them; each hit is a **site**.
- A **connection** names a pairing the scan derived (keyed) or joins send and receive functions
  the scan cannot link by itself (anchored).

### The loop

1. Find the mechanism's post function (where work is queued) and its dispatch point (the
   `switch`, the fetch loop, the field the callback is stored in). Read both.
2. Write a `rule` line (matcher names are regular expressions matching the whole name;
   argument positions are 1-based).
3. Run `flowbook sites --rule <id>`. Every send and receive site is listed with its reactors.
   Fix the rule until exactly the right sites appear (too few: loosen the name or `files`;
   too many: narrow it).
4. Add a keyed `connection` for each key you verified, and an anchored one for a plain queue
   with no key. A reactor marked `?` is unconfirmed; a keyed connection confirms it.
5. Run `flowbook check`. Errors name the record's line in `connections.jsonl`.

### Three shapes (from `fixtures/cpp-sample`)

**Keyed queue.** `job_post(&job, JOB_READ_CNF, read_done)` sends; `case JOB_READ_CNF:` in
`rt_main` receives. The key is argument 2, the handler argument 3:

```json
{"kind":"rule","id":"job","title":"Job queue","type":"queue","context":"rt main task","send":[{"call":"job_post","key":2,"handler":3}],"receive":[{"case":"JOB_.*"}]}
{"kind":"connection","id":"read-cnf","rule":"job","key":"JOB_READ_CNF","title":"Read confirmation"}
```

`flowbook sites --rule job` prints
`src/rt/jobs.c:16: job send JOB_READ_CNF → rt_main (case JOB_READ_CNF), read_done`.

**Handler only (timer).** The send names its handler, so no receive matcher is needed:

```json
{
  "kind": "rule",
  "id": "timer",
  "title": "Timer",
  "type": "timer",
  "send": [{ "call": "timer_add", "handler": 2 }]
}
```

**Callback field.** `cfg->state_cb(1)` sends; `.state_cb = app_state` or `app.data_cb = app_data`
receives. The field name is the key and the assigned function the handler:

```json
{
  "kind": "rule",
  "id": "app-cb",
  "title": "Application callback",
  "type": "callback",
  "send": [{ "invoke": ".*_cb" }],
  "receive": [{ "assign": ".*_cb", "as": "handler" }]
}
```

**Plain queue, no key.** `mbox_post` and `mbox_fetch` carry no key, so pair the functions:

```json
{"kind":"rule","id":"mbox","title":"Mailbox","type":"queue","send":[{"call":"mbox_post"}],"receive":[{"call":"mbox_fetch"}]}
{"kind":"connection","id":"main-box","rule":"mbox","title":"Main mailbox","send":[{"file":"src/rt/jobs.c","symbol":"job_post"}],"receive":[{"file":"src/rt/jobs.c","symbol":"rt_main"}]}
```

Reading the output: `→ unpaired` means nothing reacts to that site (check the rule, or add a
connection); `← 1 sender` is a receive site that something posts to.

### Known limits

- A handler passed through a variable is not followed; the site is reported with an unresolved
  handler.
- When a constant is set on one line and the block is posted on another, the editor lens is on
  the line where the constant appears.
- Two unrelated struct fields with the same name match the same `invoke` or `assign` matcher.
  `files` narrows it; otherwise the pairings are simply unconfirmed candidates.

## Example

See [references/example.jsonl](references/example.jsonl) for a complete, valid flow with a
loop, an alt block, a callback and a return step.
