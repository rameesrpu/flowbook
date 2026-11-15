import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConnections, type Connections } from '@flowbook/core';
import {
  readWorkspace,
  Resolver,
  scanRoot,
  scanSources,
  type FileScan,
  type Target,
} from '@flowbook/resolver';
import { beforeAll, describe, expect, it } from 'vitest';
import { directTarget, documentLenses, targetsAt, type ConnLens } from './connections-model.js';

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

function lensesOf(rel: string, text = read(rel)): string[] {
  const lines = text.split('\n');
  return documentLenses(connections, scans, rel, docScanOf(rel, text)).map(
    (l) => `${lines[l.line]!.trim().slice(0, 24)} | ${l.title}`,
  );
}

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
    const before = documentLenses(connections, scans, JOBS, docScanOf(JOBS));
    const after = documentLenses(connections, scans, JOBS, docScanOf(JOBS, `\n\n\n${text}`));
    expect(before.length).toBeGreaterThan(0);
    expect(after.map((l) => [l.line, l.title])).toEqual(before.map((l) => [l.line + 3, l.title]));
    // Targets in the edited file move with it.
    const local = (ls: ConnLens[]) =>
      ls.flatMap((l) => l.targets.filter((t) => t.file === JOBS).map((t) => t.line));
    expect(local(after)).toEqual(local(before).map((n) => n + 3));
  });

  it('offers a prompt on an unpaired send', () => {
    const rules = parseConnections(read('.flowbook/connections.jsonl'), 'c.jsonl');
    const rel = 'src/extra.c';
    const text = 'void lonely(void) { job_post(&j, JOB_NOBODY, nobody_cb); }\n';
    const own = scanSources([{ path: rel, text }], rules, resolver);
    const lenses = documentLenses(rules, own, rel, resolver.scan(rel, text, rules.rules));
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
    expect(documentLenses(none, new Map(), JOBS, scan)).toEqual([]);
  });
});

describe('targetsAt', () => {
  const at = (line: number, direction: 'reactor' | 'sender') =>
    targetsAt(connections, scans, JOBS, docScanOf(JOBS), line, direction);

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
    const t = targetsAt(
      connections,
      scans,
      JOBS,
      docScanOf(JOBS),
      lineOf(JOBS, 'JOB_READ_CNF, read_done'),
      'reactor',
    );
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
