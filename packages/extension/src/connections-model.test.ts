import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConnections, type Connections } from '@flowbook/core';
import {
  buildConnectionIndex,
  readWorkspace,
  Resolver,
  scanRoot,
  scanSources,
  type FileScan,
  type Target,
} from '@flowbook/resolver';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  directTarget,
  documentIndex,
  documentLenses,
  targetsAt,
  type ConnLens,
} from './connections-model.js';

const fixture = resolve(fileURLToPath(import.meta.url), '../../../../fixtures/cpp-sample');
const read = (rel: string) => readFileSync(join(fixture, rel), 'utf8');

let resolver: Resolver;
let connections: Connections;
let scans: Map<string, FileScan>;

beforeAll(async () => {
  resolver = await Resolver.create();
  connections = readWorkspace(fixture).connections;
  scans = scanRoot(fixture, connections, resolver);
});

const docScanOf = (rel: string, text = read(rel)) => resolver.scan(rel, text, connections.rules);

/** Lenses of a document from its current text (the dirty-document path). */
function dirtyLenses(rel: string, text = read(rel)): ConnLens[] {
  const docScan = docScanOf(rel, text);
  return documentLenses(documentIndex(connections, scans, rel, docScan), rel, docScan.symbols);
}

function lensesOf(rel: string, text = read(rel)): string[] {
  const lines = text.split('\n');
  return dirtyLenses(rel, text).map((l) => `${lines[l.line]!.trim().slice(0, 24)} | ${l.title}`);
}

/** Lenses of `rel` in a root made of `files`, under the given connections.jsonl text. */
function inlineLenses(jsonl: string, files: Record<string, string>, rel: string): ConnLens[] {
  const conns = parseConnections(jsonl, 'c.jsonl');
  const own = scanSources(
    Object.entries(files).map(([path, text]) => ({ path, text })),
    conns,
    resolver,
  );
  return documentLenses(buildConnectionIndex(conns, own), rel, own.get(rel)?.symbols ?? []);
}

const rule = (r: object) => JSON.stringify({ kind: 'rule', title: 'R', type: 'event', ...r });

const lineOf = (rel: string, needle: string) =>
  read(rel)
    .split('\n')
    .findIndex((s) => s.includes(needle));

const JOBS = 'src/rt/jobs.c';
const APP = 'src/rt/app.c';

describe('documentLenses', () => {
  it('titles a keyed post covered by a connection', () => {
    expect(lensesOf(JOBS)).toContain(
      'void request_read(void)  | ↳ Read confirmation: rt_main · case JOB_READ_CNF (rt main task) → then read_done',
    );
  });

  it('marks an uncovered key as unconfirmed', () => {
    expect(lensesOf(JOBS)).toContain(
      'void request_write(void) | ↳ rt_main · case JOB_WRITE_CNF (rt main task) → then write_done · unconfirmed',
    );
  });

  it('says which case is missing when the dispatcher has none for the key', () => {
    const text = read(JOBS).replace('case JOB_WRITE_CNF:', '');
    const lens = lensesOf(JOBS, text).find((l) => l.startsWith('void request_write(void)'))!;
    expect(lens).toMatch(/ · no case for JOB_WRITE_CNF$/);
    expect(lens).not.toContain('unconfirmed');
  });

  it('says a receive site is missing for a rule whose receive matchers are not cases', () => {
    const jsonl = rule({
      id: 'ev',
      send: [{ call: 'post', key: 1, handler: 2 }],
      receive: [{ test: 'E_.*' }],
    });
    const src =
      'void post(int k, void (*f)(void));\nvoid x_cb(void) {}\nvoid s(void) { post(E_X, x_cb); }\nvoid r(int f) { if (f & E_Y) {} }\n';
    const [lens] = inlineLenses(jsonl, { 'a.c': src }, 'a.c').filter((l) => l.line === 2);
    expect(lens!.title).toBe('↳ x_cb · no receive site for E_X');
  });

  it('titles a forwarding send without reactors and offers no agent prompt', () => {
    const jsonl = rule({ id: 'ev', send: [{ call: 'post', key: 1 }], receive: [{ test: 'E_.*' }] });
    const src = 'void post(int k);\nvoid wrap(int a, int type) { post(type); }\n';
    const lenses = inlineLenses(jsonl, { 'a.c': src }, 'a.c').filter((l) => l.line === 1);
    expect(lenses).toHaveLength(1);
    expect(lenses[0]!.title).toBe('↳ forwards parameter `type` to callers of wrap');
    expect(lenses[0]!.prompt).toBeUndefined();
  });

  it('titles a handler-only post', () => {
    expect(lensesOf(JOBS)).toContain('void start_poll(void) {  | ↳ on_poll_timeout');
  });

  it('titles a test reactor', () => {
    expect(lensesOf(JOBS)).toContain(
      'event_set(EVT_SAVE); | ↳ rt_main · test EVT_SAVE · unconfirmed',
    );
  });

  it('titles an anchored queue', () => {
    expect(lensesOf(JOBS)).toContain('mbox_post(main_box, job) | ↳ Main mailbox: rt_main');
  });

  it('shows the registered function for a callback slot', () => {
    expect(lensesOf(JOBS)).toContain('void notify_state(struct | ↳ app_state · unconfirmed');
  });

  it('jumps straight to the registered function of a callback slot', () => {
    const lens = dirtyLenses(JOBS).find((l) => l.line === lineOf(JOBS, 'cfg->state_cb'))!;
    expect(lens.targets.map((t) => [t.file, t.symbol])).toEqual([[APP, 'app_state']]);
    expect(directTarget(lens.targets)).toBe(lens.targets[0]);
  });

  it('keeps a plain case reactor next to a registered handler of the same key', () => {
    const jsonl = rule({
      id: 'ev',
      send: [{ call: 'post', key: 1 }],
      receive: [{ case: 'on_.*' }, { assign: 'on_.*', as: 'handler' }],
    });
    const x = [
      'void sender(void) { post(on_ev); }',
      'void loop(int t) { switch (t) { case on_ev: break; } }',
      'static void my_handler(void) {}',
      'struct cfg c = {.on_ev = my_handler};',
    ].join('\n');
    const lens = inlineLenses(jsonl, { 'x.c': x }, 'x.c').find((l) => l.line === 0)!;
    expect(lens.title).toBe('↳ 2 reactors: loop, my_handler · unconfirmed');
    expect(lens.targets.map((t) => t.symbol)).toEqual(['loop', 'my_handler']);
  });

  it('lists several reactors', () => {
    const jsonl = rule({ id: 'k', send: [{ call: 'post', key: 1 }], receive: [{ case: 'K_.*' }] });
    const x = [
      'void go(void) { post(K_A); }',
      ...['a', 'b', 'c'].map((f) => `void ${f}(int t) { switch (t) { case K_A: break; } }`),
    ].join('\n');
    const lens = inlineLenses(jsonl, { 'x.c': x }, 'x.c').find((l) => l.line === 0)!;
    expect(lens.title).toBe('↳ 3 reactors: a, b, c · unconfirmed');
    expect(lens.targets).toHaveLength(3);
  });

  it('marks a handler with two candidate definitions unconfirmed and tells them apart', () => {
    const jsonl = rule({ id: 't', type: 'timer', send: [{ call: 'later', handler: 1 }] });
    const files = {
      'src/a.c': 'void cb(void) {}\n',
      'src/b.c': 'void cb(void) {}\n',
      'src/s.c': 'void go(void) { later(cb); }\n',
    };
    const [lens] = inlineLenses(jsonl, files, 'src/s.c');
    expect(lens!.title).toBe('↳ 2 reactors: cb (a.c), cb (b.c) · unconfirmed');
    expect(directTarget(lens!.targets)).toBeUndefined();
  });

  it('gives two send sites on one line a single lens', () => {
    const jsonl = [
      rule({ id: 'a', send: [{ call: 'a_post', key: 1 }], receive: [{ case: 'X_.*' }] }),
      rule({ id: 'b', send: [{ call: 'b_post', key: 1 }], receive: [{ case: 'Y_.*' }] }),
    ].join('\n');
    const x = [
      'void both(void) { a_post(X_1); b_post(Y_1); }',
      'void la(int t) { switch (t) { case X_1: break; } }',
      'void lb(int t) { switch (t) { case Y_1: break; } }',
    ].join('\n');
    const onLine = inlineLenses(jsonl, { 'x.c': x }, 'x.c').filter((l) => l.line === 0);
    expect(onLine.map((l) => l.title)).toEqual(['↳ 2 reactors: la, lb · unconfirmed']);
    expect(onLine[0]!.targets.map((t) => t.symbol)).toEqual(['la', 'lb']);
  });

  it('merges consecutive case labels into one lens', () => {
    const all = lensesOf(JOBS);
    expect(all.filter((l) => l.startsWith('case JOB_READ_CNF:'))).toEqual([
      'case JOB_READ_CNF: | ↳ 2 keys · posted from 2 places',
    ]);
    expect(all.filter((l) => l.startsWith('case JOB_WRITE_CNF:'))).toEqual([]);
    expect(all.filter((l) => l.startsWith('case JOB_TICK:'))).toEqual([]);
  });

  it('puts a sender lens on a handler definition', () => {
    expect(lensesOf(JOBS)).toContain('static void read_done(st | ↳ posted from 1 place');
  });

  it('gives no lens to a receive site nobody sends to', () => {
    const all = lensesOf(APP);
    expect(all).toContain('struct app_cfg app = {.s | ↳ posted from 1 place');
    expect(all.filter((l) => l.includes('data_cb'))).toEqual([]);
  });

  it('follows unsaved edits', () => {
    const text = read(JOBS);
    const before = dirtyLenses(JOBS);
    const after = dirtyLenses(JOBS, `\n\n\n${text}`);
    expect(before.length).toBeGreaterThan(0);
    expect(after.map((l) => [l.line, l.title])).toEqual(before.map((l) => [l.line + 3, l.title]));
    // Targets in the edited file move with it.
    const local = (ls: ConnLens[]) =>
      ls.flatMap((l) => l.targets.filter((t) => t.file === JOBS).map((t) => t.line));
    expect(local(after)).toEqual(local(before).map((n) => n + 3));
  });

  it('offers a prompt on an unpaired send', () => {
    const rel = 'src/extra.c';
    const text = 'void lonely(void) { job_post(&j, JOB_NOBODY, nobody_cb); }\n';
    const lenses = inlineLenses(read('.flowbook/connections.jsonl'), { [rel]: text }, rel);
    expect(lenses).toHaveLength(1);
    const [lens] = lenses as [ConnLens];
    expect(lens.title).toBe('↳ no reactor found');
    expect(lens.command).toBe('flowbook.goToReactor');
    expect(lens.targets).toEqual([]);
    expect(lens.prompt).toContain('"job"');
    expect(lens.prompt).toContain(rel);
    expect(lens.prompt).toContain('lonely');
  });

  it('returns no lenses without rules', () => {
    const none: Connections = { rules: [], connections: [] };
    const scan = resolver.scan(JOBS, read(JOBS), []);
    const index = documentIndex(none, new Map(), JOBS, scan);
    expect(documentLenses(index, JOBS, scan.symbols)).toEqual([]);
  });

  it('gives a clean document the same lenses from the saved index', () => {
    const saved = buildConnectionIndex(connections, scans);
    expect(documentLenses(saved, JOBS, scans.get(JOBS)!.symbols)).toEqual(dirtyLenses(JOBS));
  });
});

describe('targetsAt', () => {
  const at = (line: number, direction: 'reactor' | 'sender') =>
    targetsAt(documentIndex(connections, scans, JOBS, docScanOf(JOBS)), JOBS, line, direction);

  it("targetsAt a merged case line returns only that key's senders", () => {
    const t = at(lineOf(JOBS, 'case JOB_WRITE_CNF'), 'sender');
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({
      file: JOBS,
      line: lineOf(JOBS, 'JOB_WRITE_CNF, write_done'),
      symbol: 'request_write',
    });
  });

  it('targetsAt a send line returns its reactors in order', () => {
    const t = at(lineOf(JOBS, 'JOB_READ_CNF, read_done'), 'reactor');
    expect(t.map((x) => [x.file, x.line, x.symbol])).toEqual([
      [JOBS, lineOf(JOBS, 'case JOB_READ_CNF'), 'rt_main'],
      [JOBS, lineOf(JOBS, 'static void read_done'), 'read_done'],
    ]);
  });
});

describe('directTarget', () => {
  it('opens a key reactor followed only by its handler', () => {
    const index = buildConnectionIndex(connections, scans);
    const t = targetsAt(index, JOBS, lineOf(JOBS, 'JOB_READ_CNF, read_done'), 'reactor');
    expect(directTarget(t)).toBe(t[0]);
  });

  it('opens a single target and peeks several', () => {
    const a: Target = { file: 'a.c', line: 1, column: 0 };
    const b: Target = { file: 'b.c', line: 2, column: 0 };
    expect(directTarget([a])).toBe(a);
    expect(directTarget([a, b])).toBeUndefined();
    expect(directTarget([])).toBeUndefined();
  });
});
