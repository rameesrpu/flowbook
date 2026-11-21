# State Machines (Design 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Status:** not started. The user skims the design before the build (instruction of
> 2026-11-21).

**Goal:** Find state-machine transitions in C/C++ (setter in a `case`, per-state functions,
transition tables) from `machine` records, link each transition to the design-1 sends it sets
off, and show them in `flowbook states`, `check`, editor lenses and a webview state diagram.

**Architecture:** `machine`/`scope` records in `.flowbook/machines.jsonl`, parsed by core into
the existing `Connections` object (so the scan, its cache key and the workspace loader carry them
without new plumbing). The scan collects transition sites per file next to connection sites;
`buildMachineIndex` derives source states across files and attaches pairings from the existing
`ConnectionIndex`. CLI, extension and webview consume the index.

**Tech Stack:** TypeScript, zod, web-tree-sitter, vitest, React 18 + @xyflow/react + elkjs.

**Spec:** `docs/superpowers/specs/2026-11-21-state-machines-design.md`

## Global Constraints

- Node: `export PATH=$HOME/.nvm/versions/node/v22.23.4/bin:$PATH`.
- Records strict, ids unique per file, never line numbers; core free of Node APIs.
- Schema changes: `core/src/*.ts`, `skill/flowbook/references/schema.md`, fixture and examples
  together; rebuild core to regenerate the JSON Schema.
- Protocol changes touch webview and extension in the same task.
- Webview: strict CSP, single bundle, ELK on the main thread.
- Source state `"*"` is counted, never a warning (`--strict` stays usable).
- Cold `flowbook sites` on p-net within 10 % of the 1b measurement.
- Implementers don't commit or install; coordinator runs the CI sequence and commits per task.

## Review Focus

1. A set site inside a `case` of a switch on something else (`switch (event)`) whose label does
   not match `states`: must fall through to the next derivation, not take the event as state.
   (Task 3 test.)
2. A per-state function called from two different state cases: source is ambiguous → `"*"` with
   `via: "none"`, not the first caller. (Task 3 test.)
3. A transition table row with fewer columns than `to`: skipped, no crash. (Task 2 test.)
4. Fall-through cases (`case A: case B: set (C)`): two transitions, A → C and B → C. (Task 3 test.)
5. A machine whose `set` matcher also matches outside `files`: ignored there. (Task 2 test.)

---

### Task 1: Core records (Sonnet)

**Files:** Create `packages/core/src/machines.ts` (+ `machines.test.ts`); modify
`packages/core/src/connections.ts` (`Connections` gains `machines`, `scopes`),
`packages/core/src/workspace.ts` (`loadWorkspace(config, flowFiles, connectionsFile?, machinesFile?)`),
`packages/core/src/index.ts`, `packages/core/src/emit-schema.ts`, `packages/resolver/src/fs.ts`
(`readWorkspace` reads `.flowbook/machines.jsonl` when present), `skill/flowbook/references/schema.md`.

**Interfaces — Produces:**

- `MACHINES_FILE = '.flowbook/machines.jsonl'`.
- `MachineRecord`: `{kind:'machine', id, title, states: Name, events?: Name, set?: (call with key | assign as key)[], tables?: TableSpec[], files?, context?, notes?}`, at least one of `set`/`tables`.
- `TableSpec`: `{rows: Name, event: Position|string, to: Position|string, action?: Position|string, from: Record<string,string>}`.
- `ScopeRecord`: `{kind:'scope', id, machine: Id, state: string, in: Anchor[] (min 1)}`.
- `parseMachines(text, file, diagnostics)`, `validateMachines(m: {machines, scopes}, file): Diagnostic[]`
  (invalid regexes; scope with unknown machine; `from` value or scope `state` not matching `states`;
  `set` matcher without a key).

- [ ] Tests in `machines.test.ts`: parses the three spec example lines; each validation message;
      unknown field rejected; `loadWorkspace` with a machines file fills `connections.machines`.
- [ ] Implement; regenerate the JSON Schema; document both records in `schema.md`.

### Task 2: Transition sites per file (Opus, reviewed)

**Files:** Create `packages/resolver/src/machines.ts` (+ `machines.test.ts`); modify
`packages/resolver/src/sites.ts` (export the matcher compilation and key helpers it needs),
`packages/resolver/src/resolver.ts` (`scan(path, text, rules, machines?)`),
`packages/resolver/src/scan.ts` (`rulesKeyOf` includes machines and scopes' files; prefilter
fragments from `set` names and `rows`; `scanRoot` runs when rules _or_ machines exist).

**Interfaces — Produces:**

- `FileScan.transitions: TransitionSite[]` where `TransitionSite = {machine, file, line, column, symbol?, sig?, to: string, fromCases: string[] /* state case labels enclosing the site, innermost group incl. fall-through */, event?: string, guard?: string, label?: string, kind: 'set'|'row', action?: string, table?: string, region: {startLine, endLine}}`.
- `FileScan.stateCalls: {machine, state: string, callee: string}[]` — calls made directly inside
  a state `case` block (for "per-state function" derivation in Task 3).
- `FileScan.stateLabels: {machine, state}[]` — every state `case` label.

- [ ] Tests (inline C): setter in nested switch gives `fromCases ['IDLE']`, `event 'EV_START'`,
      region = the event case block; fall-through `case A: case B:` gives `['A','B']`; assign form
      with `keyMember`; target not matching `states` dropped; `case` on events only gives
      `fromCases []`; table rows positional and designated, `/* T5 */` label, short row skipped;
      `files` limit respected; guard text from one enclosing `if`; `stateCalls` lists
      `case S: fn (port);`.
- [ ] Implement in `machines.ts` (`collectTransitions(tree, file, machines, symbols)`), called from
      `Resolver.scan`.

### Task 3: Machine index and checks (Opus, reviewed)

**Files:** Create `packages/resolver/src/machine-index.ts` (+ test); modify
`packages/resolver/src/index.ts`.

**Interfaces — Produces:**

- `buildMachineIndex(connections: Connections, scans: Map<string, FileScan>, index: ConnectionIndex): MachineIndex`
- `MachineIndex = {machines: MachineView[]; diagnostics: Diagnostic[]}`;
  `MachineView = {id, title, context?, states: string[], prefix: string, transitions: Transition[]}`;
  `Transition = {from: string /* state or '*' */, to, event?, via: 'case'|'scope'|'caller'|'table'|'none', guard?, label?, site: Target, action?: Target, triggers: Pairing[]}`.
- `machineSummaries(mi): {machine, states, transitions, unknown, setsOff}[]`.

- [ ] Tests: derivation order case → scope → caller → none; caller ambiguous → `'*'`; table rows
      use `from` map (`via 'table'`) and resolve `action` to its definition; triggers = pairings
      whose send site lies in the region (rows: in the action function); every diagnostic listed in
      the spec's "Index and checks"; `prefix` is the longest common `_`-boundary prefix.
- [ ] Implement; `check` integration is Task 4.

### Task 4: CLI `states`, `check`, fixture, skill (Sonnet)

**Files:** `packages/cli/src/commands.ts`, `main.ts`, `cli.test.ts`; fixture
`fixtures/cpp-sample/src/rt/*.c` + `.flowbook/machines.jsonl`; `skill/flowbook/SKILL.md`.

- [ ] Tests: `states` line format and summary exactly as in the spec; `--machine`, `--unknown`,
      `--json`; `check` prints machine diagnostics and counts unknown sources in its summary.
- [ ] Fixture: one machine per shape (A, B, C, D with a `scope`); re-stamp; `--strict` clean.
- [ ] Skill section from the spec.

### Task 5: Examples (Opus, integration)

**Files:** `examples/p-net/.flowbook/machines.jsonl`, `examples/i-link/.flowbook/machines.jsonl`,
both READMEs.

- [ ] p-net: `cmsm`, `cmdev`, `cmpbe`, `cmio`, `ppm`, `cpm`; i-link: DL message handler, DL mode
      handler, CM table (8-entry `from` map read from `iolink_cm_fsm[]`). Verify the spec's success
      numbers; README "State machines" section with measured counts and the unknown-source list
      with reasons; re-time cold `sites`.

### Task 6: Lenses, command and machine view (Opus, integration, reviewed)

**Files:** `packages/core/src/protocol.ts` (`HostMessage` `{type:'machine', payload: MachinePayload}`;
`WebviewMessage` `{type:'openMachine', id}`), `packages/extension/src/machines-lens.ts`,
`extension.ts`, `panel.ts`, `package.json` (command `flowbook.showMachine`),
`packages/webview/src/machine/*`, `App.tsx`.

- [ ] Pure model tests for the lens title (`↳ <title>: IDLE → RUN on PNET_EVENT_STARTUP`) and the
      payload builder (extension, no `vscode` import).
- [ ] Webview: states as nodes, transitions as labelled edges via ELK, one `*` node; edge
      selection → side panel with snippet, guard and triggers with `Go to` links. Screenshot with
      headless Chrome on the fixture (CLAUDE.md command, `view=machine`) in light and dark.
- [ ] e2e smoke: the command opens the panel on the fixture.

### Final review (most capable model)

Whole-branch review against the spec; tracker and backlog updated.
