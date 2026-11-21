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

| Command                            | Use it to                                                                  |
| ---------------------------------- | -------------------------------------------------------------------------- |
| `flowbook resolve <file>`          | list every definition in a file as a ready-to-paste `anchor`               |
| `flowbook resolve <file> <symbol>` | check one anchor; suggests qualified names and overload `sig`s             |
| `flowbook check`                   | validate schema, references and anchors (exit 1 on errors)                 |
| `flowbook stamp <flow-id>`         | record each node's code fingerprint + commit after you verified it         |
| `flowbook stale`                   | list nodes whose code changed since they were stamped                      |
| `flowbook sites [--rule <id>]`     | list send/receive sites found by the rules and what they pair to           |
| `flowbook sites --unpaired`        | only the sites with nothing on the other end or missing their receive site |
| `flowbook sites --json`            | the same as JSON for scripts; lines and columns are 1-based                |

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
  _receive_ side. Flowbook scans for them; each hit is a **site**.
- A **connection** confirms what you read: a dispatcher function and every key it handles
  (dispatcher), one pairing the scan derived (keyed), or send and receive functions the scan
  cannot link by itself (anchored).

The scan covers every C/C++ source file below the directory that contains `.flowbook/`. It skips
directories whose name starts with `.`, `node_modules`, `build`, `dist` and `out`, and symbolic
links to files or directories. Files larger than 2 MB, and files the parser fails on, are skipped
with a `warning: skipped <file>: <reason>` line on stderr.

### The loop

1. Find the mechanism's post function (where work is queued) and its dispatch point (the
   `switch`, the fetch loop, the field the callback is stored in). Read both.
2. Write a `rule` line (matcher names are regular expressions matching the whole name;
   argument positions are 1-based).
3. Run `flowbook sites --rule <id>`. Every send and receive site is listed with its reactors.
   If `connections.jsonl` has an error, `sites` prints it on stderr and exits 1. Fix it first:
   a rule with a mistyped field is not loaded at all, and a matcher with an invalid regular
   expression finds nothing.
   Fix the rule until exactly the right sites appear (too few: loosen the name or add a
   matcher; too many: narrow the name or add `files`). On a large codebase, read the summary
   line and `flowbook sites --unpaired` rather than the full list.
4. Confirm what you read. For each dispatcher function you read (the `switch` or the flag tests),
   add one **dispatcher** connection naming it (`receive` only); it confirms every key whose
   receive site lies in that function, including cases added there later. Add a **keyed**
   connection only to give a single pairing its own title or context, or for a key handled
   outside any dispatcher you read. Add an **anchored** one for a plain queue with no key. Do not
   write one keyed connection per key of a dispatcher. What each mark in the output asks of you is
   in "Reading the output" below.
5. Run `flowbook check`. Errors name the record's line in `connections.jsonl`. Its summary line
   counts flows only, so no error lines means the connections are valid too.
6. Explain what stays unpaired (in the rule's `notes` or the repository's docs): every
   remaining unpaired site should have a reason.

### Fitting rules to real code

- **`files`** sits on a matcher, not on the rule: `{"call":"event_set","key":1,"files":["src/rt/**"]}`.
  Globs are relative to the directory containing `.flowbook/`. Use it whenever a generic call
  (an OS event, mailbox or timer API) is also used by sample applications or other modules for
  their own purposes.
- **Wrappers (forwarding sites).** When a function passes its own parameter on as the key (or,
  without a key, as the handler), for example `job_post_typed(job_type_t type, job_cb_t done)`
  calling `job_post(&tick_job, type, done)`, the site inside it is a _forwarding_ site: `sites`
  prints `→ forwards parameter type (argument 1 of job_post_typed)` and counts it as
  `N forwarding`, not unpaired. The real keys are at the wrapper's callers, so add a send matcher
  for the wrapper with the argument positions of its own signature
  (`{"call":"job_post_typed","key":1,"handler":2}`). Until you do, `check` warns on the rule
  that the send site in `job_post_typed` forwards parameter `"type"` and ends with the matcher
  to add: `add {"call":"job_post_typed","key":1}` (add `handler` yourself when the wrapper
  forwards one too). Read the wrapper first; the hint is the matcher to add when it really is
  a wrapper.
- **Any matcher on either side.** A rule may have several send and receive matchers of
  different kinds. For example, a job posted by assigning its type (`job->type = JOB_TICK;`
  then a plain post) is a send matched with `{"assign":"type","as":"key"}`. Every assignment to
  that field matches, including resets such as `job->type = JOB_NONE`. Add `keys` (a regular
  expression the whole key must match) to keep only the real sends:
  `{"assign":"type","as":"key","keys":"JOB_TICK"}`; the resets then give no site at all.
- **A key is compared as text.** A key that is not an identifier is its source text without
  whitespace, so `rt->box` and `ctx->rt->box` are different keys. When a handle is reached
  through different pointer chains, add `"keyMember": true` to the matcher on both sides: the key
  becomes the last member name (`box`), so the post and the fetch pair by key. Check that the
  member name is unique to that handle; two unrelated structs with a `box` field would merge.
- **A send that reaches only its handler** in a rule that also has receive matchers usually
  means the dispatcher has no `case` for that key. Check the dispatcher before trusting it: a
  keyed connection for that key fails `check` with "has no receive site".

### Shapes (from `fixtures/cpp-sample`)

**Keyed queue.** `job_post(&job, JOB_READ_CNF, read_done)` sends; `case JOB_READ_CNF:` in
`rt_main` receives. The key is argument 2, the handler argument 3:

```json
{"kind":"rule","id":"job","title":"Job queue","type":"queue","context":"rt main task","send":[{"call":"job_post","key":2,"handler":3}],"receive":[{"case":"JOB_.*"}]}
{"kind":"connection","id":"read-cnf","rule":"job","key":"JOB_READ_CNF","title":"Read confirmation"}
```

`flowbook sites --rule job` prints
`src/rt/jobs.c:16: job send JOB_READ_CNF → rt_main (case JOB_READ_CNF), read_done`. The
keyed connection gives that one pairing a title; it is the exception, not one record per key.

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

**Event flag.** `event_set(EVT_SAVE)` sends; `if (flags & EVT_SAVE)` in the waiting task
receives. A `test` matcher matches an identifier anywhere in an `if`, `while` or `?:` condition:

```json
{"kind":"rule","id":"event","title":"Event flag","type":"event","send":[{"call":"event_set","key":1}],"receive":[{"test":"EVT_.*"}]}
{"kind":"connection","id":"rt-events","rule":"event","title":"Main task events","receive":[{"file":"src/rt/jobs.c","symbol":"rt_main"}]}
```

The second line is a dispatcher connection: you read `rt_main`, so every flag tested there is
confirmed. `flowbook sites --rule event` prints
`src/rt/jobs.c:21: event send EVT_SAVE → rt_main (test EVT_SAVE)` (no `?`).

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

**Mailbox keyed by its handle.** `mbox_post(rt->box, msg)` in `rt_send` and
`mbox_fetch(ctx->rt->box, &msg)` in `rt_poll` use the same mailbox through different pointer
chains. With `keyMember` both keys are `box`; a keyed connection names the mailbox:

```json
{"kind":"rule","id":"mbox","title":"Mailbox","type":"queue","send":[{"call":"mbox_post","key":1,"keyMember":true}],"receive":[{"call":"mbox_fetch","key":1,"keyMember":true}]}
{"kind":"connection","id":"rt-box","rule":"mbox","key":"box","title":"Runtime mailbox"}
```

**Anchored queue.** When the sites carry no key (a matcher without `key`) or the two ends
spell it differently, pair the functions. The fixture pins `job_post` to `rt_main`:

```json
{
  "kind": "connection",
  "id": "main-box",
  "rule": "mbox",
  "title": "Main mailbox",
  "send": [{ "file": "src/rt/jobs.c", "symbol": "job_post" }],
  "receive": [{ "file": "src/rt/jobs.c", "symbol": "rt_main" }]
}
```

An anchored connection works per function: it pairs _every_ send site of the rule in the
`send` functions with _every_ receive site in the `receive` functions. If one function posts to
two different queues, anchoring it joins both to the same receivers; key the queues by handle
(`keyMember`) instead, or leave such sites unpaired and explain them.

### Reading the output

| You see                                                                 | It means                                                                                                                                                               | Do this                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `?` after a reactor found by key, e.g. `rt_main (case JOB_WRITE_CNF) ?` | the receive site (and a handler registered there) has the send's key, but no dispatcher connection names its function and no keyed connection covers that rule and key | read the dispatcher; when it handles the key, add one dispatcher connection naming that function (or a keyed connection for a single key)                                                                                                                              |
| `(candidate)` after a handler                                           | several functions have the handler's name and none is a `static` one in the file that names it, so Flowbook cannot tell which one runs                                 | for a handler named at the send site, add an anchored connection: `send` is the function holding the send site, `receive` the chosen definition. For one registered in a callback slot no record confirms it; narrow the matcher with `files` or explain it in `notes` |
| `· no receive site for KEY` at the end of a send line                   | the rule has `receive` matchers but no receive site has this key, so the handler is unconfirmed: the dispatcher has nothing that runs it                               | look for the missing `case` in the dispatcher, or fix the receive matcher that misses it. A keyed connection for this key fails `check` with "has no receive site"                                                                                                     |
| `→ forwards parameter P (argument N of FN)` on a send line              | the key (or handler) is FN's own parameter P, so the real value is at FN's callers                                                                                     | read FN; if it is a wrapper, add the send matcher `check` suggests (`{"call":"FN","key":N}`) so its callers become send sites                                                                                                                                          |
| `→ unpaired` on a send line                                             | nothing reacts to it                                                                                                                                                   | fix the rule, or add a connection                                                                                                                                                                                                                                      |
| `→ unpaired` on a receive line                                          | nothing sends to it                                                                                                                                                    | check the send matchers; otherwise explain it in the rule's `notes`                                                                                                                                                                                                    |

`← 1 sender` is a receive site that something posts to. A handler named at the send site with
one definition is confirmed without a record. The summary `job: 5 send, 3 receive, 3 keys
paired (1 confirmed), 0 unpaired, 1 forwarding` counts keys (or sends, for rules without keys); a
key is confirmed when all its reactors are. Keys missing their receive site are counted as
`N without receive site` instead of paired, and `--unpaired` lists their send lines. Forwarding
send sites are counted as `N forwarding`, not as keys, and are not listed by `--unpaired`.

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
