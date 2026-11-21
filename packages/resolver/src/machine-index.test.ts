import {
  MACHINES_FILE,
  type Connections,
  type Located,
  type MachineRecord,
  type RuleRecord,
  type ScopeRecord,
} from '@flowbook/core';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildMachineIndex,
  machineSummaries,
  statePrefix,
  type Transition,
} from './machine-index.js';
import { buildConnectionIndex } from './pairing.js';
import { Resolver } from './resolver.js';
import type { FileScan } from './sites.js';

let resolver: Resolver;
beforeAll(async () => {
  resolver = await Resolver.create();
});

const RULE: Located<RuleRecord> = {
  kind: 'rule',
  id: 'timer',
  title: 'Timer',
  type: 'timer',
  send: [{ call: 'timer_add', handler: 2 }],
  line: 1,
};

const machine = (over: Partial<MachineRecord> = {}, line = 1): Located<MachineRecord> => ({
  kind: 'machine',
  id: 'm',
  title: 'M',
  states: 'ST_.*',
  events: 'EV_.*',
  set: [{ call: 'set_state', key: 2 }],
  ...over,
  line,
});

const scope = (over: Partial<ScopeRecord> = {}, line = 2): Located<ScopeRecord> => ({
  kind: 'scope',
  id: 's',
  machine: 'm',
  state: 'ST_IDLE',
  in: [{ file: 'src/sm.c', symbol: 'sm_init' }],
  ...over,
  line,
});

function build(
  files: Record<string, string>,
  machines: Located<MachineRecord>[] = [machine()],
  scopes: Located<ScopeRecord>[] = [],
) {
  const connections: Connections = { rules: [RULE], connections: [], machines, scopes };
  const scans = new Map<string, FileScan>();
  for (const [path, text] of Object.entries(files))
    scans.set(path, resolver.scan(path, text, connections.rules, machines));
  const index = buildConnectionIndex(connections, scans);
  return buildMachineIndex(connections, scans, index);
}

const line = (t: Transition) =>
  `${t.site.line} ${t.from} -> ${t.to} ${t.via}${t.event ? ` on ${t.event}` : ''}${t.guard ? ` if ${t.guard}` : ''} [${t.triggers.map((p) => p.send.handler).join(',')}]`;
const lines = (mi: ReturnType<typeof build>, id = 'm') =>
  mi.machines.find((m) => m.id === id)!.transitions.map(line);
const messages = (mi: ReturnType<typeof build>) =>
  mi.diagnostics.map((d) => `${d.severity} ${d.line} ${d.id}: ${d.message}`);

const CASES = `void sm(ar_t *ar, int event)
{
  timer_add (ar, outside);
  switch (ar->state) {
  case ST_IDLE:
    switch (event) {
    case EV_START:
      timer_add (ar, on_start);
      if (ar->ok)
        set_state (ar, ST_RUN);
      break;
    default:
      break;
    }
    break;
  case ST_A:
  case ST_B:
    set_state (ar, ST_IDLE);
    break;
  }
}
`;

describe('buildMachineIndex: source states', () => {
  it('takes the state case, one transition per fall-through label, with event, guard and triggers', () => {
    const mi = build({ 'src/sm.c': CASES });
    expect(lines(mi)).toEqual([
      '9 ST_IDLE -> ST_RUN case on EV_START if ar->ok [on_start]',
      '17 ST_A -> ST_IDLE case []',
      '17 ST_B -> ST_IDLE case []',
    ]);
    const t = mi.machines[0]!.transitions[0]!;
    expect(t.site).toEqual({ file: 'src/sm.c', line: 9, column: 8, symbol: 'sm' });
    expect(t.triggers[0]!.send.symbol).toBe('sm');
    expect(mi.diagnostics).toEqual([]);
  });

  it('uses a scope record covering the enclosing function', () => {
    const text = `void sm_init(ar_t *ar)
{
  timer_add (ar, tick);
  set_state (ar, ST_RUN);
}
void other(ar_t *ar)
{
  set_state (ar, ST_IDLE);
}
`;
    const mi = build({ 'src/sm.c': text }, [machine()], [scope()]);
    expect(lines(mi)).toEqual(['3 ST_IDLE -> ST_RUN scope [tick]', '7 * -> ST_IDLE none []']);
    expect(mi.diagnostics).toEqual([]);
  });

  it('prefers the case over a scope', () => {
    const mi = build(
      { 'src/sm.c': CASES },
      [machine()],
      [scope({ in: [{ file: 'src/sm.c', symbol: 'sm' }] })],
    );
    expect(lines(mi).map((l) => l.split(' ').slice(1, 5).join(' '))).toEqual([
      'ST_IDLE -> ST_RUN case',
      'ST_A -> ST_IDLE case',
      'ST_B -> ST_IDLE case',
    ]);
  });

  it('takes the states an enclosing if tests, after the case and before a scope', () => {
    const text = `void sm_init(ar_t *ar)
{
  if (ar->state == ST_WAIT) set_state (ar, ST_RUN);
  set_state (ar, ST_IDLE);
}
`;
    const mi = build({ 'src/sm.c': text }, [machine()], [scope()]);
    expect(lines(mi)).toEqual(['2 ST_WAIT -> ST_RUN test []', '3 ST_IDLE -> ST_IDLE scope []']);
    expect(machineSummaries(mi)[0]!.via.test).toBe(1);
  });

  it('prefers a scope over a caller', () => {
    const text = `void sm_init(ar_t *ar)
{
  set_state (ar, ST_RUN);
}
void sm(ar_t *ar)
{
  switch (ar->state) {
  case ST_WAIT:
    sm_init (ar);
    break;
  }
}
`;
    expect(lines(build({ 'src/sm.c': text }, [machine()], [scope()]))).toEqual([
      '2 ST_IDLE -> ST_RUN scope []',
    ]);
  });

  it('takes the one state case that calls the enclosing function', () => {
    const text = `static void go_run(ar_t *ar)
{
  set_state (ar, ST_RUN);
}
void sm(ar_t *ar)
{
  switch (ar->state) {
  case ST_IDLE:
    go_run (ar);
    break;
  case ST_WAIT:
    go_run (ar);
    break;
  case ST_STOP:
    go_run (ar);
    break;
  case ST_RUN:
    go_run (ar);
    break;
  }
}
`;
    const once = text.replace(/case ST_(WAIT|STOP|RUN):\n {4}go_run \(ar\);/g, 'case ST_$1:');
    expect(lines(build({ 'src/sm.c': once }))).toEqual(['2 ST_IDLE -> ST_RUN caller []']);
  });

  it('gives "*" when the enclosing function is called from two different state cases', () => {
    const text = `static void go_run(ar_t *ar)
{
  set_state (ar, ST_RUN);
}
void sm(ar_t *ar)
{
  switch (ar->state) {
  case ST_IDLE:
    go_run (ar);
    break;
  case ST_WAIT:
    go_run (ar);
    break;
  }
}
`;
    const mi = build({ 'src/sm.c': text });
    expect(lines(mi)).toEqual(['2 * -> ST_RUN none []']);
    expect(machineSummaries(mi)[0]!.unknown).toBe(1);
    expect(mi.diagnostics).toEqual([]);
  });

  it('counts the same state twice as one caller state, and ignores calls from another file', () => {
    const helper = `void go_run(ar_t *ar)
{
  set_state (ar, ST_RUN);
}
`;
    const caller = `void sm(ar_t *ar)
{
  switch (ar->state) {
  case ST_IDLE:
    go_run (ar);
    go_run (ar);
    break;
  }
}
`;
    expect(lines(build({ 'src/sm.c': helper + caller }))).toEqual([
      '2 ST_IDLE -> ST_RUN caller []',
    ]);
    expect(lines(build({ 'src/a.c': helper, 'src/b.c': caller }))).toEqual([
      '2 * -> ST_RUN none []',
    ]);
  });
});

const TABLE = `static const trans_t cm_trans_s0[] = {
  {EV_GO, ST_RUN, cm_go}, /* T1 */
  {EV_STOP, ST_STOP, NULL},
};
static const trans_t cm_trans_s1[] = {
  {EV_GO, ST_IDLE, cm_back},
};
static void cm_back(void)
{
}
`;
const ACTIONS = `void cm_go(void)
{
  timer_add (0, on_go);
}
void cm_back(void)
{
  timer_add (0, wrong_back);
}
`;
const tableMachine = (from: Record<string, string>) =>
  machine({
    set: undefined,
    tables: [{ rows: 'cm_trans_s[0-9]+', event: 1, to: 2, action: 3, from }],
  });

describe('buildMachineIndex: table rows', () => {
  it('takes the source from the "from" map, resolves the action and its triggers', () => {
    const mi = build({ 'src/cm.c': TABLE, 'src/actions.c': ACTIONS }, [
      tableMachine({ cm_trans_s0: 'ST_IDLE' }),
    ]);
    expect(lines(mi)).toEqual([
      '1 ST_IDLE -> ST_RUN table on EV_GO [on_go]',
      '2 ST_IDLE -> ST_STOP table on EV_STOP []',
      '5 * -> ST_IDLE none on EV_GO []',
    ]);
    const [go, stop, back] = mi.machines[0]!.transitions;
    expect(go!.label).toBe('T1');
    expect(go!.action).toEqual({ file: 'src/actions.c', line: 0, column: 5, symbol: 'cm_go' });
    expect(stop!.action).toBeUndefined();
    // The definition in the row's own file wins.
    expect(back!.action).toEqual({ file: 'src/cm.c', line: 7, column: 12, symbol: 'cm_back' });
    expect(mi.diagnostics).toEqual([]);
  });

  it('reports a "from" key that matches no table, and a "from" state never seen', () => {
    const mi = build({ 'src/cm.c': TABLE }, [
      tableMachine({ cm_trans_s0: 'ST_IDLE', cm_trans_s9: 'ST_TYPO' }),
    ]);
    expect(messages(mi)).toEqual([
      'error 1 m: "from" key "cm_trans_s9" matches no table of machine "m"',
      'warning 1 m: "from" state "ST_TYPO" (for cm_trans_s9) is never a target or a case label',
    ]);
    expect(mi.diagnostics[0]!.file).toBe(MACHINES_FILE);
  });
});

describe('buildMachineIndex: checks', () => {
  it('reports unresolved scope anchors, scope functions without a set site, unseen scope states', () => {
    const text = `void sm_init(void)
{
}
`;
    const mi = build(
      { 'src/sm.c': text + CASES },
      [machine()],
      [
        scope(
          {
            id: 's1',
            in: [
              { file: 'src/sm.c', symbol: 'sm_init' },
              { file: 'src/sm.c', symbol: 'gone' },
              { file: 'src/none.c', symbol: 'x' },
            ],
          },
          2,
        ),
        scope({ id: 's2', state: 'ST_TYPO', in: [{ file: 'src/sm.c', symbol: 'sm' }] }, 3),
      ],
    );
    expect(messages(mi)).toEqual([
      'error 2 s1: no definition for src/sm.c#gone',
      'error 2 s1: no definition for src/none.c#x',
      'error 2 s1: src/sm.c#sm_init has no set site of machine "m"',
      'warning 3 s2: scope state "ST_TYPO" is never a target or a case label',
    ]);
  });

  it('reports an overloaded scope anchor', () => {
    const text = `void f(int a) { set_state (0, ST_A); }
void f(char *s) { set_state (0, ST_A); }
`;
    const mi = build(
      { 'src/sm.cpp': text },
      [machine()],
      [scope({ state: 'ST_A', in: [{ file: 'src/sm.cpp', symbol: 'f' }] })],
    );
    expect(messages(mi)).toEqual([
      'error 2 s: src/sm.cpp#f is overloaded; add "sig" with one of: (int) | (char*)',
    ]);
  });

  it('warns about a machine with no transition; unknown sources are no diagnostic', () => {
    const mi = build({ 'src/sm.c': 'void f(void) { set_state (0, ST_A); }\n' }, [
      machine(),
      machine({ id: 'empty', states: 'NO_.*' }, 2),
    ]);
    expect(messages(mi)).toEqual(['warning 2 empty: machine "empty" has no transition']);
    expect(lines(mi)).toEqual(['0 * -> ST_A none []']);
  });
});

describe('buildMachineIndex: view', () => {
  it('lists labels and sources and targets as states, sorted, and the prefix; sorts by file', () => {
    const b = `void f(void) { set_state (0, ST_ZED); }\n`;
    const mi = build({ 'src/b.c': b, 'src/a.c': CASES }, [machine({ context: 'main task' })]);
    const view = mi.machines[0]!;
    expect(view).toMatchObject({ id: 'm', title: 'M', context: 'main task', prefix: 'ST_' });
    expect(view.states).toEqual(['ST_A', 'ST_B', 'ST_IDLE', 'ST_RUN', 'ST_ZED']);
    expect(view.transitions.map((t) => t.site.file)).toEqual([
      'src/a.c',
      'src/a.c',
      'src/a.c',
      'src/b.c',
    ]);
  });

  it('summarizes per machine', () => {
    const mi = build({ 'src/sm.c': CASES });
    expect(machineSummaries(mi)).toEqual([
      {
        machine: 'm',
        states: 4,
        transitions: 3,
        unknown: 0,
        setsOff: 1,
        via: { case: 3, test: 0, scope: 0, caller: 0, table: 0, none: 0 },
      },
    ]);
  });
});

describe('statePrefix', () => {
  it('is the longest common prefix ending at a "_" boundary', () => {
    expect(statePrefix(['PF_CMSM_STATE_IDLE', 'PF_CMSM_STATE_RUN'])).toBe('PF_CMSM_STATE_');
    expect(statePrefix(['ST_RUN', 'ST_RUNNING'])).toBe('ST_');
    expect(statePrefix(['A_X', 'B_X'])).toBe('');
    expect(statePrefix(['IDLE', 'RUN'])).toBe('');
    expect(statePrefix([])).toBe('');
  });

  it('is the name up to its last "_" for one state, never the whole name', () => {
    expect(statePrefix(['PF_STATE_IDLE'])).toBe('PF_STATE_');
    expect(statePrefix(['ST_A_', 'ST_A_B'])).toBe('ST_');
    expect(statePrefix(['IDLE'])).toBe('');
  });
});
