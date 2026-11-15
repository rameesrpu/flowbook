# Connection points and the editor jump — design

Date: 2026-11-15. Status: draft for approval. Design 1 of 5 (see "Where this sits").

## Intent

Protocol stacks are hard to follow because cause and effect sit in different places. A request is
posted to a mailbox and executed in another task; an event flag is set and something else reacts;
a timer is started and a handler runs later; the stack calls back into the application through a
function pointer. Nothing in the source connects the two ends, so a developer searches for
keywords and macros by hand.

This design makes Flowbook know those connections, so that on a line that posts, sets or schedules
something the editor shows where it will be executed and jumps there, and the reverse on the
receiving side.

It is the foundation for the later designs (state machines, walkthrough and "you are here", MCP
server, spec references), which all need the same knowledge.

## Who it is for

Developers of industrial protocol stacks in C on an RTOS (PROFINET, IO-Link, EtherNet/IP,
EtherCAT), working in VS Code, with a coding agent available to write Flowbook content.

## Goals

1. On a sending line, show the reactor(s) and jump to them without searching.
2. On a receiving line or handler, show and jump to the senders.
3. Work on code nobody has documented yet, wherever the pairing can be derived from the code.
4. Never present a connection that is not backed by a real place in the code.
5. Tell the agent and the team how much is covered.

## Non-goals

- State changes and state machine diagrams (design 2).
- Any diagram or webview change. The webview and `protocol.ts` are untouched.
- A model of tasks. `context` is a free string here; design 3 may give it structure.
- Type analysis, macro expansion, data-flow tracking, clangd or `compile_commands.json`.
- Languages other than C and C++.
- Editing from the UI. Agents write, humans read.

## Anti-goals

- A wrong jump shown as certain.
- A lens on so many lines that the code is harder to read.
- A scan that makes the editor freeze or lag.

## Constraints

- Existing design rules in `CLAUDE.md` hold: no stored line numbers, `core` free of Node APIs,
  unknown fields are errors, everything local with no network requests.
- Parsing is tree-sitter only. A macro invocation looks like a call and is matched by the macro's
  name; code inside a `#define` body is not scanned.
- Third-party stacks used as examples are GPL-licensed. Their sources are fetched by a script and
  gitignored, as `examples/lua` does today. Only our own rule and connection files are committed.

## What real stacks contain

Surveyed on 2026-11-15: `rtlabs-com/p-net` at `1c3b0b435b2ee2c6cea86849c14ee98f6ee579f1`
(PROFINET device) and `rtlabs-com/i-link` at `9f5fe0f7c6a45fa96a8d2439dcbe60bb2415793d` (IO-Link
master). Four shapes of connection cover what was found:

| Shape                     | Example                                                                                                   | Pairing          |
| ------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------- |
| Named constant            | i-link posts a job with `IOLINK_JOB_AL_READ_CNF`; `iolink_main` has `case IOLINK_JOB_AL_READ_CNF:`        | by constant name |
| Handler named at the post | p-net `pf_scheduler_add (net, delay, pf_cmio_timer_expired, …)`; i-link job callbacks                     | direct           |
| Callback slot             | p-net calls `net->fspm_cfg.state_cb (…)`; the application sets `.state_cb = app_state_ind`                | by field name    |
| Plain queue               | `os_mbox_post (master->mbox, job, 0)` and `os_mbox_fetch (master->mbox, …)` with nothing else on the line | needs an agent   |

Request blocks dispatched by an opcode `switch` are the first shape. A mailbox dispatcher that
runs stored function pointers is the second.

## Approaches

**A. Agent-written connections.** The agent records every connection; fingerprints flag changes.
Works for any coding style, but covers only what has been documented, so an undocumented line
shows nothing.

**B. Mechanical extraction.** Per-codebase rules and a scan, no agent. Complete and current, but
tree-sitter has no types or macro expansion, so plain queues and clashing names cannot be paired.

**C. Rules find the sites, agents explain the pairings (chosen).** Rules locate every send and
receive site. The tool pairs the three derivable shapes itself. Agents pair plain queues, name the
connections and say which task runs the reactor. The checker rejects any agent claim that does not
match a site the scan found. Chosen because it gives jumps on undocumented code, coverage numbers,
and connections that cannot be invented. It costs the most to build and each codebase needs a
small rule file, which the agent writes.

## Vocabulary

- **Rule**: a description of one connection mechanism in this codebase.
- **Site**: a place in the code a rule matched. It has a role, `send` or `receive`.
- **Key**: the text that ties sites together, usually a constant name or a field name.
- **Handler**: a function named at a site, which is the code that eventually runs.
- **Reactor**: where a send ends up: a receive site, a handler function, or both.
- **Connection**: an agent-written record that names and confirms a pairing, or creates one the
  tool could not derive.

## File format

One new file, `.flowbook/connections.jsonl`, holding `rule` and `connection` records. One JSON
object per line, strict, like flow files. Ids follow the existing `Id` pattern and are unique
within the file.

### `rule`

| Field     | Type       | Notes                                                               |
| --------- | ---------- | ------------------------------------------------------------------- |
| `kind`    | `"rule"`   |                                                                     |
| `id`      | id         |                                                                     |
| `title`   | string     | e.g. `"Master job queue"`                                           |
| `type`    | enum       | `queue`, `event`, `timer`, `callback`, `request`. For display only. |
| `send`    | matcher[]  | at least one                                                        |
| `receive` | matcher[]? | omit when every send matcher names a handler                        |
| `context` | string?    | where reactors of this rule run, e.g. `"master thread"`             |
| `notes`   | markdown?  |                                                                     |

### Matchers

A matcher is an object with exactly one of the five keys below, plus an optional
`"files": [globs]` that limits where it applies. Every name in a matcher is a regular expression
that must match the whole name, so a plain name is an exact match. Argument positions are 1-based.

| Matcher                                     | Matches                                                        | Key                    | Handler      |
| ------------------------------------------- | -------------------------------------------------------------- | ---------------------- | ------------ |
| `{"call": name, "key"?: n, "handler"?: n}`  | a call to a function or function-like macro                    | argument `n`, if given | argument `n` |
| `{"case": name}`                            | a `case` label that is an identifier                           | the identifier         |              |
| `{"test": name}`                            | an identifier inside the condition of an `if`, `while` or `?:` | the identifier         |              |
| `{"assign": field, "as": "key"\|"handler"}` | an assignment or designated initializer of a struct field      | see below              | see below    |
| `{"invoke": field}`                         | a call through a struct field, `x->f (…)` or `x.f (…)`         | the field name         |              |

For `assign`, `"as": "key"` makes the right-hand side the key; `"as": "handler"` makes the
right-hand side the handler and the field name the key. A key taken from an argument or a
right-hand side is the identifier when it is one, otherwise the source text with whitespace
removed. A handler must be an identifier; when it is anything else the site is kept and reported
as having an unresolved handler.

Examples, one per shape:

```jsonl
{"kind":"rule","id":"job","title":"Master job queue","type":"queue","context":"master thread","send":[{"call":"iolink_post_job_with_type_and_callback","key":3,"handler":4}],"receive":[{"case":"IOLINK_JOB_.*"}]}
{"kind":"rule","id":"sched","title":"Scheduler timeout","type":"timer","send":[{"call":"pf_scheduler_add","handler":3}]}
{"kind":"rule","id":"app-cb","title":"Application callback","type":"callback","send":[{"invoke":".*_cb"}],"receive":[{"assign":".*_cb","as":"handler"}]}
{"kind":"rule","id":"mbox","title":"Mailbox","type":"queue","send":[{"call":"os_mbox_post"}],"receive":[{"call":"os_mbox_fetch"}]}
```

### `connection`

| Field     | Type           | Notes                                            |
| --------- | -------------- | ------------------------------------------------ |
| `kind`    | `"connection"` |                                                  |
| `id`      | id             |                                                  |
| `rule`    | id             | the rule it belongs to                           |
| `title`   | string         | e.g. `"AL read confirmation"`                    |
| `key`     | string?        | form 1                                           |
| `send`    | anchor[]?      | form 2: functions that contain the send sites    |
| `receive` | anchor[]?      | form 2: functions that contain the receive sites |
| `context` | string?        | overrides the rule's `context`                   |
| `notes`   | markdown?      |                                                  |

A connection has exactly one of two forms:

1. **Keyed**: `key` only. It names and confirms the pairing the tool derived for that rule and key.
2. **Anchored**: `send` and `receive` only. It pairs every send site of the rule inside the `send`
   functions with every receive site of the rule inside the `receive` functions. This is how plain
   queues are paired. Anchors are the existing `file + symbol (+ sig)` anchors.

Connections carry no `fp` or `verified`. They are re-verified against the code on every scan, so
a connection whose sites disappear becomes an error at once. `flowbook stamp` is unchanged.

## Pairing

For a send site S of rule R, its reactors are:

1. every receive site of R with the same key as S, when S has a key;
2. the definition of S's handler, when S has one;
3. the definition of the handler of every receive site found in step 1 (the callback-slot case,
   where the receive site is the registration and the registered function is what runs);
4. every receive site joined to S by an anchored connection.

A handler name is resolved to function definitions across all scanned source files. One
definition is a resolved handler. With several, a `static` definition in the same file as the
site wins; otherwise all are listed as candidates.

Status is tracked per reactor of a send site:

- A handler named at the send site itself (step 2) is **confirmed** when it resolves to exactly
  one definition.
- A receive site matched by key (step 1), and a handler reached through it (step 3), are
  **confirmed** only when a keyed connection covers that rule and key. Otherwise they are
  **unconfirmed**, however many definitions the handler has. This keeps a field-name clash from
  being shown as certain.
- A receive site joined by an anchored connection (step 4) is **confirmed**.
- A handler with several candidate definitions is **unconfirmed** until an anchored connection
  picks one (see below).

A site with no reactor, or a receive site with no sender, is **unpaired**. In summaries,
confirmation is counted per rule and key.

In an anchored connection, a `receive` anchor is valid when the function contains a receive site
of the rule, or when it is a candidate definition of a handler named at a send site inside the
`send` functions. The second case is how an agent picks one of several same-named handlers for a
rule that has no receive matchers.

## Scanning

- The scan walks the Flowbook root for files matching the existing `SOURCE_EXTENSIONS`, skipping
  directories whose name starts with `.` and `node_modules`, `build`, `dist`, `out`.
- A file is parsed only if its text contains a literal fragment of some rule's names, or a handler
  name that needs resolving. Rules that match everything are legal but slow.
- Results are cached per file and reused while the file is unchanged.
- Sites store a live line and column and the enclosing definition's symbol. Nothing about a
  position is written to disk.

## CLI

- `flowbook sites [--rule <id>] [--unpaired] [--json]` lists the sites found, one per line as
  `file:line: rule role key → reactors`, then one summary line per rule, for example
  `job: 37 send, 39 receive, 27 keys paired (5 confirmed), 12 unpaired`. This is the agent's
  feedback loop for writing rules, as `resolve` is for anchors. Exit code 0.
- `flowbook check` also validates `connections.jsonl`. Errors: schema problems, an invalid
  regular expression, a connection naming an unknown rule, a connection that is neither form or
  both, a keyed connection whose key has no send site, a keyed connection whose key has no
  receive site when its rule has receive matchers (or no reactor when it has none), an anchor that does not
  resolve, an anchored `send` function with no send site of the rule, an anchored `receive`
  function that is neither a receive site's function nor a handler candidate (see Pairing).
  Warning: a rule that matches no site.
- Unpaired and unconfirmed sites are not diagnostics. They are reported by `flowbook sites` only,
  so that adopting rules on a large codebase does not flood `check`.

## Editor

- **Lens on a send site.** One reactor: `↳ iolink_main · case IOLINK_JOB_AL_READ_CNF (master
thread) → then ode_read_cnf_cb`. The parts are the reactor's enclosing function, the key when
  the reactor is a `case` or `test`, the context when known, and the handler when both a receive
  site and a handler exist. A covering connection's title is put in front. Several reactors:
  `↳ 3 reactors: a, b, c`. A lens ends with `· unconfirmed` when any reactor it shows is
  unconfirmed.
- **Lens on a reactor**: `↳ posted from 6 places`, on the name line of a handler function and on
  a receive site. To keep long dispatch switches readable, a receive site gets a lens only when
  it has at least one sender, and receive sites on consecutive lines (fall-through `case` labels)
  share one lens on the first of them, `↳ 28 keys · posted from 41 places`. Clicking a shared
  lens peeks all those senders. `Go to Sender` still works on every receive line for that line's
  own key.
- **Commands** `Flowbook: Go to Reactor` and `Flowbook: Go to Sender` act on the cursor line. One
  target opens it; several open VS Code's references peek. When the targets are a key reactor
  followed only by its handler, the command opens the key reactor, since the handler runs from there. The lenses run the same commands.
- An unpaired send site shows `↳ no reactor found`, and the command offers to copy an agent
  prompt asking for a connection record, matching the existing "Copy agent prompt" pattern.
- **Setting** `flowbook.connections.codeLens.enabled`, default `true`.
- The lenses of the open document are computed from its current text, so they follow unsaved
  edits. The workspace index is refreshed on save of a source file or of `connections.jsonl`.
- The scan runs in slices that yield to the event loop, and the extension is usable while it runs.
- Problems in `connections.jsonl` appear in the Problems panel like flow problems do.

## Where the code goes

| Package     | Change                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `core`      | zod schemas for `rule`, matchers and `connection`; parsing into the workspace; reference validation; regenerated JSON Schema. No Node APIs. |
| `resolver`  | site matching over tree-sitter trees, source file walking, handler resolution, pairing, connection checks.                                  |
| `cli`       | `sites` command; `check` includes connection diagnostics.                                                                                   |
| `extension` | scan and cache in the host; a pure, unit-tested model for lens text and jump targets; lens provider; two commands; one setting.             |
| `skill`     | a "Connections" section in `SKILL.md` and the record reference in `schema.md`.                                                              |
| `fixtures`  | `cpp-sample` gains C sources with all four shapes and a `connections.jsonl`.                                                                |
| `examples`  | `examples/i-link` and `examples/p-net`: a `fetch.sh` pinned to the commits above, and rule files.                                           |

## Acceptance

1. In the fixture, each of the four shapes produces the expected sites and pairings, covered by
   unit tests in `resolver` and CLI tests.
2. `flowbook check --strict --root fixtures/cpp-sample` stays clean, and each error listed under
   CLI has a test that triggers it.
3. On i-link with the example rules, every job type sent through
   `iolink_post_job_with_type_and_callback` has at least one reactor. A grep on 2026-11-15 found
   27 distinct job types at those calls and 39 distinct `case IOLINK_JOB_` labels; the scan's
   numbers are recorded in the example's README with the unpaired sites explained.
4. On p-net with the example rules, every handler passed to `pf_scheduler_add` under `src/device`
   and `src/common` resolves to a definition (17 distinct by grep), and every `fspm_cfg` callback
   field (16 by grep) has an invoke site.
5. A cold scan of p-net (about 59,000 lines) finishes in under 10 seconds on the development
   machine without freezing the editor; an unchanged rescan in under 1 second. These targets are
   the author's estimate and are to be measured, then adjusted in this document if wrong.
6. The extension end-to-end test opens a fixture file and asserts one send lens, one reactor
   lens, and that `Go to Reactor` lands on the expected line.

## Known limits

- A handler passed through a variable is not followed; the site is reported with an unresolved
  handler.
- When a constant is set on one line and the block is posted on another, the lens is on the line
  where the constant appears.
- Two unrelated struct fields with the same name match the same `invoke` or `assign` matcher.
  `files` narrows it; otherwise the pairings are simply unconfirmed candidates.

## Decisions made by the author, not by the user

Listed so they can be checked and overturned:

- One file, `.flowbook/connections.jsonl`, not a directory.
- Connections have no fingerprints.
- A handler named at the send site with a single definition counts as confirmed without a record;
  everything matched by key stays unconfirmed until a connection record covers it.
- Receive lenses only where there are senders, with consecutive receive lines sharing one lens.
- Unpaired and unconfirmed sites stay out of `check`.
- `context` is a free string on rules and connections.
- The five matcher kinds and their regular-expression semantics.
- The performance targets in Acceptance 5.

## Left to the builder

Internal types and module boundaries inside each package, the cache's storage and invalidation,
how the tree is traversed, the exact fixture sources, and lens wording beyond the forms given
above.

## Where this sits

1. **Connection points and the editor jump** (this document).
2. State machines: states, transitions, what happens on entry, reading table-style machines.
3. Walkthrough mode and "you are here".
4. MCP server for agents.
5. Spec references, the hook for a separate spec-search tool.

Later: log replay, Marketplace publishing. Direction agreed for all of them: embedded and firmware
teams, local and CI only, bring-your-own agent, MIT throughout.
