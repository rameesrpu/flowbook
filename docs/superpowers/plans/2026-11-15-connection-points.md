# Connection Points and the Editor Jump Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a line that posts, sets or schedules something, show where it will be executed and jump there, and the reverse on the receiving side.

**Architecture:** Per-codebase rules in `.flowbook/connections.jsonl` tell a tree-sitter scan where send and receive sites are. A pure pairing step joins sites by key, by named handler, or by agent-written `connection` records, and reports claims the code does not back. The CLI exposes the result as `flowbook sites` and inside `check`; the extension turns it into CodeLenses and two jump commands.

**Tech Stack:** TypeScript, zod 4, web-tree-sitter (C and C++ grammars), picomatch (already a `core` dependency), vitest, VS Code extension API 1.90. No new dependencies.

**Spec:** [docs/superpowers/specs/2026-11-15-connection-points-design.md](../specs/2026-11-15-connection-points-design.md). Read it before any task. Where this plan and the spec disagree, the spec wins; report the disagreement.

## Global Constraints

- Node 22 is not on PATH in non-interactive shells. Prefix every command with `export PATH=$HOME/.nvm/versions/node/v22.23.4/bin:$PATH`.
- Implementers never run `pnpm add` or `pnpm install`, and never commit. The coordinator reviews, runs the CI sequence and commits one task per commit.
- CI sequence, run by the coordinator before each commit: `pnpm build && pnpm typecheck && pnpm lint && pnpm exec prettier --check . && pnpm test && pnpm flowbook check --strict --root fixtures/cpp-sample && pnpm --filter flowbook package`.
- `pnpm test` needs `core` and `resolver` built: run `pnpm build` first.
- `packages/core` imports no Node APIs. The webview bundles it.
- No line number is ever written to a `.flowbook` file. Lines are resolved live.
- Every record schema is `.strict()`: unknown fields are errors.
- `packages/webview` and `packages/core/src/protocol.ts` are not touched by this plan.
- In `packages/extension`, files that are unit-tested must not import `vscode`.
- Lines and columns in TypeScript types are 0-based; lines printed by the CLI and in diagnostics are 1-based.
- Argument positions in matchers are 1-based.
- Matcher names are regular expressions that must match the whole name.
- No source from a third-party stack is committed. `examples/*/src/` is already gitignored.

## Review Focus

Conditions the spec implies but does not list as acceptance tests. Each has a test in the task named.

1. **No `connections.jsonl`, or an empty one.** Everything behaves exactly as today: same `check` output, no lenses, no diagnostics. (Task 1, Task 5, Task 6)
2. **An invalid regular expression in a matcher**, such as `"call":"foo("`. `check` reports one error on that line; nothing throws. (Task 1)
3. **A source file tree-sitter cannot fully parse.** The scan returns the sites from the parts that did parse and never throws. (Task 2)
4. **A file that disappears or becomes unreadable between listing and reading.** It is skipped. (Task 3)
5. **An open document edited but not saved, with lines shifted.** Its lenses sit on the shifted lines. (Task 6)

## File Structure

| File                                                                                  | Responsibility                                                          |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `packages/core/src/connections.ts` (create)                                           | zod schemas, types, `matcherRegex`, `matchesAny`, `validateConnections` |
| `packages/core/src/parse.ts` (modify)                                                 | `parseConnections`                                                      |
| `packages/core/src/workspace.ts` (modify)                                             | `CONNECTIONS_FILE`, `Workspace.connections`, `loadWorkspace` third arg  |
| `packages/core/src/json-schema.ts` (modify)                                           | `connectionsLine` definition                                            |
| `packages/resolver/src/sites.ts` (create)                                             | matchers over one syntax tree → `Site[]`                                |
| `packages/resolver/src/scan.ts` (create)                                              | source walking, prefilter, cache, `scanSources`, `scanRoot`             |
| `packages/resolver/src/pairing.ts` (create)                                           | `buildConnectionIndex`, `sendersOf`, `ruleSummaries`, diagnostics       |
| `packages/resolver/src/fs.ts` (modify)                                                | `readWorkspace` reads `connections.jsonl`; `listSourceFiles`            |
| `packages/cli/src/commands.ts`, `main.ts` (modify)                                    | `sites` command; `check` includes connection diagnostics                |
| `packages/extension/src/connections-model.ts` (create)                                | pure lens text and jump targets                                         |
| `packages/extension/src/connections-lens.ts` (create)                                 | lens provider and the two commands (uses `vscode`)                      |
| `packages/extension/src/host.ts`, `model.ts`, `extension.ts`, `package.json` (modify) | scan in the host, wiring, contributions                                 |
| `fixtures/cpp-sample/src/rt/*`, `.flowbook/connections.jsonl` (create)                | the four shapes                                                         |
| `examples/i-link/`, `examples/p-net/` (create)                                        | `fetch.sh`, rule files, README with measured numbers                    |
| `skill/flowbook/SKILL.md`, `references/schema.md`, `README.md`, `CLAUDE.md` (modify)  | documentation                                                           |

Task order: 1 → 2 → 3 → 4 → 5 → 6 → 7. Each depends on the ones before it; none run in parallel.

---

### Task 1: Fixture and core schema

**Files:**

- Create: `fixtures/cpp-sample/src/rt/rt.h`, `fixtures/cpp-sample/src/rt/jobs.c`, `fixtures/cpp-sample/src/rt/app.c`, `fixtures/cpp-sample/.flowbook/connections.jsonl`
- Create: `packages/core/src/connections.ts`
- Modify: `packages/core/src/parse.ts`, `packages/core/src/workspace.ts`, `packages/core/src/json-schema.ts`, `packages/core/src/index.ts`
- Modify: `skill/flowbook/references/schema.md`
- Test: `packages/core/src/connections.test.ts`

**Interfaces:**

- Consumes: existing `Id`, `Anchor`, `Located`, `Diagnostic`, `SourceFile` from `core`.
- Produces, all exported from `@flowbook/core`:

```ts
export const CONNECTIONS_FILE = '.flowbook/connections.jsonl';
export type Matcher =
  | { call: string; key?: number; handler?: number; files?: string[] }
  | { case: string; files?: string[] }
  | { test: string; files?: string[] }
  | { assign: string; as: 'key' | 'handler'; files?: string[] }
  | { invoke: string; files?: string[] };
export type RuleType = 'queue' | 'event' | 'timer' | 'callback' | 'request';
export interface RuleRecord {
  kind: 'rule';
  id: string;
  title: string;
  type: RuleType;
  send: Matcher[];
  receive?: Matcher[];
  context?: string;
  notes?: string;
}
export interface ConnectionRecord {
  kind: 'connection';
  id: string;
  rule: string;
  title: string;
  key?: string;
  send?: Anchor[];
  receive?: Anchor[];
  context?: string;
  notes?: string;
}
export interface Connections {
  rules: Located<RuleRecord>[];
  connections: Located<ConnectionRecord>[];
}
export const ConnectionsFileRecord: z.ZodType; // discriminated union on `kind`
export function matcherRegex(name: string): RegExp; // new RegExp(`^(?:${name})$`); throws on bad input
export function matchesAny(path: string, globs: string[] | undefined): boolean; // true when globs is undefined
export function parseConnections(
  text: string,
  file: string,
  diagnostics?: Diagnostic[],
): Connections;
export function validateConnections(c: Connections, file: string): Diagnostic[];
// Workspace gains: connections: Connections
export function loadWorkspace(
  config: SourceFile | undefined,
  flowFiles: SourceFile[],
  connections?: SourceFile,
): Workspace;
```

- [ ] **Step 1: Write the fixture sources.** These exact files; later tasks' tests name their functions.

`fixtures/cpp-sample/src/rt/rt.h`:

```c
#pragma once

typedef enum { JOB_NONE, JOB_READ_CNF, JOB_WRITE_CNF, JOB_TICK } job_type_t;

struct job;
typedef void (*job_cb_t)(struct job *job);
struct job {
  job_type_t type;
  job_cb_t callback;
};

struct mbox;
int mbox_post(struct mbox *box, void *msg);
int mbox_fetch(struct mbox *box, void **msg);

void job_post(struct job *job, job_type_t type, job_cb_t callback);
void timer_add(int delay_ms, void (*handler)(void *arg), void *arg);

#define EVT_SAVE 0x1
#define EVT_CLEAR 0x2
void event_set(unsigned flags);
unsigned event_wait(void);

struct app_cfg {
  void (*state_cb)(int state);
  void (*data_cb)(int len);
};
```

`fixtures/cpp-sample/src/rt/jobs.c`:

```c
#include "rt.h"

static struct mbox *main_box;
static struct job read_job, write_job;

/* Queue a job for the main task. */
void job_post(struct job *job, job_type_t type, job_cb_t callback) {
  job->type = type;
  job->callback = callback;
  mbox_post(main_box, job);
}

static void read_done(struct job *job) { job->type = JOB_NONE; }
static void write_done(struct job *job) { job->type = JOB_NONE; }

void request_read(void) { job_post(&read_job, JOB_READ_CNF, read_done); }
void request_write(void) { job_post(&write_job, JOB_WRITE_CNF, write_done); }

static void on_poll_timeout(void *arg) {
  (void)arg;
  event_set(EVT_SAVE);
}

void start_poll(void) { timer_add(100, on_poll_timeout, 0); }

void notify_state(struct app_cfg *cfg) { cfg->state_cb(1); }

/* Main task: runs every job, then handles pending events. */
void rt_main(void) {
  for (;;) {
    void *msg;
    mbox_fetch(main_box, &msg);
    struct job *job = msg;
    switch (job->type) {
    case JOB_READ_CNF:
    case JOB_WRITE_CNF:
      job->callback(job);
      break;
    case JOB_TICK:
      break;
    default:
      break;
    }
    unsigned flags = event_wait();
    if (flags & EVT_SAVE) {
      flags = 0;
    }
  }
}
```

`fixtures/cpp-sample/src/rt/app.c`:

```c
#include "rt.h"

static void app_state(int state) { (void)state; }
static void app_data(int len) { (void)len; }

struct app_cfg app = {.state_cb = app_state};

void app_init(void) { app.data_cb = app_data; }
```

`fixtures/cpp-sample/.flowbook/connections.jsonl`:

```jsonl
{"kind":"rule","id":"job","title":"Job queue","type":"queue","context":"rt main task","send":[{"call":"job_post","key":2,"handler":3}],"receive":[{"case":"JOB_.*"}]}
{"kind":"rule","id":"timer","title":"Timer","type":"timer","send":[{"call":"timer_add","handler":2}]}
{"kind":"rule","id":"event","title":"Event flag","type":"event","send":[{"call":"event_set","key":1}],"receive":[{"test":"EVT_.*"}]}
{"kind":"rule","id":"app-cb","title":"Application callback","type":"callback","send":[{"invoke":".*_cb"}],"receive":[{"assign":".*_cb","as":"handler"}]}
{"kind":"rule","id":"mbox","title":"Mailbox","type":"queue","send":[{"call":"mbox_post"}],"receive":[{"call":"mbox_fetch"}]}
{"kind":"connection","id":"read-cnf","rule":"job","key":"JOB_READ_CNF","title":"Read confirmation"}
{"kind":"connection","id":"main-box","rule":"mbox","title":"Main mailbox","send":[{"file":"src/rt/jobs.c","symbol":"job_post"}],"receive":[{"file":"src/rt/jobs.c","symbol":"rt_main"}]}
```

- [ ] **Step 2: Write the failing tests** in `packages/core/src/connections.test.ts`. Read the fixture file with `readFileSync` (tests run in Node). Helper `diag(text)` returns `parseConnections` diagnostics followed by `validateConnections` diagnostics, as messages.

```ts
it('parses the fixture: 5 rules, 2 connections, no diagnostics', ...);       // rules.length 5, connections.length 2, diag(...) toEqual []
it('keeps the line of each record', ...);                                    // rules[0].line 1, connections[1].line 7
it('rejects unknown fields and a matcher with two kinds', ...);              // {"call":"a","case":"b"} → an error on line 1
it('rejects a call matcher position below 1', ...);                          // "key":0 → error
it('reports an invalid regular expression once, on its line', ...);          // "call":"foo(" → exactly 1 error, line 1, message contains 'invalid regular expression'
it('reports a duplicate id', ...);                                           // two records with id "job" → error naming line 1
it('reports a connection naming an unknown rule', ...);                      // message contains 'unknown rule "nope"'
it('requires exactly one form', ...);                                        // key + send → error; neither → error; send without receive → error
it('requires receive matchers unless every send matcher names a handler', ...); // send [{"call":"f"}] and no receive → error
it('matcherRegex matches the whole name', ...);                              // matcherRegex('JOB_.*').test('JOB_X') true; matcherRegex('job').test('job_post') false
it('matchesAny is true without globs', ...);                                 // matchesAny('a/b.c', undefined) true; (…, ['src/**']) false
it('loadWorkspace without a connections file yields empty connections and no diagnostics', ...); // Review Focus 1
it('jsonSchemas has a connectionsLine definition', ...);
```

- [ ] **Step 3: Run them to verify they fail.** `pnpm --filter @flowbook/core build; pnpm exec vitest run packages/core/src/connections.test.ts`. Expected: FAIL, `connections.js` not found.

- [ ] **Step 4: Implement `packages/core/src/connections.ts`.** Matchers are a zod union of five `.strict()` objects. `validateConnections` reports, with the record's line and id: duplicate ids across rules and connections; an invalid regular expression in any matcher name (catch the `RegExp` constructor's error); an unknown rule; a connection that is not exactly one of keyed (`key` only) or anchored (`send` and `receive`, each non-empty, no `key`); a rule without `receive` whose `send` contains a matcher that is not a `call` with `handler`.

- [ ] **Step 5: Add `parseConnections` to `parse.ts`**, next to `parseConfig`, using the existing `parseLines`. Extend `loadWorkspace` and `Workspace`; push `validateConnections` diagnostics into `Workspace.diagnostics`. Add `connectionsLine` to `jsonSchemas`. Export the new module from `index.ts`.

- [ ] **Step 6: Document the records** in `skill/flowbook/references/schema.md`: a `## connections.jsonl` section with the `rule`, matcher and `connection` tables from the spec and the four example rules.

- [ ] **Step 7: Run the tests and the build.** `pnpm build && pnpm exec vitest run packages/core` → PASS. `git diff --stat schema/flowbook.schema.json` shows the regenerated schema. `pnpm flowbook check --strict --root fixtures/cpp-sample` still prints `2 flows, 17 nodes: 0 errors, 0 warnings (0 stale, 0 unstamped)`.

- [ ] **Step 8: Hand back for review and commit** (coordinator): `Add connection rule and record schema, fixture with four connection shapes`.

---

### Task 2: Site matching

**Files:**

- Create: `packages/resolver/src/sites.ts`
- Modify: `packages/resolver/src/resolver.ts`, `packages/resolver/src/index.ts`
- Test: `packages/resolver/src/sites.test.ts`

**Interfaces:**

- Consumes: `RuleRecord`, `Matcher`, `matcherRegex`, `matchesAny` from Task 1; `collectSymbols`, `SymbolInfo`.
- Produces:

```ts
export type MatcherKind = 'call' | 'case' | 'test' | 'assign' | 'invoke';
export interface Site {
  rule: string;
  role: 'send' | 'receive';
  matcher: MatcherKind;
  file: string;
  line: number;            // 0-based, of the matched name (callee, case value, identifier, field)
  column: number;
  symbol?: string;         // enclosing function definition; absent at file scope
  sig?: string;
  key?: string;
  handler?: string;        // identifier only
  unresolvedHandler?: true; // handler argument or right-hand side was not an identifier
}
export interface FileScan { symbols: SymbolInfo[]; sites: Site[] }
export function collectSites(tree: Tree, file: string, rules: RuleRecord[], symbols: SymbolInfo[]): Site[];
// on Resolver:
scan(path: string, text: string, rules: RuleRecord[]): FileScan; // parses once; rules [] gives sites []
```

- [ ] **Step 1: Write the failing tests** in `sites.test.ts`. Load the fixture's rules with `readWorkspace(fixture).connections.rules`. Helper `sites(file)` runs `resolver.scan` on a fixture file and maps each site to `` `${rule} ${role} ${matcher} ${symbol ?? '-'} ${key ?? '-'} ${handler ?? '-'}` ``.

```ts
it('finds every shape in jobs.c', () => {
  expect(sites('src/rt/jobs.c').sort()).toEqual([
    'app-cb send invoke notify_state state_cb -',
    'event receive test rt_main EVT_SAVE -',
    'event send call on_poll_timeout EVT_SAVE -',
    'job receive case rt_main JOB_READ_CNF -',
    'job receive case rt_main JOB_TICK -',
    'job receive case rt_main JOB_WRITE_CNF -',
    'job send call request_read JOB_READ_CNF read_done',
    'job send call request_write JOB_WRITE_CNF write_done',
    'mbox receive call rt_main - -',
    'mbox send call job_post - -',
    'timer send call start_poll - on_poll_timeout',
  ]);
});
it('finds a designated initializer at file scope and an assignment', () => {
  expect(sites('src/rt/app.c').sort()).toEqual([
    'app-cb receive assign - state_cb app_state',
    'app-cb receive assign app_init data_cb app_data',
  ]);
});
it('does not match declarations, definitions or #define lines', ...);   // sites('src/rt/rt.h') toEqual []
it('reports the line of the matched name', ...);                        // the JOB_TICK case site's line text contains 'case JOB_TICK'
it('takes a non-identifier key as text without whitespace', ...);       // inline: event_set(A | B) → key 'A|B'
it('marks a handler that is not an identifier', ...);                   // inline: timer_add(1, tbl[0], 0) → unresolvedHandler true, handler undefined
it('matches a function-like macro invocation by name', ...);            // inline: POST_JOB(j, JOB_X) with rule call POST_JOB key 2 → key 'JOB_X'
it('honours files globs', ...);                                         // matcher files ['src/other/**'] → no site in jobs.c
it('gives two sites for two posts with one key in one function', ...);
it('survives a file with syntax errors', ...);                          // Review Focus 3: 'void f(void) { job_post(&j, JOB_X, cb); @@@ ' → 1 site, no throw
it('works with the C++ grammar', ...);                                  // path 'x.cpp': cfg->state_cb(1) inside a class method → invoke site, symbol qualified
```

- [ ] **Step 2: Run to verify failure.** `pnpm exec vitest run packages/resolver/src/sites.test.ts` → FAIL, `scan` is not a function.

- [ ] **Step 3: Implement `collectSites` and `Resolver.scan`.** One walk of the tree; compile each matcher's regular expression once per `collectSites` call. Node types to match, to be confirmed against a parse dump of the fixture before relying on them: `call_expression` (fields `function`, `arguments`), `case_statement` (field `value`), `if_statement` / `while_statement` / `conditional_expression` (field `condition`; search identifiers beneath it), `assignment_expression` (field `left` a `field_expression`, field `right`), `initializer_pair` (a `field_designator`, field `value`), and for `invoke` a `call_expression` whose `function` is a `field_expression`. The enclosing symbol is the innermost `function` kind in `symbols` whose `startLine..endLine` contains the site.

- [ ] **Step 4: Run to verify pass.** Same command → PASS. `pnpm exec vitest run packages/resolver` → existing tests still PASS.

- [ ] **Step 5: Hand back for review and commit**: `Match connection sites with tree-sitter`.

---

### Task 3: Scanning a root

**Files:**

- Create: `packages/resolver/src/scan.ts`
- Modify: `packages/resolver/src/fs.ts`, `packages/resolver/src/index.ts`
- Test: `packages/resolver/src/scan.test.ts`

**Interfaces:**

- Consumes: `Resolver.scan`, `FileScan`, `Connections`, `CONNECTIONS_FILE`, `SOURCE_EXTENSIONS`.
- Produces:

```ts
export interface SourceText {
  path: string;
  text: string;
} // path is root-relative POSIX
export type ScanCache = Map<string, { mtimeMs: number; size: number; scan: FileScan | null }>;
/** Root-relative POSIX paths of source files; skips dot-directories, node_modules, build, dist, out. Sorted. */
export function listSourceFiles(root: string): string[];
/** Pure: scans the given sources. Files the prefilter rejects are absent from the map. */
export function scanSources(
  sources: Iterable<SourceText>,
  connections: Connections,
  resolver: Resolver,
): Map<string, FileScan>;
export function scanRoot(
  root: string,
  connections: Connections,
  resolver: Resolver,
  cache?: ScanCache,
): Map<string, FileScan>;
/** Same result as scanRoot; awaits `pause()` after every 20 files read. */
export function scanRootSliced(
  root: string,
  connections: Connections,
  resolver: Resolver,
  cache: ScanCache | undefined,
  pause: () => Promise<void>,
): Promise<Map<string, FileScan>>;
// readWorkspace(root) now also reads CONNECTIONS_FILE when it exists.
```

A file is in the result when its text contains a literal fragment of some rule name (pass 1), or contains a handler name found in pass 1, or is named by a connection anchor (pass 2, symbols needed, sites may be empty). A rule name with no literal run of three or more word characters makes every file pass. With no rules, the result is empty and no file is read.

- [ ] **Step 1: Write the failing tests** in `scan.test.ts`.

```ts
it('lists fixture sources, sorted, POSIX', ...);                 // includes 'src/rt/jobs.c' and 'src/net/server.cpp'
it('skips dot-directories, node_modules, build, dist and out', ...); // temp dir with one .c file in each plus src/a.c → ['src/a.c']
it('scans only files a rule can match', ...);                    // scanRoot(fixture): keys include src/rt/jobs.c and src/rt/app.c, exclude src/util/log.c
it('includes a file that only defines a handler', ...);          // scanSources: a.c calls timer_add(1, late, 0); b.c defines late → b.c present with a 'late' symbol and no sites
it('includes a file named by a connection anchor', ...);
it('reads nothing when there are no rules', ...);                // scanRoot with empty Connections → size 0
it('scanRootSliced returns what scanRoot returns and pauses', ...); // deep-equal maps; pause called at least once on a temp dir of 25 files
it('reuses the cache for unchanged files and rescans changed ones', ...); // second call with same cache: resolver.scan spy not called; after rewriting one file: called once
it('skips a file that cannot be read', ...);                     // Review Focus 4: cache lists a path that was deleted, and a directory named like x.c → no throw, absent from result
it('readWorkspace loads the fixture connections', ...);          // ws.connections.rules.length 5
```

- [ ] **Step 2: Run to verify failure.** `pnpm exec vitest run packages/resolver/src/scan.test.ts` → FAIL, module not found.

- [ ] **Step 3: Implement.** Write the two-pass loop once as a generator that yields after each file read; `scanRoot` drains it, `scanRootSliced` drains it and awaits `pause()` every 20 yields. The cache key is the path; an entry is reused when `mtimeMs` and `size` match. A cached `null` records a file the prefilter rejected in pass 1; pass 2 may still parse it.

- [ ] **Step 4: Run to verify pass.** `pnpm --filter @flowbook/resolver build && pnpm exec vitest run packages/resolver` → PASS.

- [ ] **Step 5: Hand back for review and commit**: `Scan a root for connection sites with prefilter and cache`.

---

### Task 4: Pairing and connection checks

**Files:**

- Create: `packages/resolver/src/pairing.ts`
- Modify: `packages/resolver/src/index.ts`
- Test: `packages/resolver/src/pairing.test.ts`

**Interfaces:**

- Consumes: `Site`, `FileScan`, `Connections`, `match` (existing anchor matching), `Diagnostic`.
- Produces:

```ts
export interface Target {
  file: string;
  line: number;
  column: number;
  symbol?: string;
}
export interface Reactor extends Target {
  /** key: a receive site with the same key. handler: named at the send site. registered: handler of a matching receive site. anchored: joined by an anchored connection. */
  via: 'key' | 'handler' | 'registered' | 'anchored';
  key?: string;
  confirmed: boolean;
}
export interface Pairing {
  send: Site;
  reactors: Reactor[]; // order: key, registered, anchored, handler
  connection?: string; // id of the covering connection
  title?: string; // its title
  context?: string; // connection context, else rule context
  /** Set when the send site's handler has several candidate definitions and no connection picked one. */
  candidates?: number;
}
export interface ConnectionIndex {
  sites: Site[];
  pairings: Pairing[]; // one per send site, in file then line order
  unpairedReceives: Site[];
  diagnostics: Diagnostic[]; // file CONNECTIONS_FILE, 1-based line of the record
}
export function buildConnectionIndex(
  connections: Connections,
  scans: Map<string, FileScan>,
): ConnectionIndex;
/** Send sites whose reactors include this file and line. */
export function sendersOf(index: ConnectionIndex, target: { file: string; line: number }): Site[];
export interface RuleSummary {
  rule: string;
  send: number;
  receive: number;
  paired: number;
  confirmed: number;
  unpaired: number;
  keyed: boolean;
}
export function ruleSummaries(index: ConnectionIndex, connections: Connections): RuleSummary[];
```

`paired` counts distinct keys with a send site and a reactor when the rule's send sites carry keys (`keyed: true`), otherwise send sites with a reactor. `confirmed` counts those whose reactors are all confirmed. `unpaired` is send sites without a reactor plus `unpairedReceives` of the rule.

- [ ] **Step 1: Write the failing tests** in `pairing.test.ts`. `index` is built from the fixture with `readWorkspace` and `scanRoot`. Helper `reactorsOf(fn)` finds the pairing whose `send.symbol` is `fn` and maps reactors to `` `${via} ${symbol ?? '-'} ${key ?? '-'} ${confirmed}` ``.

```ts
it('pairs a keyed post with its case and its handler', () => {
  expect(reactorsOf('request_read')).toEqual(['key rt_main JOB_READ_CNF true', 'handler read_done - true']);
  expect(reactorsOf('request_write')).toEqual(['key rt_main JOB_WRITE_CNF false', 'handler write_done - true']);
});
it('names the covering connection and context', ...);   // request_read pairing: connection 'read-cnf', title 'Read confirmation', context 'rt main task'
it('resolves a handler named at the post', ...);        // start_poll → ['handler on_poll_timeout - true']
it('pairs an event flag, unconfirmed', ...);            // on_poll_timeout → ['key rt_main EVT_SAVE false']
it('pairs a callback slot through its registration, unconfirmed', ...); // notify_state → ['key - state_cb false', 'registered app_state - false']
it('pairs a plain queue through an anchored connection', ...);          // job_post → ['anchored rt_main - true']
it('lists receives nobody sends to', ...);              // unpairedReceives keys: ['JOB_TICK', 'data_cb']
it('has no diagnostics on the fixture', ...);
it('sendersOf a case line returns its posters', ...);   // target = the JOB_READ_CNF case site → [request_read's site]
it('sendersOf a handler definition line returns its posters', ...); // read_done's name line → [request_read's site]
it('summarises each rule', () => {
  expect(ruleSummaries(index, ws.connections)).toEqual([
    { rule: 'job', send: 2, receive: 3, paired: 2, confirmed: 1, unpaired: 1, keyed: true },
    { rule: 'timer', send: 1, receive: 0, paired: 1, confirmed: 1, unpaired: 0, keyed: false },
    { rule: 'event', send: 1, receive: 1, paired: 1, confirmed: 0, unpaired: 0, keyed: true },
    { rule: 'app-cb', send: 1, receive: 2, paired: 1, confirmed: 0, unpaired: 1, keyed: true },
    { rule: 'mbox', send: 1, receive: 1, paired: 1, confirmed: 1, unpaired: 0, keyed: false },
  ]);
});
```

Inline-source tests, built with `scanSources`:

```ts
it('prefers a static handler in the same file', ...);            // a.c: static void h; b.c: void h → 1 reactor in a.c, confirmed
it('lists several handler candidates as unconfirmed', ...);      // a.c and b.c both define non-static h → 2 reactors confirmed false, candidates 2
it('lets an anchored connection pick one candidate', ...);       // receive anchor b.c#h → 1 reactor in b.c, via 'anchored', confirmed, no diagnostic
it('errors on a keyed connection whose key has no send site', ...);   // message contains 'no send site'
it('errors on a keyed connection whose key has no reactor', ...);     // message contains 'no reactor'
it('errors on an anchor that does not resolve', ...);                 // message contains 'no definition for'
it('errors on an anchored send function without a send site', ...);
it('errors on an anchored receive function that is neither a receive site nor a handler candidate', ...);
it('warns about a rule that matches no site', ...);                   // severity 'warning', message contains 'matches no site'
it('gives every diagnostic the record line', ...);
```

- [ ] **Step 2: Run to verify failure.** `pnpm exec vitest run packages/resolver/src/pairing.test.ts` → FAIL, module not found.

- [ ] **Step 3: Implement `buildConnectionIndex`** following the spec's Pairing section, steps 1 to 4, and its status rules. Handler lookup is by the last `::` segment of `symbol` among `function` kind symbols in all scans. `sendersOf` and `ruleSummaries` are pure reads of the index.

- [ ] **Step 4: Run to verify pass.** `pnpm --filter @flowbook/resolver build && pnpm exec vitest run packages/resolver` → PASS.

- [ ] **Step 5: Hand back for review and commit**: `Pair connection sites and check connection records`.

---

### Task 5: CLI and skill

**Files:**

- Modify: `packages/cli/src/commands.ts`, `packages/cli/src/main.ts`
- Modify: `skill/flowbook/SKILL.md`, `README.md`, `CLAUDE.md`
- Test: `packages/cli/src/cli.test.ts`

**Interfaces:**

- Consumes: `scanRoot`, `buildConnectionIndex`, `ruleSummaries`, `ConnectionIndex`.
- Produces:

```ts
export function sites(
  ctx: Context,
  opts?: { rule?: string; unpaired?: boolean; json?: boolean },
): number; // always 0, or 1 for an unknown --rule
// check(ctx, opts) unchanged in signature; now includes the index's diagnostics.
```

Text output, one line per site, then one line per rule:

```
src/rt/jobs.c:17: job send JOB_READ_CNF → rt_main (case JOB_READ_CNF), read_done
src/rt/jobs.c:33: job receive JOB_TICK → unpaired
job: 2 send, 3 receive, 2 keys paired (1 confirmed), 1 unpaired
timer: 1 send, 0 receive, 1 sends paired (1 confirmed), 0 unpaired
```

A send line lists its reactors' enclosing symbols, with `(case KEY)` or `(test KEY)` after a key reactor, ` ?` after an unconfirmed one, and `→ unpaired` when there are none. A receive line lists `← N senders` or `→ unpaired`. `--json` prints `{ "sites": [...], "rules": RuleSummary[] }` where each site has `file`, `line` (1-based), `rule`, `role`, `key`, `handler`, `symbol`, `reactors` or `senders`.

- [ ] **Step 1: Write the failing tests** in `cli.test.ts`, using the existing temp-copy harness.

```ts
describe('sites', () => {
  it('prints a summary line per rule', ...);          // out.slice(-5) toEqual the five lines: job/timer/event/app-cb/mbox as in Task 4's summaries
  it('shows reactors of a send site', ...);           // a line matching /jobs\.c:\d+: job send JOB_READ_CNF → rt_main \(case JOB_READ_CNF\), read_done$/
  it('marks unconfirmed reactors', ...);              // the JOB_WRITE_CNF line contains 'rt_main (case JOB_WRITE_CNF) ?'
  it('--unpaired lists only unpaired sites', ...);    // site lines: exactly the JOB_TICK case and the data_cb assignment
  it('--rule filters and rejects an unknown rule', ...); // sites(ctx,{rule:'nope'}) → 1, err contains 'unknown rule'
  it('--json is parseable and 1-based', ...);
  it('prints nothing but returns 0 without a connections file', ...); // Review Focus 1
});
describe('check with connections', () => {
  it('stays clean on the fixture', ...);              // existing summary line unchanged, exit 0
  it('is unchanged when connections.jsonl is deleted', ...); // Review Focus 1: same last line, exit 0
  it('fails when a confirmed key loses its case', ...); // edit jobs.c: remove 'case JOB_READ_CNF:' → exit 1, out contains 'connections.jsonl:6: error:' and 'no reactor'
  it('fails on an invalid regular expression', ...);  // Review Focus 2
  it('warns about a rule that matches nothing', ...); // append a rule calling 'nope_fn' with handler 1 → exit 0, a warning line
});
```

- [ ] **Step 2: Run to verify failure.** `pnpm build && pnpm exec vitest run packages/cli` → FAIL, `sites` is not exported.

- [ ] **Step 3: Implement `sites`, extend `check`, and wire `main.ts`:** add `sites [--rule <id>] [--unpaired] [--json]` to `HELP` and the `switch`, and the `rule` and `unpaired` options to `parseArgs`. `check` scans only when the workspace has rules.

- [ ] **Step 4: Write the skill section.** In `SKILL.md`, add `flowbook sites` to the command table and a `## Connections` section: what a rule and a connection are; the loop (find the mechanism's post and dispatch functions → write a rule → `flowbook sites --rule <id>` → adjust until the sites are right → add keyed connections for the keys you verified and anchored connections for plain queues → `flowbook check`); one worked example per shape taken from the fixture; the three known limits from the spec. Add a `sites` row to the README command table and a `connections.jsonl` line to its file-format block. In `CLAUDE.md`, add `connections.jsonl`, the three new resolver modules and the `sites` command to the layout and command sections.

- [ ] **Step 5: Run to verify pass.** `pnpm build && pnpm exec vitest run packages/cli` → PASS. `pnpm flowbook sites --root fixtures/cpp-sample` prints the five summary lines. `pnpm exec prettier --check .` → clean.

- [ ] **Step 6: Hand back for review and commit**: `Add flowbook sites; check validates connections; document in the skill`.

---

### Task 6: Editor lenses and jumps

**Files:**

- Create: `packages/extension/src/connections-model.ts`, `packages/extension/src/connections-lens.ts`
- Modify: `packages/extension/src/model.ts`, `packages/extension/src/host.ts`, `packages/extension/src/extension.ts`, `packages/extension/package.json`, `packages/extension/README.md`
- Test: `packages/extension/src/connections-model.test.ts`, `packages/extension/test/suite.cjs`

**Interfaces:**

- Consumes: `ConnectionIndex`, `Pairing`, `Target`, `FileScan`, `ScanCache`, `scanRootSliced`, `buildConnectionIndex`, `sendersOf`, `Resolver.scan`.
- Produces, in `connections-model.ts` (no `vscode` import):

```ts
export interface ConnLens {
  line: number; // 0-based
  title: string;
  command: 'flowbook.goToReactor' | 'flowbook.goToSender';
  targets: Target[];
  /** Present on an unpaired send site: text for the clipboard. */
  prompt?: string;
}
export function sendLensTitle(p: Pairing): string;
/** Lenses for one document, computed from its current text. */
export function documentLenses(
  connections: Connections,
  scans: Map<string, FileScan>,
  rel: string,
  docScan: FileScan,
): ConnLens[];
export function targetsAt(
  connections: Connections,
  scans: Map<string, FileScan>,
  rel: string,
  docScan: FileScan,
  line: number,
  direction: 'reactor' | 'sender',
): Target[];
export function agentPrompt(site: Site): string;
```

`documentLenses` rebuilds the index with `docScan` substituted for `rel` in a copy of `scans`, so lenses follow unsaved edits.

- `RootState` gains `scans: Map<string, FileScan>` and `connectionIndex: ConnectionIndex` (the parsed records stay at `ws.connections`). `loadRoot` gains an optional fourth parameter `scans` (default: empty map) and appends the index's diagnostics to `diagnostics`.
- `rootOfFlowbookFile` also accepts `.flowbook/connections.jsonl`.

Lens titles, exactly:

| Situation                                                     | Title                                                                              |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| key reactor and handler, covered by a connection              | `↳ Read confirmation: rt_main · case JOB_READ_CNF (rt main task) → then read_done` |
| the same, not covered                                         | `↳ rt_main · case JOB_WRITE_CNF (rt main task) → then write_done · unconfirmed`    |
| handler only                                                  | `↳ on_poll_timeout`                                                                |
| `test` reactor                                                | `↳ rt_main · test EVT_SAVE · unconfirmed`                                          |
| anchored                                                      | `↳ Main mailbox: rt_main`                                                          |
| more than one reactor that is not the key-then-handler pair   | `↳ 3 reactors: a, b, c` (plus ` · unconfirmed` when any is)                        |
| no reactor                                                    | `↳ no reactor found`                                                               |
| handler function name line, or a receive site with senders    | `↳ posted from 1 place` / `↳ posted from 6 places`                                 |
| receive sites on consecutive lines, at least one with senders | one lens on the first line: `↳ 2 keys · posted from 2 places`                      |

A reactor at file scope (no symbol) is shown as `file.c:line`. The callback-slot case shows the registered function: `↳ app_state · unconfirmed`.

- [ ] **Step 1: Write the failing unit tests** in `connections-model.test.ts`, against the fixture (`readWorkspace`, `scanRoot`). `lensesOf(file)` maps `documentLenses` to `` `${lineText.trim().slice(0, 24)} | ${title}` `` so assertions do not depend on line numbers.

```ts
it('titles a keyed post covered by a connection', ...);     // row 1 of the table, on the request_read line
it('marks an uncovered key as unconfirmed', ...);           // row 2, on the request_write line
it('titles a handler-only post', ...);                      // row 3, on the start_poll line
it('titles a test reactor', ...);                           // row 4
it('titles an anchored queue', ...);                        // row 5, on the mbox_post line
it('shows the registered function for a callback slot', ...); // '↳ app_state · unconfirmed' on the cfg->state_cb line
it('merges consecutive case labels into one lens', ...);    // exactly one lens on 'case JOB_READ_CNF:' titled '↳ 2 keys · posted from 2 places'; none on JOB_WRITE_CNF; none on JOB_TICK
it('puts a sender lens on a handler definition', ...);      // on the read_done line: '↳ posted from 1 place'
it('gives no lens to a receive site nobody sends to', ...); // app.c: no lens on the data_cb line
it('targetsAt a merged case line returns only that key\'s senders', ...); // on the JOB_WRITE_CNF line, direction 'sender' → 1 target, in request_write
it('targetsAt a send line returns its reactors in order', ...);
it('follows unsaved edits', ...);                           // Review Focus 5: docScan from jobs.c text with 3 blank lines prepended → every lens line is 3 greater
it('offers a prompt on an unpaired send', ...);             // inline: a post with a key nobody handles → title '↳ no reactor found', prompt contains the rule id, file and function
it('returns no lenses without rules', ...);                 // Review Focus 1
```

- [ ] **Step 2: Run to verify failure.** `pnpm exec vitest run packages/extension/src/connections-model.test.ts` → FAIL, module not found.

- [ ] **Step 3: Implement `connections-model.ts`** and the `model.ts` changes. Run the unit tests → PASS; `model.test.ts` still PASS.

- [ ] **Step 4: Scan in the host.** `Flowbook` keeps one `ScanCache` per root. `reload()` loads each root as today, then, for roots with rules, runs `scanRootSliced` with `pause = () => new Promise((r) => setImmediate(r))`, calls `loadRoot` again with the scans, updates problems and fires `onDidChange`. A reload that starts while a scan is running supersedes it: the older scan's result is discarded. Add `.flowbook/connections.jsonl` to both `FLOWBOOK_GLOB` constants and to `activationEvents`.

- [ ] **Step 5: Lens provider and commands** in `connections-lens.ts`. `ConnectionLenses` is registered for `C_CPP_SELECTOR`, honours `flowbook.connections.codeLens.enabled`, and builds lenses from `documentLenses` with `resolver.scan(rel, doc.getText(), rules)`. `flowbook.goToReactor` and `flowbook.goToSender` take optional `(uri, line)` arguments and fall back to the active editor's cursor line. No target: an information message, or for an unpaired send, a message with a `Copy agent prompt` button that writes `prompt` to the clipboard. One target: open it and reveal the line. Several: `editor.action.showReferences` with the locations. Contribute both commands (category `Flowbook`, titles `Go to Reactor` and `Go to Sender`) and the setting (boolean, default `true`, description `Show where a post, event or timer is handled, and who posts to a handler.`).

- [ ] **Step 6: Extend the end-to-end test** in `test/suite.cjs`, after the existing lens check:

```js
const jobs = await vscode.workspace.openTextDocument(vscode.Uri.file(`${root}/src/rt/jobs.c`));
await vscode.window.showTextDocument(jobs);
const connTitles = await waitFor(
  async () => {
    const l = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', jobs.uri, 50);
    const t = (l || []).map((x) => x.command && x.command.title).filter(Boolean);
    return t.some((x) => x.startsWith('↳ Read confirmation:')) ? t : undefined;
  },
  'connection lenses',
  20000,
);
assert.ok(connTitles.includes('↳ 2 keys · posted from 2 places'), connTitles.join(' | '));
const sendLine = jobs
  .getText()
  .split('\n')
  .findIndex((s) => s.includes('JOB_READ_CNF, read_done'));
await vscode.commands.executeCommand('flowbook.goToReactor', jobs.uri, sendLine);
const here = vscode.window.activeTextEditor;
assert.ok(here.document.lineAt(here.selection.active.line).text.includes('case JOB_READ_CNF'));
```

`goToReactor` on that line has two targets (the case and `read_done`); for this assertion to hold, when the first target is a key reactor and the only other is its handler, the command opens the key reactor directly. State that rule in a comment on the command.

- [ ] **Step 7: Verify.** `pnpm build && pnpm typecheck && pnpm exec vitest run packages/extension` → PASS. `pnpm --filter flowbook test:e2e` → PASS (needs a display; if none is available, say so in the hand-back and the coordinator runs it). `pnpm --filter flowbook package` succeeds. Add a "Connections" paragraph to `packages/extension/README.md`.

- [ ] **Step 8: Hand back for review and commit**: `Show connection lenses and jump between senders and reactors`.

---

### Task 7: Real-stack examples and measurements

**Files:**

- Create: `examples/i-link/fetch.sh`, `examples/i-link/.flowbook/connections.jsonl`, `examples/i-link/README.md`
- Create: `examples/p-net/fetch.sh`, `examples/p-net/.flowbook/connections.jsonl`, `examples/p-net/README.md`
- Modify: `docs/superpowers/specs/2026-11-15-connection-points-design.md` (Acceptance 5 only, if the measurement disagrees), `docs/agent-workflows/backlog.md`

**Interfaces:**

- Consumes: the built CLI (`pnpm flowbook sites`, `check`).
- Produces: two example roots that later designs (state machines) build on.

- [ ] **Step 1: Write the fetch scripts**, modelled on `examples/lua/fetch.sh`, each cloning into `src/` and checking out a pinned commit: `https://github.com/rtlabs-com/i-link.git` at `9f5fe0f7c6a45fa96a8d2439dcbe60bb2415793d`, `https://github.com/rtlabs-com/p-net.git` at `1c3b0b435b2ee2c6cea86849c14ee98f6ee579f1`. Make them executable and run them.

- [ ] **Step 2: Write the i-link rules** by following the skill's Connections loop yourself, using only `SKILL.md` and the CLI. At least: the job queue (`iolink_post_job_with_type_and_callback`, key 3, handler 4; receive `case IOLINK_JOB_.*`), the plain mailbox (`os_mbox_post` / `os_mbox_fetch`) with anchored connections, and the events (`os_event_set`). Note every place the skill text was unclear or wrong.

- [ ] **Step 3: Write the p-net rules**: the scheduler (`pf_scheduler_add`, handler 3), the application callbacks (`invoke` and `assign` on `.*_cb`, limited with `files` if they clash), and the background worker events (`os_event_set` key 2, receive `test BG_JOB_EVENT_.*`).

- [ ] **Step 4: Check the spec's acceptance numbers.** Run `pnpm flowbook sites --root examples/i-link` and `--root examples/p-net`. Expected: every job type sent through `iolink_post_job_with_type_and_callback` has at least one reactor; every handler passed to `pf_scheduler_add` under `src/src/device` and `src/src/common` resolves; every `fspm_cfg` callback field has an invoke site. `pnpm flowbook check --root examples/<name>` exits 0 for both. Where a number differs from the spec's grep counts (27 job types, 39 case labels, 17 handlers, 16 callback fields), find out why before accepting it.

- [ ] **Step 5: Measure the scan.** Time `pnpm flowbook sites --root examples/p-net > /dev/null` three times and report the median, and the same for a rescan inside one process if the CLI exposes one (otherwise note that the cache is only exercised by the extension, and measure there with the output channel's timestamps). Compare with the spec's targets (cold under 10 s, unchanged rescan under 1 s). If a target is missed, do not tune silently: report the numbers and the dominant cost.

- [ ] **Step 6: Write each README** like `examples/lua/README.md`: what the example shows, the layout, how to fetch, the rule summary lines as printed, every unpaired site explained in one line, and the licence note (the stack is GPLv3 or commercial; its sources are not part of this repository). Record the measured times in `examples/p-net/README.md`.

- [ ] **Step 7: Feed back.** Apply the skill fixes noted in Step 2 to `skill/flowbook/SKILL.md`. Update the spec's Acceptance 5 with the measured numbers if they differ. In `docs/agent-workflows/backlog.md`, add this design to **Done** and extend item C2 (examples in CI) to cover both new examples.

- [ ] **Step 8: Verify.** `pnpm exec prettier --check .` and `pnpm lint` are clean with the fetched sources present (`examples/*/src/` is gitignored; confirm prettier and eslint skip it, and add ignore entries if they do not). `git status --short` lists no file under `examples/*/src/`.

- [ ] **Step 9: Hand back for review and commit**: `Add i-link and p-net connection examples with measured results`.
