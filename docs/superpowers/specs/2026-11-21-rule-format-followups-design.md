# Design 1b — Rule format follow-ups (backlog F1–F5)

Date: 2026-11-21. Status: approved by the coordinator under the user's standing autonomy ruling
(the user skims afterwards). Builds on
[2026-11-15-connection-points-design.md](2026-11-15-connection-points-design.md).

## Intent

Rules written for two real protocol stacks (`examples/i-link`, `examples/p-net`) left two kinds
of noise: sites that should pair and don't (i-link's mailboxes: 8 of 13 unpaired; wrapper
internals; `job->type = IOLINK_JOB_NONE` resets), and boilerplate an agent has to write to
confirm a dispatcher it has read once (i-link 44 keyed connections, p-net 10). Design 2 (state
machines) reuses the same matchers, so these gaps are fixed first.

Success, measured on the pinned examples:

- i-link `mbox`: 13 of 13 sites paired, by key, no anchored connection.
- i-link and p-net: keyed-connection records drop from 44 → ≤ 6 and 10 → 1.
- Wrapper internals and job resets no longer show as unpaired.
- Both READMEs carry re-measured `flowbook sites` summaries and updated unpaired tables.

## Goals / non-goals / anti-goals

- Goals: F1 member keys, F2 forwarding sites, F3 key filter, F4 dispatcher confirmation.
- Non-goals: F5 (exclude one receive site; run-time flag values) — stays in the backlog with the
  findings below. F6 (callback slots without the application). F7 items, except where the code
  being changed makes one free.
- Anti-goals: anything that lets an agent confirm pairings it has not read (the confirmation
  must name the function the agent read); line numbers in any record; breaking existing rule
  files (every new field is optional; old files mean exactly what they meant).

## Evidence (from the examples)

| Gap | Where                                                                                                                                  | Count                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| F1  | `os_mbox_post (master->mbox_avail, …)` vs `os_mbox_fetch (port->master->mbox_avail, …)`; three mailboxes in one function `iolink_main` | 8 of 13 mbox unpaired     |
| F2  | `iolink_cm.c:1137`, `iolink_ode.c:616`, `iolink_main.c:310` (key `type` is a parameter); `pf_scheduler.c:267` (handler `cb`)           | 4 unpaired sites          |
| F3  | `job->type = IOLINK_JOB_NONE` in `iolink_main.c` (5×)                                                                                  | 5 unpaired sites          |
| F4  | `case IOLINK_JOB_…` in `iolink_main`, flag tests in `dl_main` and `bg_worker_task`                                                     | 44 + 10 keyed connections |
| F5  | `BG_WORKER_LOG_JOBS` log test (same key, same function); `iolink->pl_flag` (value set at run time)                                     | 1 + 3 sites               |

## Approaches considered

**F1 — mailbox handles as keys.**
(a) Matcher option `"keyMember": true`: the key is the last member name of the argument
(`port->master->mbox_avail` → `mbox_avail`). (b) Normalise the whole expression (strip the
`port->master->` prefix by type analysis). (c) Make member keys the default. Picked (a): it is the
idea that already works for callback slots, needs no types, and is opt-in, so `a->x` and `b->x`
are never merged silently. (b) needs type information tree-sitter does not have; (c) changes the
meaning of existing files.

**F2 — wrappers.**
(a) Mark a send site whose key or handler is a parameter of its enclosing function as
_forwarding_: not unpaired, not "no receive site"; `check` warns when no send matcher of the rule
matches calls to that function and prints the matcher to add. (b) Derive wrapper matchers
automatically (a second scan pass for callers, transitively). Picked (a): (b) touches the
prefilter and the cache, and can explode on generic helpers; (a) removes the noise and tells the
agent the one line to add, which keeps wrapper rules explicit and reviewable.

**F3 — key filter.** A `"keys": regex` on `call` and `assign` matchers; a site is kept only when
its key matches the whole expression. The only sensible way: `case`/`test`/`invoke` already
filter by their name, which is the key.

**F4 — confirming a dispatcher.**
(a) A _dispatcher connection_: `receive` anchors only (no `key`, no `send`). Every key reactor (and
registered handler) whose receive site lies inside one of those functions is confirmed.
(b) A keyed connection whose `key` is a regular expression. Picked (a): it names the function the
agent read, which is what the 44 records each claimed; a new `case` added to that function later
is confirmed by the same reading, a new dispatcher elsewhere is not. (b) confirms by spelling and
says nothing about where the reading happened. Cost of (a): per-key titles are lost unless the
agent also writes a keyed connection for that key (it wins for title and context).

**F5 (deferred).** Excluding one receive site needs a way to address a site without a line
number; the only case found is a test inside `#ifdef BG_WORKER_LOG_JOBS`, and it is harmless (a
second reactor shown beside the real one). Run-time flag values (`iolink->pl_flag`) need an
"anchored send + keyed receive" form; one site pair in one example. Both wait for more evidence
(design 2 will produce some).

## Design

### Matcher fields (core `connections.ts`, `schema.md`)

- `call`: adds optional `keyMember: true` (requires `key`) and `keys: Name`.
- `assign`: adds optional `keyMember: true` (only with `"as": "key"`) and `keys: Name`.
- Validation: `keyMember` without a key source is an error; an invalid `keys` regex is an error
  (same treatment as names: the scan skips the matcher, `check` reports it).

Key derivation order for a site: take the argument / right-hand side; unwrap `&`, parentheses and
casts; with `keyMember`, a `field_expression` (also on a subscript, `x[i].mbox`) gives its field
name, an identifier gives itself, anything else the compact text; without it, today's rule. Then
`keys` is applied to the result; a site whose key fails (or that has no key) is dropped.

### Forwarding sites (resolver `sites.ts`, `pairing.ts`)

- `Site` gains `forwards?: { param: string; position: number }` (1-based parameter position),
  set on a send site when its key, or (if it has no key) its handler, is an identifier equal to a
  parameter name of the enclosing function definition. Parameters are read from the tree
  (`function_declarator` → `parameter_list` → declarator identifier, unwrapping pointer /
  reference / array declarators).
- Pairing: a forwarding site gets `missingReceive` never; it keeps any handler reactors.
  `Pairing` gains `forwarded?: true` for consumers.
- `ruleSummaries`: forwarding sites without reactors count in a new `forwarding` field, not in
  `unpaired`. The `sites` summary appends `, N forwarding` when non-zero.
- `check` warning (on the rule record): `send site in <symbol> (<file>) forwards parameter "<param>"; no send matcher of rule "<id>" matches calls to <symbol>; add {"call":"<symbol>","key":<n>}`
  (or `"handler":<n>`). One warning per enclosing function.
- `sites` line: `→ forwards parameter type (argument 3 of init_and_post_job)`. Lens: `↳ forwards
parameter \`type\` to callers of init_and_post_job`.

### Dispatcher connections (core validation, resolver pairing)

- Form rules: keyed = `key` only; anchored = non-empty `send` and `receive`; dispatcher =
  non-empty `receive` only. `send` alone is an error. Messages updated.
- A dispatcher on a rule without `receive` matchers is an error. Each anchor must resolve (same
  messages as anchored) and its function must contain at least one receive site of the rule,
  otherwise `check` errors.
- Pairing: key reactors and registered reactors are confirmed when an exact keyed connection
  confirms them (today) or when their receive site lies inside a dispatcher function of the rule.
  Title/context: exact keyed connection, else covering anchored connection, else the dispatcher
  whose function holds the first key receive site.
- `missingReceive` is unchanged: a dispatcher never confirms a key without a receive site.
- The scan cache key already includes every anchored file; dispatcher anchors are included the
  same way.

### Consumers

- CLI `sites` (text + `--json`: `forwards`, `forwarded`), summary line; `check` uses the new
  diagnostics. The O(sites × pairings) lookup in `sites` becomes a map (F7, same code).
- Extension `connections-model.ts`: forwarding lens title; `agentPrompt` is not offered for a
  forwarding site. No protocol change (`Site`/`Pairing` cross the host only, not the webview).
- Skill `SKILL.md`: when to use `keyMember`, `keys`, dispatcher connections; "read the
  dispatcher, then write one record naming it" replaces "one keyed connection per key".

### Fixture and examples

- Fixture: a mailbox written through two different member chains paired with `keyMember`; a
  wrapper that forwards its key; a reset filtered by `keys`; a dispatcher connection on the event
  rule. Re-stamp, `--strict` clean.
- i-link: `mbox` gets `key:1, keyMember:true` on both sides plus 3 keyed connections (`mbox`,
  `mbox_avail`, `mbox_api_avail`); `master-mbox` is removed. `job`: 37 keyed connections → one
  dispatcher on `iolink_main`; the `assign` matcher gets `keys: "IOLINK_JOB_(PD_EVENT|EXIT)"`.
  `dl-event`: 8 → one dispatcher on `dl_main`. p-net `bg`: 10 → one dispatcher on
  `bg_worker_task`. Both READMEs re-measured.

## Left to the builder

Exact diagnostic wording beyond the forms above; where in `sites.ts` parameters are collected
(once per function is enough); test layout. Keep CLI output stable apart from the listed changes.
