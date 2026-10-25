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

Never write `fp` or `verified` by hand — `stamp` owns them.

## Writing a new flow

0. **First flow in a repo?** Create `.flowbook/flows/` at the repository root.
1. **Pick one scenario** with a clear trigger and end: "Server startup", "Packet handling",
   "Config reload". Not "the networking module". Choose a kebab-case id; the file is
   `.flowbook/flows/<id>.jsonl`.
2. **Read the code path** end to end before writing. Follow the real calls, including
   callbacks, function pointers, virtual dispatch and thread hand-offs.
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

## Example

See [references/example.jsonl](references/example.jsonl) for a complete, valid flow with a
loop, an alt block, a callback and a return step.
