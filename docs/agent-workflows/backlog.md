# Flowbook backlog — agent workflow

Open work after the v0.1 rebuild (all milestones done, CI green at `4310f43`). Each item is
written as a self-contained brief: hand one to an agent as-is. Read [CLAUDE.md](../../CLAUDE.md)
first; it has commands, layout and design rules.

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

### A1. Large flows are unreadable at the "All" level

- **Problem:** packet-handling at level=all fits at ~0.6 zoom; nested group boxes (module ▸
  folder ▸ file) make the graph wide/tall and labels illegible. Modules/Folders read well.
- **Approach:** choose the initial level from size (e.g. the deepest level whose fitted zoom
  stays ≥ 0.85; persist the user's choice once they change it). Reduce group overhead: lighter
  file boxes (header-only label, smaller padding), or hide file boxes when a folder holds one file.
  Consider a min zoom for fitView with scroll instead of shrinking.
- **Accept:** screenshots of `packet-handling` and `startup` at default level have labels
  readable at 100% browser zoom; `examples/lua` flows (load them into the dev harness, or add a
  harness param for another `.flowbook` dir) also open readable.

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

### A5. Bundle size (3 MB, 766 kB gzip)

- **Sources:** `elkjs/lib/elk.bundled.js` (~1.6 MB), shiki cpp grammar, zod pulled in through core.
- **Approach:** stop importing zod in the webview. Split core's entry so the browser imports
  only `grouping`, `project`, `protocol` types and the plain TS record types (e.g. a
  `@flowbook/core/browser` export without `schema.ts` runtime). This also removes the CSP
  console violation from zod's `new Function` probe. Measure before/after.
- **Accept:** no `new Function` CSP violation in the webview console; bundle size reported.

### A6. High-contrast theme check

- Screenshot with `body.vscode-high-contrast` / `vscode-high-contrast-light` variables and
  fix contrast issues (status dots, dimmed edges, diff colours).

## Track B — Extension (`packages/extension`)

### B1. Ship the CLI with the extension

- **Problem:** agents in other repos have no `flowbook` command (the skill tells them to ask).
- **Approach:** bundle `packages/cli/dist/flowbook.js` + wasm into the vsix (`dist/cli/`).
  Add command "Flowbook: Install CLI" that writes a small shim to `~/.local/bin/flowbook`
  (Windows: `.cmd`) pointing at the extension's copy, and a command that copies the agent skill
  into the open repo (`.claude/skills/flowbook/`). Update SKILL.md's CLI section to match.
- **Decision for the user first:** vsix-bundled CLI vs. publishing `@flowbook/cli` to npm (can do both).

### B2. Smoke-test the remaining webview messages

- **Problem:** `test/suite.cjs` doesn't exercise `openCode`, `requestSnippet`, `requestDiff`.
- **Approach:** expose a test-only command (or use the panel host directly) to post those
  messages and assert: editor opens at the symbol line, snippet text contains the function,
  diff after editing a fixture function in a temp copy contains `-`/`+` lines.

### B3. Live reload on unsaved edits (nice to have)

- Debounced `onDidChangeTextDocument` for C/C++ docs → recompute anchor states for open panels
  using editor text. Keep disk-based reload for flow files.

## Track C — Resolver / CLI / skill (`packages/resolver`, `packages/cli`, `skill/`)

### C1. Hint for wrong anchor file paths

- **Problem (from Lua dogfooding):** `source file not found: lua.c` gives no hint.
- **Approach:** in `checkAnchors`/`anchorDiagnostics`, when a file is missing, search the root
  (bounded, skip `node_modules`, `.git`, build dirs) for files with the same basename and suggest
  them: `did you mean src/lua.c?`. Cache the file index per check run. CLI test.

### C2. Lua example in CI

- Add a CI job (or step) that runs `examples/lua/fetch.sh` and
  `pnpm flowbook check --strict --root examples/lua`. Cache the clone. Fails if the skill-written
  flows drift from Lua 5.4.7.

### C3. Second dogfooding round

- After B1, run a fresh agent with only SKILL.md + the CLI on a C++-heavy project (e.g. a small
  part of `leveldb` or `fmt`) to stress namespaces, templates, overloads and classes. Collect a
  friction log; fix resolver/skill gaps. Add the flows as `examples/<name>/`.

## Track D — Repo / release (root files)

### D1. README

- Replace the stub with: what Flowbook is, a screenshot of each view (from the dev harness),
  install (vsix), quick start for agents (skill + CLI), file format summary linking
  `skill/flowbook/references/schema.md`, development commands.

### D2. License — **needs the user's decision** (MIT vs Apache-2.0). Then add `LICENSE`, set

`license` in package.json files, drop `--skip-license` from the extension's package script.

### D3. Marketplace publishing (later)

- Publisher account, icon PNG (128×128), `galleryBanner`, categories/keywords, CHANGELOG,
  release workflow publishing to VS Code Marketplace and Open VSX on tags.

## Decisions already made (don't re-litigate)

Agents write, humans read (UI read-only + "copy agent prompt"); one JSONL file per flow;
C/C++ via tree-sitter (no clangd); anchors without line numbers; fingerprint + verified commit
for staleness; collapsible nested groups instead of fixed view levels; React Flow + ELK;
flowchart + sequence views; blocks drawn as frames only in the sequence view (badges +
highlight in the flowchart); ELK on the main thread (no worker under the webview CSP).

## Done

- v0.1 rebuild — core, resolver, CLI, webview, extension, skill, Lua example, CI (`4310f43`).
