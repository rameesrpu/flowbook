# Flowbook backlog — agent workflow

Open work after the v0.1 rebuild (all milestones done, CI green at `4310f43`). Each item is
written as a self-contained brief: hand one to an agent as-is. Read [CLAUDE.md](../../CLAUDE.md)
first; it has commands, layout and design rules. Order of work: [roadmap.md](../roadmap.md);
decisions and open points per feature: [tracker.md](../tracker.md).

## How to run this backlog

1. Pick items from different **tracks** to run in parallel. Each track owns different packages,
   so parallel agents won't conflict. Items in the same track run one after another.
2. Coordinator duties: install any new dependencies _before_ launching agents; agents never run
   `pnpm add`/`install` and never commit; review diffs and screenshots, run the CI sequence
   (CLAUDE.md → Commands), then commit one item per commit.
3. Tick items off here (move them to **Done** with the commit sha) in the same commit.

Kick-off prompt for a new conversation:

> Read CLAUDE.md and docs/agent-workflows/backlog.md. Run items <ids> as parallel subagents
> following the backlog's rules, then review, verify and commit each.

---

## Track A — Webview (`packages/webview`)

### A2. Kind-aware levels instead of depth-based

- **Problem:** `collapseBelow(tree, depth)` collapses by depth, so a file at the root (`main.c`)
  collapses at "Modules", and in shallow trees two levels look identical.
- **Approach:** add `collapseToKind(tree, 'module'|'folder'|'file')` in `packages/core/src/grouping.ts`
  (collapse every group of that kind and any deeper group not already hidden; never collapse a
  lone file group that has no module above it at the Modules level). Use it in the toolbar.
  Unit tests in `core.test.ts`. This item touches core — don't run it in parallel with C1/C2.
- **Accept:** each toolbar level produces a distinct, predictable projection on both fixture flows and the Lua flows.

### A3. Edges crossing group header text

- **Approach:** give ELK a header-sized label or top padding per compound node so routes avoid
  it (`elk.nodeLabels.placement` + a real node label, or larger top padding with
  `elk.layered.spacing.edgeNodeBetweenLayers`). Verify with screenshots.

### A4. Sequence view with many participants

- **Problem:** more than ~7 lifelines scroll sideways.
- **Approach:** narrower participant columns with ellipsis + tooltip, auto-collapse to Folders
  level when participants exceed what fits, and keep the header sticky horizontally too.
- **Accept:** Lua `run-script` (15 nodes) in sequence view is usable at 1440px width.

### A6. High-contrast theme check

- Screenshot with `body.vscode-high-contrast` / `vscode-high-contrast-light` variables and
  fix contrast issues (status dots, dimmed edges, diff colours).

## Track B — Extension (`packages/extension`)

### B1b. Document the bundled CLI and skill commands

- B1 shipped the code; the docs still describe the manual setup. Update `skill/flowbook/SKILL.md`
  ("The CLI is your feedback loop": if `flowbook` is missing, ask the user to run **Flowbook:
  Install CLI** in VS Code) and README ("Put the CLI on your PATH" / "Set up the agent skill":
  lead with the two commands, keep the from-source shim as the alternative).

### B2. Smoke-test the remaining webview messages

- **Problem:** `test/suite.cjs` doesn't exercise `openCode`, `requestSnippet`, `requestDiff`.
- **Approach:** expose a test-only command (or use the panel host directly) to post those
  messages and assert: editor opens at the symbol line, snippet text contains the function,
  diff after editing a fixture function in a temp copy contains `-`/`+` lines.

### B3. Live reload on unsaved edits (nice to have)

- Debounced `onDidChangeTextDocument` for C/C++ docs → recompute anchor states for open panels
  using editor text. Keep disk-based reload for flow files.

## Track C — Resolver / CLI / skill (`packages/resolver`, `packages/cli`, `skill/`)

### C2. Examples in CI

- Add a CI job (or step) that runs `examples/lua/fetch.sh` and
  `pnpm flowbook check --strict --root examples/lua`. Cache the clone. Fails if the skill-written
  flows drift from Lua 5.4.7.
- Do the same for `examples/i-link` and `examples/p-net` (`fetch.sh`, then
  `pnpm flowbook check --strict --root examples/<name>`), and compare the summary lines of
  `pnpm flowbook sites --root examples/<name>` with the ones recorded in each README, so a
  change in matching or pairing shows up as a diff. Both clones are pinned to a commit; cache
  them.

### C3. Second dogfooding round

- After B1, run a fresh agent with only SKILL.md + the CLI on a C++-heavy project (e.g. a small
  part of `leveldb` or `fmt`) to stress namespaces, templates, overloads and classes. Collect a
  friction log; fix resolver/skill gaps. Add the flows as `examples/<name>/`.

## Track D — Repo / release (root files)

### D1. README

- Text is written (`20b4563`). **Still missing:** a screenshot of each view (Marketplace needs
  `https` image URLs, e.g. raw GitHub links), and the B1b install changes.
- Original brief: what Flowbook is, a screenshot of each view (from the dev harness),
  install (vsix), quick start for agents (skill + CLI), file format summary linking
  `skill/flowbook/references/schema.md`, development commands.

### D3. Marketplace publishing (later)

Full checklist (incl. the maintainer's manual account steps): [docs/publishing.md](../publishing.md).

- Publisher account, icon PNG (128×128), `galleryBanner`, categories/keywords, CHANGELOG,
  release workflow publishing to VS Code Marketplace and Open VSX on tags.

## Track E — Notation & embedded/RTOS fit (parked; cross-cutting, touches core schema)

Context: embedded firmware on an RTOS (FreeRTOS used as the example). FreeRTOS mapping to use in
E1–E3 and the skill: task entry = `xTaskCreate(fn, "Name", …)` (context name from code); ISR
context = `…FromISR` calls / handlers; `xQueueSend` → `async`;
`xTaskNotify`/`xSemaphoreGive`/`xEventGroupSetBits` → `signal`; `taskENTER_CRITICAL`/mutex →
`critical` block; software-timer callbacks run in the timer service (daemon) task, not the
starter's; mailbox anchors = `QueueHandle_t` globals. Middleware often wraps the RTOS in an OS
abstraction layer — anchor the wrapper, name the primitive in `notes`. Typical flows: startup
sequence, and application API calls posted to a mailbox → processed in a worker task →
completion callback to the app. Startup already fits;
the mailbox flow is expressible (`async` + `callback` steps) but hides the important part, the
task/ISR boundary. All E items change the schema → update `core/src/schema.ts`, `schema.md`,
fixtures and examples together; run one at a time, not alongside A2/C1. **Parked by the user —
start by writing a real mailbox flow against the current schema to confirm the friction points.**

### E1. Execution context on nodes

- **Problem:** lifelines/groups are static structure (function, file, folder, module), but RTOS
  flows are about which task or ISR runs the code.
- **Approach:** optional `node.context` (free string, e.g. `"PN stack task"`, `"ISR: ICSS"`).
  Sequence view: a "group by context" option so lifelines become tasks/ISRs; flowchart: show the
  context as a badge or an alternative grouping. Skill: tell agents when to set it.

### E2. Anchors to variables

- **Problem:** the resolver only knows functions, function-like macros and types
  (`SymbolKind` in `resolver/src/symbols.ts`), so a mailbox/queue handle must be an unanchored node.
- **Approach:** add a `variable` kind for file-scope/global declarations (fingerprint the
  declaration incl. initializer). Tests on fixture globals.

### E3. More fragment types + a notation legend

- Add `opt`, `break`, `critical` blocks (UML 2 operators; `critical` = IRQs off / mutex held).
- Align with UML: `async` is currently dashed + open head (UML: solid + open head) — fix or
  document the deviation. Add a "Notation" section to `schema.md` and a legend in the webview.
- Consider a "later / wait" marker for steps separated by external events (e.g. controller reply).

Out of scope for now: statecharts (AR/alarm state machines); single scenarios through them still
fit as flows.

## Track F — Connection points follow-ups (`packages/core`, `packages/resolver`, `packages/cli`, `packages/extension`)

Found on 2026-11-15 by writing rules for two real protocol stacks (`examples/i-link`,
`examples/p-net`) and by the final review. F1–F6 change the rule format, so they need a short
design first (update `core/src/connections.ts`, `schema.md`, the fixture and both examples
together). F7 items are small and independent.

F1–F4 were built by design 1b (see **Done**).

### F5. Excluding one receive site, and run-time flag values

- **Problem:** a `test` matcher also matches a condition in a debug-log block, and a keyed
  connection cannot exclude one site. Separately, a flag held in a variable set from
  configuration can only be paired by an anchored connection, which joins it to every flag test.
- **Approach:** a connection form with an anchored send and a keyed receive; an exclusion list.

### F6. Callback slots without the application

- Callback-slot pairing is only useful when the application is in the same Flowbook root; p-net's
  callbacks pair only with its test fixture. Document this in the skill; consider a root that
  spans several directories.

### F7. Small items

- An added anchored connection clears the whole scan cache (`rulesKeyOf` includes anchored files).
- `isReceiveThenHandler` can combine the key reactor of one send site with the handler of another
  on the same line.
- `sites` looks pairings up per row (O(sites × pairings)); build a map.
- A keyless handler send prints the handler in the key position of the `sites` line.
- The connection lens provider's subscriptions are never disposed (same as `FlowLenses`).
- A file whose parse throws is re-read on every scan; a skipped file that defines a handler stops
  contributing definitions.
- `check`'s summary line does not count rules or connections; symlinked directories are not
  scanned.
- Measure the scan inside VS Code on a root with several thousand files (only the CLI and
  in-process timings were measured).
- Forwarding (1b): the `check` hint names only the key position when a wrapper also forwards its
  handler; C++ hints use the qualified name; a site inside a lambda uses the enclosing function's
  parameters; overloads give duplicate warnings; a `keys`-filtered wrapper site gives no warning; a forwarding
  site with reactors (i-link `iolink_ode.c:447`) prints only its reactors in `sites`, not "forwards".

## Track G — State machine follow-ups (`packages/resolver`, `packages/cli`, `packages/extension`, `packages/webview`)

Found on 2026-11-21 while building design 2 on `examples/p-net` and `examples/i-link` and in its
final review. Design: `docs/superpowers/specs/2026-11-21-state-machines-design.md`.

### G1. State diagram view

- The spec's "Later" section: a webview `machine` view (states as nodes, transitions as edges
  labelled by event, ELK layout, side panel with snippet, guard and triggers), a `Flowbook: Show
State Machine` command, a `HostMessage` `{type:"machine"}` change in webview and extension
  together. Build once the CLI and lenses have been used on a real stack.

### G2. Triggers count sends in sibling branches

- A transition's triggers are every send in its region (the `case` block or function), so a send
  in another `if` branch is listed too (p-net `cmio`: 3 "sets off", 1 real). Narrow the region to
  the innermost statement block that contains the set site, or skip sibling branches.

### G3. Small items

- `[IDX] = {…}` (index-designated) table rows are not read.
- An `else` branch of a state test has no source (p-net `pf_cmdev.c:4819`); needs negation.
- "From key matches no table" sees only tables with at least one kept row (false error when every
  row of a table was filtered).
- Callers are matched by leaf name (`A::go` and `B::go` in one C++ file are conflated); two scopes
  on one function take the first without a warning.
- The CLI `transitionLine` and the extension `transitionLensTitle` are near copies; move one
  formatter into the resolver.
- A dirty document is parsed twice per lens refresh (`viewOf` in both lens providers); cache by
  uri, version and reload generation.
- Trigger lookup is linear over all pairings per transition; index pairings by file.
- A state case nested in another state case of the same machine counts its calls for both states
  (callee becomes `*`); an inner `if` mixing states with other operands stops an outer clean
  state test from being used.
- A `set` matcher with `keys` filters the raw `c ? A : B` text before the two-branch split.
- Absolute cold-scan time with machines on a quiet machine (only relative cost measured).
- `references/schema.md` scope example names `pf_cmdev_init`; the real p-net record is
  `cmdev-connect`.

## Decisions already made (don't re-litigate)

Agents write, humans read (UI read-only + "copy agent prompt"); one JSONL file per flow;
C/C++ via tree-sitter (no clangd); anchors without line numbers; fingerprint + verified commit
for staleness; collapsible nested groups instead of fixed view levels; React Flow + ELK;
flowchart + sequence views; blocks drawn as frames only in the sequence view (badges +
highlight in the flowchart); ELK on the main thread (no worker under the webview CSP).

## Done

- v0.1 rebuild — core, resolver, CLI, webview, extension, skill, Lua example, CI (`4310f43`).
- D2. License: MIT (`LICENSE` at the root and in `packages/extension/` for vsce).
- C1. "Did you mean" hint for wrong anchor file paths (same-basename search).
- A5. Webview imports `@flowbook/core/browser` (no zod): no `new Function` CSP violation;
  bundle 3,067 → 2,977 kB (766 → 740 kB gzip). The rest is elkjs (~1.6 MB) and shiki.
- A1. Large flows open readable: initial level = most detailed level whose fitted zoom is ≥ 0.85
  (until the user picks one); oversized graphs open at 0.85 from their start instead of shrinking;
  single-child group chains share one box (`module / src / file.c`); slimmer file boxes. Dev
  harness: `root=lua`.
- B1. CLI and skill ship in the vsix (`dist/cli/`, `dist/skill/`). Commands **Flowbook: Install
  CLI** (copies the CLI to global storage, writes `~/.local/bin/flowbook` or `flowbook.cmd`; uses
  `node` if present, else VS Code's runtime via `ELECTRON_RUN_AS_NODE`; refreshed on activation)
  and **Flowbook: Add Agent Skill to Repository** (`.claude/skills/flowbook/`). Decision: vsix
  only, no npm package. Docs follow in B1b.
- Connection points and the editor jump (design
  `docs/superpowers/specs/2026-11-15-connection-points-design.md`): rules and connections in
  `.flowbook/connections.jsonl`, `flowbook sites`, connection checks in `flowbook check`, editor
  lenses and `Go to Reactor` / `Go to Sender`, examples `examples/i-link` and `examples/p-net`.
- F1–F4 rule format follow-ups (design 1b,
  `docs/superpowers/specs/2026-11-21-rule-format-followups-design.md`): `keyMember`, `keys`,
  forwarding sites, dispatcher connections.
- State machines (design 2, `docs/superpowers/specs/2026-11-21-state-machines-design.md`):
  `machine`/`scope` records in `.flowbook/machines.jsonl`, transitions found in the scan (setter in
  a case, state test, per-state functions, tables), `flowbook states`, machine checks in `check`,
  transition lenses, machines for both examples. Follow-ups in Track G.
