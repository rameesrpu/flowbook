# Rule Format Follow-ups (Design 1b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Member keys, key filters, forwarding sites and dispatcher connections, so i-link's
mailboxes pair and the keyed-connection boilerplate in both examples collapses.

**Architecture:** Schema and validation in `packages/core/src/connections.ts`; site derivation in
`packages/resolver/src/sites.ts`; pairing, summaries and connection checks in
`packages/resolver/src/pairing.ts`; display in the CLI `sites` command and the extension's
`connections-model.ts`. No protocol change.

**Tech Stack:** TypeScript, zod, web-tree-sitter (C/C++), vitest, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-11-21-rule-format-followups-design.md`

## Global Constraints

- Node: `export PATH=$HOME/.nvm/versions/node/v22.23.4/bin:$PATH` before every command.
- Every new field is optional; existing rule files keep their meaning.
- `.strict()` schemas: unknown fields stay errors.
- Never store line numbers in records. Core stays free of Node APIs.
- Implementers do not commit and do not run `pnpm add`/`install`. The coordinator runs the CI
  sequence (`pnpm build && pnpm typecheck && pnpm lint && pnpm exec prettier --check . && pnpm test && pnpm flowbook check --strict --root fixtures/cpp-sample && pnpm --filter flowbook package`) and commits.
- Tests run after `pnpm build` of core and resolver (`pnpm build` builds all).

## Review Focus

1. `keyMember` on an argument that is a call (`get_box (port)`) or a cast `(void *)p->mbox`:
   expect cast unwrapped → `mbox`; call → compact text, not a crash. (Task 2 test.)
2. Forwarding: a parameter shadowed by a local of the same name is still treated as forwarding
   (accepted; documented). A K&R or `void` parameter list gives no parameters. (Task 2 test for
   `(void)`.)
3. A dispatcher anchor that does not resolve must not confirm anything and must report the same
   "no definition for" error as anchored connections. (Task 3 test.)
4. An exact keyed connection and a dispatcher both covering a key: the keyed one gives the title;
   both confirm. (Task 3 test.)
5. `keys` drops a site whose key is missing (call with fewer arguments than `key`). (Task 2 test.)

---

### Task 1: Core schema and validation (Sonnet)

**Files:**

- Modify: `packages/core/src/connections.ts`
- Modify: `skill/flowbook/references/schema.md` (Matchers and `connection` sections)
- Test: `packages/core/src/connections.test.ts`

**Interfaces:**

- Produces: `call` matcher `{call, key?, handler?, keyMember?: true, keys?: string, files?}`;
  `assign` matcher `{assign, as, keyMember?: true, keys?: string, files?}`;
  `isDispatcherForm(c: ConnectionRecord): boolean` exported from core (`key` undefined, `send`
  undefined, `receive` non-empty). `keyMember` is `z.literal(true)`.

- [ ] **Step 1: Failing tests** in `connections.test.ts`, `describe('1b rule fields')`:
  - `accepts keyMember and keys on call and assign` → `diag(...)` is `[]` for
    `{"call":"post","key":1,"keyMember":true,"keys":"BOX_.*"}` and
    `{"assign":"type","as":"key","keyMember":true,"keys":"JOB_(A|B)"}`.
  - `rejects keyMember without a key` → call without `key`: message
    `"keyMember" needs "key"`; assign with `"as":"handler"`: `"keyMember" needs "as": "key"`.
  - `reports an invalid keys expression` → `"keys":"("` gives a message starting
    `invalid regular expression "("`.
  - `accepts a dispatcher connection` → `{"kind":"connection","id":"d","rule":"job","title":"T","receive":[{"file":"a.c","symbol":"main"}]}` with a rule that has `receive` → `[]`.
  - `rejects send without receive` → message `an anchored connection needs non-empty "send" and "receive"`.
  - `rejects a dispatcher on a rule without receive matchers` → message
    `dispatcher connection "d": rule "timer" has no "receive" matchers`.
  - Missing all three: message `a connection needs "key", "receive", or "send" and "receive"`.
- [ ] **Step 2:** `pnpm --filter @flowbook/core test` → the new tests fail.
- [ ] **Step 3: Implement** the zod fields and the checks in `validateConnections` (regex check of
      `keys` uses `matcherRegex`, same message form as names). Export `isDispatcherForm` from
      `connections.ts` and `index.ts`.
- [ ] **Step 4:** Update `schema.md`: matcher table gains `keyMember` and `keys` (one paragraph on
      key derivation order from the spec); `connection` gains the **Dispatcher** form bullet. Keep
      the strict-field note.
- [ ] **Step 5:** `pnpm build && pnpm --filter @flowbook/core test` → pass;
      `schema/flowbook.schema.json` regenerated.

### Task 2: Site derivation — keyMember, keys, forwards (Opus, reviewed)

**Files:**

- Modify: `packages/resolver/src/sites.ts`
- Test: `packages/resolver/src/sites.test.ts`

**Interfaces:**

- Consumes: Task 1 matcher fields.
- Produces: `Site.forwards?: { param: string; position: number }` (1-based). Set on send sites
  only, when the site's key — or, with no key, its handler — is an identifier equal to a
  parameter name of the enclosing `function_definition`.

- [ ] **Step 1: Failing tests** (inline C via `scan(path, text, rules)`):
  - `keyMember takes the last member` → `os_mbox_post (port->master->mbox_avail, j, 0)` and
    `os_mbox_post (master->mbox_avail, j, 0)` and `post (&boxes[i].mbox)` and
    `post ((void *)p->mbox)` with `{"call":"os_mbox_post|post","key":1,"keyMember":true}` give
    keys `mbox_avail`, `mbox_avail`, `mbox`, `mbox`; `post (get_box (port))` gives
    `get_box(port)`.
  - `keyMember on assign` → `job->box = port->master->mbox;` with
    `{"assign":"box","as":"key","keyMember":true}` → key `mbox`.
  - `keys filters sites` → `job->type = JOB_NONE; job->type = JOB_EXIT;` with
    `"keys":"JOB_EXIT"` → one site, key `JOB_EXIT`; `post ()` with `key:1,"keys":".*"` → no site.
  - `marks forwarding sites` → `void wrap (int a, int type, cb_t cb) { post (type, cb); }` with
    `{"call":"post","key":1,"handler":2}` → `forwards: {param:"type", position:2}`;
    `void w2 (cb_t cb) { tadd (cb); }` with `{"call":"tadd","handler":1}` →
    `{param:"cb", position:1}`; `job->type = type;` inside `void h (int type)` with an assign key
    matcher → `{param:"type",position:1}`; `post (JOB_A, cb)` → no `forwards`; a receive site
    never has `forwards`; `void v (void) { post (x, y); }` → no `forwards`.
- [ ] **Step 2:** `pnpm --filter @flowbook/resolver test sites` → fail.
- [ ] **Step 3: Implement.** `keyOf(node, member: boolean): string` replaces the inline
      `compact(args[key-1])` for call and assign keys: unwrap `parenthesized_expression`,
      `cast_expression` (its `value`), `pointer_expression` with `&`; with `member`, a
      `field_expression` gives its `field` text, an identifier gives itself; else `compact`. Apply
      `keys` (compiled once per matcher in `compile`, skip matcher if invalid) in `add`'s callers before
      pushing. Parameters: walk `at.parent` to the nearest `function_definition`, read
      `declarator` (unwrap pointer/reference declarators) → `function_declarator.parameters` →
      each `parameter_declaration`'s innermost identifier; cache per definition node id.
- [ ] **Step 4:** resolver tests pass; existing tests unchanged.

### Task 3: Pairing — dispatchers, forwarding, summaries, checks (Opus, reviewed)

**Files:**

- Modify: `packages/resolver/src/pairing.ts`
- Test: `packages/resolver/src/pairing.test.ts`

**Interfaces:**

- Consumes: `Site.forwards` (Task 2), `isDispatcherForm` (Task 1).
- Produces: `Pairing.forwarded?: true`; `RuleSummary.forwarding: number` (forwarding send
  sites without reactors; they are no longer in `unpaired`); dispatcher records confirm reactors.

- [ ] **Step 1: Failing tests** — build an index from inline sources with `scanSources` (see
      existing tests for the helper) and a `Connections` object:
  - `a dispatcher confirms key reactors inside its function` → rule `{send:[{call:"post",key:1}],receive:[{case:"J_.*"}]}`, sources with `post (J_A)` / `post (J_B)` and `void disp (int t) { switch (t) { case J_A: case J_B: break; } }`, dispatcher on `disp` → both key reactors `confirmed: true`, pairing `connection` = dispatcher id and its `title`.
  - `a dispatcher does not confirm receive sites outside its function` → a second `case J_C` in
    `other ()` stays unconfirmed.
  - `keyed connection wins for title` → keyed `J_A` + dispatcher: `title` from keyed, confirmed.
  - `dispatcher errors` → unresolved anchor: `no definition for a.c#nope`; function without a
    receive site: `a.c#helper has no receive site of rule "r"`; neither confirms anything.
  - `forwarding sites are not missing a receive` → `void wrap (int type) { post (type); }` with
    receive matchers: `missingReceive` undefined, `forwarded: true`; summary `forwarding: 1`,
    `unpaired` excludes it.
  - `warns when no matcher covers the wrapper` → no `{call:"wrap"}` matcher: warning on the rule
    record `send site in wrap (a.c) forwards parameter "type"; no send matcher of rule "r" matches calls to wrap; add {"call":"wrap","key":1}`; adding `{call:"wrap",key:1}` removes it.
  - `registered reactors are confirmed by a dispatcher` → assign-handler receive inside the
    dispatcher function gives `registered … true`.
- [ ] **Step 2:** fail.
- [ ] **Step 3: Implement.** `Context.dispatchers: { record; functions: Definition[] }[]` built in
      `buildContext` (resolve with `resolveAnchor`). In `pairSend`: a key receive site `r` is
      confirmed when `confirms || insideDispatcher(r)`; same for `registeredReactors` per receive site.
      Connection fallback order: keyed, covering anchored, dispatcher holding `byKey[0]`.
      `missingReceive` false when `send.forwards`. New `checkDispatchers` and `checkForwarding`
      (one warning per enclosing function; it is covered when the name regex of any `call` send
      matcher of the rule matches the function's leaf symbol; `files` is ignored). `ruleSummaries`: forwarding silent sends go to `forwarding`.
- [ ] **Step 4:** pass; whole resolver suite green.

### Task 4: CLI and extension display (Sonnet)

**Files:**

- Modify: `packages/cli/src/commands.ts`, `packages/extension/src/connections-model.ts`
- Test: `packages/cli/src/cli.test.ts`, the extension's connections-model test file

**Interfaces:**

- Consumes: `Pairing.forwarded`, `Site.forwards`, `RuleSummary.forwarding`.

- [ ] **Step 1: Failing tests:**
  - CLI `sites` line for a forwarding send without reactors:
    `<file>:<line>: job send type → forwards parameter type (argument 2 of wrap)`; with reactors,
    the usual reactor text and no `· no receive site`.
  - Summary line appends `, 1 forwarding` when non-zero; `--json` rows carry `forwards` and
    `forwarded: true`; `--unpaired` omits forwarding sites.
  - Extension `sendLensTitle` for a forwarding pairing without reactors:
    `↳ forwards parameter \`type\` to callers of wrap`; `agentPrompt` is not produced for it
    (whatever function the lens uses to decide on a prompt returns none).
- [ ] **Step 2:** fail. **Step 3:** implement; replace `index.pairings.find` per row in `sites`
      with a `Map<Site, Pairing>` built once. **Step 4:** `pnpm test` green.

### Task 5: Fixture, skill and examples (Opus, integration)

**Files:**

- Modify: `fixtures/cpp-sample/src/rt/*.c`, `fixtures/cpp-sample/.flowbook/connections.jsonl`,
  tests that pin fixture output; `skill/flowbook/SKILL.md`; `examples/i-link/.flowbook/connections.jsonl`,
  `examples/i-link/README.md`, `examples/p-net/.flowbook/connections.jsonl`, `examples/p-net/README.md`.

- [ ] **Step 1: Fixture.** Add: a mailbox posted as `rt->box` and fetched as `ctx->rt->box` paired
      with `keyMember` (new rule `rtbox` or change `mbox`; keep the anchored `main-box` example
      working); a wrapper forwarding its key (`job_post_typed (int type)` → `job_post (type, …)`)
      with a matching wrapper matcher; a `keys` filter on an assign; a dispatcher connection for the
      `event` rule. Re-stamp: `pnpm flowbook stamp --all --root fixtures/cpp-sample`;
      `pnpm flowbook check --strict --root fixtures/cpp-sample` clean. Update pinned fixture
      expectations in tests.
- [ ] **Step 2: Skill.** `SKILL.md` connection section: use `keyMember` for handles reached
      through different pointer chains; `keys` to drop resets; one dispatcher connection per
      function the agent read, keyed connections only to name a single pairing; forwarding sites
      and the warning's matcher hint.
- [ ] **Step 3: i-link** per the spec (mbox keyed by member with 3 keyed connections, `master-mbox`
      removed; job dispatcher on `iolink_main` replacing 37 keyed records; assign
      `keys: "IOLINK_JOB_(PD_EVENT|EXIT)"`; dl-event dispatcher on `dl_main` replacing 8). Run
      `pnpm flowbook sites --root examples/i-link` and `check`; expected `mbox: 9 send, 4 receive, 3 keys paired (3 confirmed), 0 unpaired`.
- [ ] **Step 4: p-net**: `bg` 10 keyed → one dispatcher on `bg_worker_task`; confirm `sched`
      reports `1 forwarding`, `0 unpaired`.
- [ ] **Step 5: READMEs**: replace the Results summaries with the new output, rewrite both
      unpaired tables (remove rows now paired/forwarded/filtered, keep the rest with reasons),
      describe the new records. Re-time p-net's cold `sites` (median of three) and update if it moved
      more than 10 %.
- [ ] **Step 6:** CI sequence green.

### Final review (most capable model)

Whole-branch review against the spec; fix findings; update `docs/tracker.md` and the backlog (F1–F4
to Done, F5 remains with the spec's notes).
