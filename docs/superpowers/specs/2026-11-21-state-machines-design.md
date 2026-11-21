# Design 2 — State machines

Date: 2026-11-21. Status: written by the coordinator under the user's autonomy ruling; **waiting
for the user to skim before any build** (user instruction). Builds on design 1 (connection
points) and 1b (rule format follow-ups).

## Intent

Protocol stacks are state machines. Someone new to i-link or p-net wants to know: which states a
machine has, which transitions exist, what event causes each, and what each transition sets off
(a job posted, a timer started, a callback into the application). Today they read switch
statements and transition tables by hand. Flowbook already finds the "sets off" part (design 1
sites and pairings); design 2 finds the transitions with the same approach: **rules find the
sites in the code, the agent confirms what rules cannot know, `flowbook check` keeps it honest.**

Success, measured on the pinned examples:

- p-net CMSM (`pf_cmsm.c`): exactly the transitions a reader finds — IDLE → RUN on
  `PNET_EVENT_STARTUP` (sets off the `sched` timeout `pf_cmsm_timeout`), RUN → IDLE on
  `PNET_EVENT_DATA`/`PNET_EVENT_ABORT`, RUN → IDLE in the timeout.
- p-net CMDEV (19 setter calls) and i-link DL message handler (assignments inside per-state
  functions): at least 90 % of transitions get a known source state without `scope` records.
- i-link CM (table-driven, `cm_trans_s0..7`): one transition per table row, source state from the
  machine record's table map, action function linked.
- `flowbook states` on p-net runs in the same scan as `sites` (no second parse pass; cold time
  within 10 % of today's 1.2 s).

## Goals / non-goals / anti-goals

- Goals: machine records; transitions found in the three shapes seen in the examples; source
  state, event and triggered sends per transition; `flowbook states`; `check` diagnostics;
  editor lenses on transition sites; a read-only state diagram in the webview; skill guidance;
  machines for both examples.
- Non-goals: data-flow analysis of the state variable; guards as expressions (shown as source
  text only, when on one `if`); hierarchical / orthogonal states; generating code; flows that
  anchor to a transition (later, if asked).
- Anti-goals: one confirmation record per transition (the F4 lesson: boilerplate an agent writes
  unread); line numbers in records; editing in the UI.

## Evidence (from the examples)

| Shape                  | Where                                                                                                                                                          | What gives the source state                                                  |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| A. Setter in a case    | p-net `pf_cmsm_cmdev_state_ind`: `switch (p_ar->cmsm_state) case IDLE: switch (event) case PNET_EVENT_STARTUP: pf_cmsm_set_state (p_ar, RUN)`                  | the innermost enclosing `case` that is a state; the event is a nested `case` |
| B. Per-state functions | i-link `iolink_dl_message_h_sm`: `case IOL_DL_MH_ST_STARTUP_2: iolink_dl_message_h_sm_startup2 (port)`; inside it `dl->message_handler.state = …_PREOPERATE_6` | the `case` that calls the enclosing function                                 |
| C. Transition tables   | i-link `iolink_cm.c:650`: `cm_trans_s0[] = {{CM_EVENT_IOL_MANUAL, CM_STATE_SM_Startup, cm_startup}, …}`, the array index is the source state                   | which table the row is in; the table → state map is not in the code as names |
| D. Outside any state   | p-net `pf_cmdev.c:4754` (initialisation), setters in helpers                                                                                                   | nothing; shown as "any"                                                      |

Shape C is in five i-link modules (CM, DS, ODE, AL, SM); shape B in DL (74 assignments); shape A
in p-net (59 setter calls in 9 files).

## Approaches considered

1. **Rules find transitions; the machine record carries what the code does not say (picked).** A
   `machine` record names the state pattern, the matchers that set the state (the design-1
   `call`/`assign` matchers, key = target state) and, for tables, the row layout and the table →
   state map. The source state is derived from the code where it can be (shapes A, B) and
   confirmed by the agent only where it cannot (shape C map, `scope` records for D).
2. **Agent-written machines** (a new hand-written flow type with states and transitions,
   fingerprinted like flow nodes). Simple and flexible, but nothing finds a transition the agent
   missed, and every transition is a record — the boilerplate design 1b just removed.
3. **Full static analysis** (track the state variable through assignments and calls). Needs
   types and data flow tree-sitter does not give; out of scope by the product direction (no
   clangd).

## Design

### Records — `.flowbook/machines.jsonl`

A separate file, so machines read as their own list; parsed and validated by core like
`connections.jsonl`, scanned in the same pass. Strict records, unique ids.

```jsonl
{"kind":"machine","id":"cmsm","title":"CM state machine","states":"PF_CMSM_STATE_.*","events":"PNET_EVENT_.*","set":[{"call":"pf_cmsm_set_state","key":2}],"files":["src/src/device/pf_cmsm.c"],"context":"p-net main thread"}
{"kind":"machine","id":"cm","title":"Configuration manager","states":"CM_STATE_.*","tables":[{"rows":"cm_trans_s[0-9]+","event":1,"to":2,"action":3,"from":{"cm_trans_s0":"CM_STATE_CheckPortMode","cm_trans_s1":"CM_STATE_SM_Startup"}}]}
{"kind":"scope","id":"cmdev-init","machine":"cmdev","state":"PF_CMDEV_STATE_POWER_ON","in":[{"file":"src/src/device/pf_cmdev.c","symbol":"pf_cmdev_init"}]}
```

`machine` fields: `id`, `title`, `states` (regex, whole name), `events?` (regex), `set?`
(matchers: `call` with `key`, or `assign` with `"as":"key"`; `keyMember` and `keys` allowed;
sites whose key does not match `states` are dropped), `tables?` (`rows` regex on the array
name; `event`/`to`/`action` as 1-based positions or designator field names; `from` map from
array name to state), `files?` (globs), `context?`, `notes?`. At least one of `set` / `tables`.

`scope` fields: `id`, `machine`, `state`, `in` (anchors): every set site inside those functions
has that source state. It is the agent's confirmation for shape D, one record per function group,
not per transition.

### Finding transitions (resolver `machines.ts`, called from the scan)

Per file, after the connection sites:

- **Set sites**: the `set` matchers, collected by the existing matcher code (target = key).
- **Source state**, first that applies: (a) innermost enclosing `case` whose value matches
  `states` → `via: "case"`; (b) a `scope` record covering the enclosing function → `via:
"scope"`; (c) the enclosing function is called, in the same file, from inside exactly one state
  `case` block → `via: "caller"`; (d) otherwise `from: "*"`, `via: "none"`.
- **Event**: innermost enclosing `case` matching `events` (when given); otherwise the enclosing
  function's name (`via` the function). For table rows, the `event` column.
- **Region and triggers**: the statements of the innermost enclosing `case` block (to the next
  label or the end of the switch), else the enclosing function. Every design-1 send site inside
  the region is a trigger, shown with its pairing. For table rows, the region is the body of the
  `action` function.
- **Guard**: when the set site is inside one `if` within the region, its condition text
  (compacted, max 80 chars). Display only.
- **States list**: every `case` label matching `states` in the machine's files, plus every
  `from`/`to` seen.
- **Table rows**: an array declaration whose name matches `rows`, each element an initializer
  list; positional or designated columns. Row comment `/* T5 */` is kept as `label` when present
  on the same line (i-link and the IO-Link spec name transitions this way).

Cache: machine records join the scan's rules key, so editing them invalidates the cache like
editing rules. Prefilter literal fragments come from `set` names and `rows` names.

### Index and checks (resolver)

`buildMachineIndex(machines, scans, connectionIndex)` → per machine: `states`, `transitions`
(`{from, to, event?, via, guard?, label?, site, triggers: Pairing[]}`), and diagnostics:

- error: `states`/`events`/`rows` invalid regex; unknown machine in a `scope`; unresolved scope
  anchor; scope function without a set site; a `from` map key that matches no table, or a value
  that does not match `states`.
- warning: a machine with no transition; a state in a `from` map or `scope` that is never a
  target or a case label (typo guard).
- info (counted, not a warning, so `--strict` stays usable): transitions with source `"*"`.

`flowbook check` reports them with the connection diagnostics.

### CLI

`flowbook states [--machine <id>] [--unknown] [--json]`. One line per transition:

```
src/src/device/pf_cmsm.c:183: cmsm IDLE → RUN on PNET_EVENT_STARTUP · sets off sched → pf_cmsm_timeout
src/src/device/pf_cmdev.c:4754: cmdev * → W_CIND in pf_cmdev_init
```

State names drop the longest common prefix of the machine's states for display (`PF_CMSM_STATE_`).
Summary per machine: `cmsm: 2 states, 4 transitions (4 from a case), 1 sets off`.

### Extension and webview

- Lens on each transition site: `↳ CM state machine: IDLE → RUN on PNET_EVENT_STARTUP`. Command
  `Flowbook: Show State Machine` (also from the lens) opens the machine view.
- Webview `machine` view: states as nodes, transitions as edges labelled by event (and `label`
  when present), laid out with the existing ELK setup; `*` drawn as one "any state" node.
  Selecting an edge shows the side panel with the site snippet, guard and triggered sends with
  `Go to` links (existing snippet/jump messages). Read-only.
- Protocol: `HostMessage` gains `{type:"machine", payload: MachinePayload}`; webview and
  extension change in one task (CLAUDE.md rule).

### Skill

New section: write a `machine` per state variable, starting from `flowbook sites`-style output of
`flowbook states --unknown`; add `scope` records only for functions read; for tables, read the
table-of-tables once and write the `from` map.

### Examples

p-net: `cmsm`, `cmdev`, `cmpbe`, `cmio`, `ppm`, `cpm` machines. i-link: DL message handler and
mode handler (shape B), CM table (shape C, 8-entry map). READMEs gain a "State machines"
section with measured counts and the unknown-source list with reasons.

## Build order (milestones, each shippable)

1. Core records + validation + schema docs.
2. Resolver: set sites, source state (a–d), events, regions/triggers, table rows; index + checks.
3. CLI `states` + `check` integration; fixture machine (all four shapes); skill.
4. Examples + READMEs (success numbers above measured here).
5. Extension lenses + `Show State Machine`; webview machine view + protocol.

Milestones 1–4 are useful without UI; if time runs short, 5 waits.

## Left to the builder

Exact diagnostic wording; prefix trimming details; ELK options for the machine view; whether
guard extraction covers `else if` chains (one level is enough).
