import { fileURLToPath } from 'node:url';
import {
  CONNECTIONS_FILE,
  type ConnectionRecord,
  type Connections,
  type RuleRecord,
  type Workspace,
} from '@flowbook/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { readWorkspace } from './fs.js';
import {
  buildConnectionIndex,
  ruleSummaries,
  sendersOf,
  type ConnectionIndex,
  type Pairing,
} from './pairing.js';
import { Resolver } from './resolver.js';
import { scanRoot, scanSources } from './scan.js';

const fixture = fileURLToPath(new URL('../../../fixtures/cpp-sample/', import.meta.url));

let resolver: Resolver;
let ws: Workspace;
let index: ConnectionIndex;
beforeAll(async () => {
  resolver = await Resolver.create();
  ws = readWorkspace(fixture);
  index = buildConnectionIndex(ws.connections, scanRoot(fixture, ws.connections, resolver));
});

const describeReactors = (p: Pairing | undefined) =>
  p?.reactors.map((r) => `${r.via} ${r.symbol ?? '-'} ${r.key ?? '-'} ${r.confirmed}`);
const pairingOf = (idx: ConnectionIndex, fn: string) =>
  idx.pairings.find((p) => p.send.symbol === fn);
const reactorsOf = (fn: string) => describeReactors(pairingOf(index, fn));

describe('buildConnectionIndex on the fixture', () => {
  it('pairs a keyed post with its case and its handler', () => {
    expect(reactorsOf('request_read')).toEqual([
      'key rt_main JOB_READ_CNF true',
      'handler read_done - true',
    ]);
    expect(reactorsOf('request_write')).toEqual([
      'key rt_main JOB_WRITE_CNF false',
      'handler write_done - true',
    ]);
  });

  it('names the covering connection and context', () => {
    const p = pairingOf(index, 'request_read')!;
    expect(p.connection).toBe('read-cnf');
    expect(p.title).toBe('Read confirmation');
    expect(p.context).toBe('rt main task');
    const w = pairingOf(index, 'request_write')!;
    expect(w.connection).toBeUndefined();
    expect(w.context).toBe('rt main task');
  });

  it('resolves a handler named at the post', () => {
    expect(reactorsOf('start_poll')).toEqual(['handler on_poll_timeout - true']);
    const r = pairingOf(index, 'start_poll')!.reactors[0]!;
    // Name position of `static void on_poll_timeout(void *arg)` in jobs.c (0-based).
    expect(r).toMatchObject({ file: 'src/rt/jobs.c', line: 18, column: 12 });
  });

  it('pairs an event flag, unconfirmed', () => {
    expect(reactorsOf('on_poll_timeout')).toEqual(['key rt_main EVT_SAVE false']);
  });

  it('pairs a callback slot through its registration, unconfirmed', () => {
    expect(reactorsOf('notify_state')).toEqual([
      'key - state_cb false',
      'registered app_state - false',
    ]);
  });

  it('pairs a plain queue through an anchored connection', () => {
    expect(reactorsOf('job_post')).toEqual(['anchored rt_main - true']);
    expect(pairingOf(index, 'job_post')!.connection).toBe('main-box');
  });

  it('lists receives nobody sends to', () => {
    expect(index.unpairedReceives.map((s) => s.key)).toEqual(['JOB_TICK', 'data_cb']);
  });

  it('has no diagnostics on the fixture', () => {
    expect(index.diagnostics).toEqual([]);
  });

  it('orders pairings by file then line', () => {
    const order = index.pairings.map((p) => `${p.send.file}:${p.send.line}`);
    const sorted = [...index.pairings]
      .sort((a, b) =>
        a.send.file === b.send.file
          ? a.send.line - b.send.line
          : a.send.file < b.send.file
            ? -1
            : 1,
      )
      .map((p) => `${p.send.file}:${p.send.line}`);
    expect(order).toEqual(sorted);
    expect(index.pairings).toHaveLength(6);
  });

  it('sendersOf a case line returns its posters', () => {
    const site = index.sites.find((s) => s.role === 'receive' && s.key === 'JOB_READ_CNF')!;
    expect(sendersOf(index, site)).toEqual([pairingOf(index, 'request_read')!.send]);
  });

  it('sendersOf a handler definition line returns its posters', () => {
    // `static void read_done(...)` is on line 13 (1-based) of jobs.c.
    expect(sendersOf(index, { file: 'src/rt/jobs.c', line: 12 })).toEqual([
      pairingOf(index, 'request_read')!.send,
    ]);
  });

  it('summarises each rule', () => {
    expect(ruleSummaries(index, ws.connections)).toEqual([
      { rule: 'job', send: 2, receive: 3, paired: 2, confirmed: 1, unpaired: 1, keyed: true },
      { rule: 'timer', send: 1, receive: 0, paired: 1, confirmed: 1, unpaired: 0, keyed: false },
      { rule: 'event', send: 1, receive: 1, paired: 1, confirmed: 0, unpaired: 0, keyed: true },
      { rule: 'app-cb', send: 1, receive: 2, paired: 1, confirmed: 0, unpaired: 1, keyed: true },
      { rule: 'mbox', send: 1, receive: 1, paired: 1, confirmed: 1, unpaired: 0, keyed: false },
    ]);
  });
});

type Rec = RuleRecord | ConnectionRecord;
const connectionsOf = (records: Rec[]): Connections => {
  const out: Connections = { rules: [], connections: [] };
  records.forEach((r, i) => {
    if (r.kind === 'rule') out.rules.push({ ...r, line: i + 1 });
    else out.connections.push({ ...r, line: i + 1 });
  });
  return out;
};
const build = (records: Rec[], files: Record<string, string>) => {
  const c = connectionsOf(records);
  const sources = Object.entries(files).map(([path, text]) => ({ path, text }));
  return buildConnectionIndex(c, scanSources(sources, c, resolver));
};

const timerRule: RuleRecord = {
  kind: 'rule',
  id: 'tm',
  title: 'Timer',
  type: 'timer',
  send: [{ call: 'arm', handler: 1 }],
};
const jobRule: RuleRecord = {
  kind: 'rule',
  id: 'jb',
  title: 'Job',
  type: 'queue',
  send: [{ call: 'post', key: 1 }],
  receive: [{ case: 'J_.*' }],
};
const boxRule: RuleRecord = {
  kind: 'rule',
  id: 'bx',
  title: 'Box',
  type: 'queue',
  send: [{ call: 'put' }],
  receive: [{ call: 'get' }],
};
const caller = 'void arm(void (*f)(void));\nvoid go(void) { arm(h); }\n';
const boxSource =
  'void put(int);\nint get(void);\nvoid s(void) { put(1); }\nvoid r(void) { get(); }\nvoid other(void) {}\n';
const anchoredBox = (send: string, receive: string): ConnectionRecord => ({
  kind: 'connection',
  id: 'ab',
  rule: 'bx',
  title: 'AB',
  send: [{ file: 'a.c', symbol: send }],
  receive: [{ file: 'a.c', symbol: receive }],
});

describe('buildConnectionIndex on inline sources', () => {
  it('prefers a static handler in the same file', () => {
    const idx = build([timerRule], {
      'a.c': `static void h(void) {}\n${caller}`,
      'b.c': 'void h(void) {}\n',
    });
    const p = pairingOf(idx, 'go')!;
    expect(p.reactors).toHaveLength(1);
    expect(p.reactors[0]).toMatchObject({ file: 'a.c', symbol: 'h', confirmed: true });
    expect(p.candidates).toBeUndefined();
  });

  it('lists several handler candidates as unconfirmed', () => {
    const idx = build([timerRule], {
      'a.c': `void h(void) {}\n${caller}`,
      'b.c': 'void h(void) {}\n',
    });
    const p = pairingOf(idx, 'go')!;
    expect(p.reactors.map((r) => `${r.via} ${r.file} ${r.confirmed}`)).toEqual([
      'handler a.c false',
      'handler b.c false',
    ]);
    expect(p.candidates).toBe(2);
  });

  it('lets an anchored connection pick one candidate', () => {
    const idx = build(
      [
        timerRule,
        {
          kind: 'connection',
          id: 'pick',
          rule: 'tm',
          title: 'Pick b',
          send: [{ file: 'a.c', symbol: 'go' }],
          receive: [{ file: 'b.c', symbol: 'h' }],
        },
      ],
      { 'a.c': `void h(void) {}\n${caller}`, 'b.c': 'void h(void) {}\n' },
    );
    const p = pairingOf(idx, 'go')!;
    expect(p.reactors).toEqual([
      { via: 'anchored', file: 'b.c', line: 0, column: 5, symbol: 'h', confirmed: true },
    ]);
    expect(p.candidates).toBeUndefined();
    expect(p.connection).toBe('pick');
    expect(idx.diagnostics).toEqual([]);
  });

  it('errors on a keyed connection whose key has no send site', () => {
    const idx = build(
      [jobRule, { kind: 'connection', id: 'k', rule: 'jb', title: 'K', key: 'J_GONE' }],
      {
        'a.c':
          'void post(int);\nvoid s(void) { post(J_A); }\nvoid r(int t) { switch (t) { case J_A: break; } }\n',
      },
    );
    expect(idx.diagnostics).toHaveLength(1);
    expect(idx.diagnostics[0]!.message).toContain('no send site');
    expect(idx.diagnostics[0]).toMatchObject({ severity: 'error', id: 'k' });
  });

  it('errors on a keyed connection whose key has no reactor', () => {
    const rule: RuleRecord = {
      kind: 'rule',
      id: 'hj',
      title: 'Handler job',
      type: 'queue',
      send: [{ call: 'post', key: 1, handler: 2 }],
    };
    const idx = build([rule, { kind: 'connection', id: 'k', rule: 'hj', title: 'K', key: 'J_B' }], {
      'a.c': 'void post(int, int);\nvoid s(void) { post(J_B, 0); }\n',
    });
    expect(idx.diagnostics).toHaveLength(1);
    expect(idx.diagnostics[0]!.message).toContain('no reactor');
  });

  it('errors on a keyed connection whose key has no receive site, and does not confirm it', () => {
    const rule: RuleRecord = { ...jobRule, send: [{ call: 'post', key: 1, handler: 2 }] };
    const idx = build([rule, { kind: 'connection', id: 'k', rule: 'jb', title: 'K', key: 'J_B' }], {
      'a.c':
        'void post(int, void (*)(void));\nvoid h(void) {}\nvoid s(void) { post(J_B, h); }\nvoid r(int t) { switch (t) { case J_A: break; } }\n',
    });
    expect(idx.diagnostics).toHaveLength(1);
    expect(idx.diagnostics[0]!.message).toBe(
      'connection "k": key "J_B" has no receive site for rule "jb"',
    );
    expect(describeReactors(pairingOf(idx, 's'))).toEqual(['handler h - true']);
  });

  it('pairs an anchored connection without diagnostics when both functions hold sites', () => {
    const idx = build([boxRule, anchoredBox('s', 'r')], { 'a.c': boxSource });
    expect(describeReactors(pairingOf(idx, 's'))).toEqual(['anchored r - true']);
    expect(idx.unpairedReceives).toEqual([]);
    expect(idx.diagnostics).toEqual([]);
  });

  it('errors on an anchor that does not resolve', () => {
    const idx = build([boxRule, anchoredBox('s', 'nope')], { 'a.c': boxSource });
    expect(idx.diagnostics).toHaveLength(1);
    expect(idx.diagnostics[0]!.message).toContain('no definition for');
    expect(idx.diagnostics[0]!.message).toContain('a.c#nope');
  });

  it('errors on an anchored send function without a send site', () => {
    const idx = build([boxRule, anchoredBox('other', 'r')], { 'a.c': boxSource });
    expect(idx.diagnostics.map((d) => d.message)).toEqual([
      'a.c#other has no send site of rule "bx"',
    ]);
  });

  it('errors on an anchored receive function that is neither a receive site nor a handler candidate', () => {
    const idx = build([boxRule, anchoredBox('s', 'other')], { 'a.c': boxSource });
    expect(idx.diagnostics).toHaveLength(1);
    expect(idx.diagnostics[0]!.message).toContain('a.c#other');
    expect(idx.diagnostics[0]!.message).toContain('no receive site');
    expect(describeReactors(pairingOf(idx, 's'))).toEqual([]);
  });

  it('warns about a rule that matches no site', () => {
    const idx = build([boxRule, { ...timerRule, send: [{ call: 'never_called', handler: 1 }] }], {
      'a.c': boxSource,
    });
    expect(idx.diagnostics).toEqual([
      {
        severity: 'warning',
        file: CONNECTIONS_FILE,
        line: 2,
        id: 'tm',
        message: 'rule "tm" matches no site',
      },
    ]);
  });

  it('gives every diagnostic the record line', () => {
    const idx = build(
      [
        boxRule,
        jobRule,
        { kind: 'connection', id: 'k', rule: 'jb', title: 'K', key: 'J_GONE' },
        anchoredBox('other', 'nope'),
      ],
      { 'a.c': boxSource },
    );
    expect(idx.diagnostics.map((d) => [d.id, d.line, d.file])).toEqual([
      ['jb', 2, CONNECTIONS_FILE],
      ['k', 3, CONNECTIONS_FILE],
      ['ab', 4, CONNECTIONS_FILE],
      ['ab', 4, CONNECTIONS_FILE],
    ]);
  });
});

const slotRule: RuleRecord = {
  kind: 'rule',
  id: 'cb',
  title: 'Callback',
  type: 'callback',
  send: [{ invoke: '.*_cb' }],
  receive: [{ assign: '.*_cb', as: 'handler' }],
};
const slotSource =
  'struct s { void (*on_cb)(void); };\nvoid h(void) {}\nstruct s x = {.on_cb = h};\nvoid fire(struct s *p) { p->on_cb(); }\n';
const summaryOf = (idx: ConnectionIndex, records: Rec[], rule: string) =>
  ruleSummaries(idx, connectionsOf(records)).find((s) => s.rule === rule);

describe('reactor status and merging', () => {
  it('lists a registered handler with two definitions as two unconfirmed reactors', () => {
    const idx = build([slotRule], { 'a.c': slotSource, 'b.c': 'void h(void) {}\n' });
    expect(
      pairingOf(idx, 'fire')!.reactors.map((r) => `${r.via} ${r.file} ${r.confirmed}`),
    ).toEqual(['key a.c false', 'registered a.c false', 'registered b.c false']);
  });

  it('confirms a callback slot covered by a keyed connection', () => {
    const records: Rec[] = [
      slotRule,
      { kind: 'connection', id: 'slot', rule: 'cb', title: 'Slot', key: 'on_cb' },
    ];
    const idx = build(records, { 'a.c': slotSource });
    expect(describeReactors(pairingOf(idx, 'fire'))).toEqual([
      'key - on_cb true',
      'registered h - true',
    ]);
    expect(pairingOf(idx, 'fire')!.connection).toBe('slot');
    expect(idx.diagnostics).toEqual([]);
  });

  it('merges a receive site reached by key and by an anchored connection', () => {
    const records: Rec[] = [
      jobRule,
      {
        kind: 'connection',
        id: 'jr',
        rule: 'jb',
        title: 'JR',
        send: [{ file: 'a.c', symbol: 's' }],
        receive: [{ file: 'a.c', symbol: 'r' }],
      },
    ];
    const idx = build(records, {
      'a.c':
        'void post(int);\nvoid s(void) { post(J_A); }\nvoid r(int t) { switch (t) { case J_A: break; } }\n',
    });
    expect(describeReactors(pairingOf(idx, 's'))).toEqual(['anchored r J_A true']);
    expect(summaryOf(idx, records, 'jb')).toMatchObject({ paired: 1, confirmed: 1, unpaired: 0 });
  });

  it('merges a registered handler that is also the send site handler', () => {
    const rule: RuleRecord = {
      kind: 'rule',
      id: 'rg',
      title: 'Register',
      type: 'callback',
      send: [{ call: 'post', key: 1, handler: 2 }],
      receive: [{ assign: '.*_cb', as: 'handler' }],
    };
    const idx = build([rule], {
      'a.c': `${slotSource}void post(int k, void (*f)(void));\nvoid go(void) { post(on_cb, h); }\n`,
    });
    expect(describeReactors(pairingOf(idx, 'go'))).toEqual([
      'key - on_cb false',
      'handler h - true',
    ]);
  });

  it('takes connection and title from the first covering anchored connection by line', () => {
    const second: ConnectionRecord = { ...anchoredBox('s', 'r'), id: 'ab2', title: 'Second' };
    const idx = build([boxRule, anchoredBox('s', 'r'), second], { 'a.c': boxSource });
    const p = pairingOf(idx, 's')!;
    expect(p).toMatchObject({ connection: 'ab', title: 'AB' });
    expect(describeReactors(p)).toEqual(['anchored r - true']);
  });
});
