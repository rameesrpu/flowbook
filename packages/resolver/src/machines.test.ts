import type { MachineRecord } from '@flowbook/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { Resolver } from './resolver.js';

let resolver: Resolver;
beforeAll(async () => {
  resolver = await Resolver.create();
});

const machine = (over: Partial<MachineRecord> = {}): MachineRecord => ({
  kind: 'machine',
  id: 'm',
  title: 'M',
  states: 'ST_.*',
  events: 'EV_.*',
  set: [{ call: 'set_state', key: 2 }],
  ...over,
});

const scan = (text: string, machines: MachineRecord[] = [machine()], path = 'src/sm.c') =>
  resolver.scan(path, text, [], machines);

const NESTED = `void sm(ar_t *ar, int event)
{
  switch (ar->state) {
  case ST_IDLE:
    switch (event) {
    case EV_START:
      log_it ();
      set_state (ar, ST_RUN);
      break;
    default:
      break;
    }
    break;
  case ST_RUN:
    on_run (ar);
    break;
  }
}
`;

describe('collectTransitions', () => {
  it('gives the state case, the event case and the event case block as region', () => {
    const { transitions, sites } = scan(NESTED);
    expect(sites).toEqual([]);
    expect(transitions).toEqual([
      {
        machine: 'm',
        file: 'src/sm.c',
        line: 7,
        column: 6,
        symbol: 'sm',
        sig: '(ar_t*,int)',
        to: 'ST_RUN',
        fromCases: ['ST_IDLE'],
        fromTests: [],
        event: 'EV_START',
        kind: 'set',
        region: { startLine: 5, endLine: 8 },
      },
    ]);
  });

  it('lists state labels and the calls in a state case block', () => {
    const { stateLabels, stateCalls } = scan(NESTED);
    expect(stateLabels).toEqual([
      { machine: 'm', state: 'ST_IDLE' },
      { machine: 'm', state: 'ST_RUN' },
    ]);
    expect(stateCalls).toEqual([
      { machine: 'm', state: 'ST_IDLE', callee: 'log_it' },
      { machine: 'm', state: 'ST_IDLE', callee: 'set_state' },
      { machine: 'm', state: 'ST_RUN', callee: 'on_run' },
    ]);
  });

  it('gives every label of a fall-through group and the shared block as region', () => {
    const text = `void sm(int s)
{
  switch (s) {
  case ST_A:
  case ST_B:
    set_state (0, ST_C);
    break;
  }
}
`;
    const [t] = scan(text).transitions;
    expect(t!.fromCases).toEqual(['ST_A', 'ST_B']);
    expect(t!.event).toBeUndefined();
    expect(t!.region).toEqual({ startLine: 3, endLine: 6 });
  });

  it('does not take a case on events as the source state', () => {
    const text = `void on_event(int event)
{
  switch (event) {
  case EV_STOP:
  case OTHER_LABEL:
    set_state (0, ST_IDLE);
    break;
  }
}
`;
    const [t] = scan(text).transitions;
    expect(t!.fromCases).toEqual([]);
    expect(t!.event).toBe('EV_STOP');
    expect(scan(text).stateLabels).toEqual([]);
  });

  it('uses the function body as region outside any case', () => {
    const text = `void init(void)
{
  prepare ();
  set_state (0, ST_IDLE);
}
`;
    const [t] = scan(text).transitions;
    expect(t!.fromCases).toEqual([]);
    expect(t!.region).toEqual({ startLine: 1, endLine: 4 });
    expect(t!.symbol).toBe('init');
  });

  it('reads the assign form with keyMember and drops targets not matching states', () => {
    const m = machine({
      set: [{ assign: 'state', as: 'key', keyMember: true }],
    });
    const text = `void step(dl_t *dl)
{
  dl->mh.state = cfg->ST_PREOP;
  dl->mh.state = 0;
  dl->mh.state = OTHER;
}
`;
    const ts = scan(text, [m]).transitions;
    expect(ts.map((t) => [t.to, t.line, t.column])).toEqual([['ST_PREOP', 2, 9]]);
  });

  it('keeps the condition of one enclosing if as guard', () => {
    const text = `void startup(dl_t *dl)
{
  if (dl->mh.cmd  ==
      MHCMD_PREOP) {
    set_state (dl, ST_PREOP);
  } else if (dl->mh.cmd == MHCMD_OP) {
    set_state (dl, ST_OP);
  } else {
    set_state (dl, ST_FAULT);
  }
  if (a) { if (b) set_state (dl, ST_X); }
  if (${'x'.repeat(100)}) set_state (dl, ST_LONG);
  set_state (dl, ST_PLAIN);
}
`;
    const guards = Object.fromEntries(scan(text).transitions.map((t) => [t.to, t.guard]));
    expect(guards).toEqual({
      ST_PREOP: 'dl->mh.cmd==MHCMD_PREOP',
      ST_OP: 'dl->mh.cmd==MHCMD_OP',
      ST_FAULT: '!(dl->mh.cmd==MHCMD_OP)',
      ST_X: undefined,
      ST_LONG: 'x'.repeat(79) + '…',
      ST_PLAIN: undefined,
    });
    // Guards are only looked for inside the region (the case block).
    const inCase = `void f(int s)
{
  if (ready) {
    switch (s) {
    case ST_A:
      set_state (0, ST_B);
      break;
    }
  }
}
`;
    expect(scan(inCase).transitions[0]!.guard).toBeUndefined();
  });

  it('ignores machines, set sites and labels outside the machine files', () => {
    const limited = machine({ files: ['src/sm.c'] });
    expect(scan(NESTED, [limited], 'src/other.c')).toMatchObject({
      transitions: [],
      stateCalls: [],
      stateLabels: [],
    });
    expect(scan(NESTED, [limited], 'src/sm.c').transitions).toHaveLength(1);
  });

  it('reads table rows, positional and designated, with labels; short rows are skipped', () => {
    const m = machine({
      set: undefined,
      tables: [{ rows: 'trans_s[0-9]+', event: 1, to: 2, action: 3, from: {} }],
    });
    const text = `static const trans_t trans_s0[] = {
  {EV_MANUAL, ST_STARTUP, cm_startup}, /* T1 */
  {EV_AUTO, ST_OTHER, &cm_other},
  {EV_SHORT},
  {EV_BAD, NOT_A_STATE, cm_bad},
};
static const trans_t other[] = { {EV_X, ST_X, f} };
`;
    expect(scan(text, [m]).transitions).toEqual([
      {
        machine: 'm',
        file: 'src/sm.c',
        line: 1,
        column: 2,
        to: 'ST_STARTUP',
        fromCases: [],
        fromTests: [],
        event: 'EV_MANUAL',
        label: 'T1',
        kind: 'row',
        action: 'cm_startup',
        table: 'trans_s0',
        region: { startLine: 1, endLine: 1 },
      },
      {
        machine: 'm',
        file: 'src/sm.c',
        line: 2,
        column: 2,
        to: 'ST_OTHER',
        fromCases: [],
        fromTests: [],
        event: 'EV_AUTO',
        kind: 'row',
        action: 'cm_other',
        table: 'trans_s0',
        region: { startLine: 2, endLine: 2 },
      },
    ]);

    const named = machine({
      set: undefined,
      tables: [{ rows: 'rows', event: 'ev', to: 'next', action: 'fn', from: {} }],
    });
    const designated = `const row_t rows[] = {
  /* T5 */ { .ev = EV_GO, .next = ST_GO, .fn = go },
  { .ev = EV_NONE },
};
`;
    const rows = scan(designated, [named]).transitions;
    expect(rows.map((t) => [t.event, t.to, t.action, t.label])).toEqual([
      ['EV_GO', 'ST_GO', 'go', 'T5'],
    ]);
  });

  it('gives empty arrays without machines', () => {
    expect(resolver.scan('src/sm.c', NESTED, [])).toMatchObject({
      transitions: [],
      stateCalls: [],
      stateLabels: [],
    });
  });

  it('gives one transition per event label of a fall-through group', () => {
    const text = `void sm(int s, int event)
{
  switch (s) {
  case ST_RUN:
    switch (event) {
    case EV_DATA:
    case OTHER:
    case EV_ABORT:
      set_state (0, ST_IDLE);
      break;
    }
    break;
  }
}
`;
    expect(scan(text).transitions.map((t) => [t.fromCases, t.event, t.to])).toEqual([
      [['ST_RUN'], 'EV_DATA', 'ST_IDLE'],
      [['ST_RUN'], 'EV_ABORT', 'ST_IDLE'],
    ]);
  });

  it('takes source states from the innermost if comparing state names with ==', () => {
    const text = `void f(ar_t *ar, int s)
{
  if (ar->state == ST_W_ARDY) set_state (ar, ST_A);
  if (ST_X == s || s == (int)ST_Y) set_state (ar, ST_B);
  if (s == ST_X && t) { if (ready) set_state (ar, ST_C); }
  if (s != ST_X) set_state (ar, ST_D);
  if (s == ST_X && t != ST_Y) set_state (ar, ST_E);
  if (is (ST_X)) set_state (ar, ST_F);
  if (s == ST_X) { } else set_state (ar, ST_G);
  if (s == ST_X) { if (s != ST_Y) set_state (ar, ST_H); }
  if (s == ST_X) set_state (ar, ST_I);
}
`;
    expect(Object.fromEntries(scan(text).transitions.map((t) => [t.to, t.fromTests]))).toEqual({
      ST_A: ['ST_W_ARDY'],
      ST_B: ['ST_X', 'ST_Y'],
      ST_C: ['ST_X'],
      ST_D: [],
      ST_E: [],
      ST_F: [],
      ST_G: [],
      ST_H: [],
      ST_I: ['ST_X'],
    });
  });

  it('omits the guard of the if that gives the source states, keeps one inside it', () => {
    const text = `void f(int s)
{
  if (s == ST_X) set_state (0, ST_A);
  if (s == ST_X) { if (ready) set_state (0, ST_B); }
  switch (s) { case ST_Y: if (s == ST_X) set_state (0, ST_C); break; }
}
`;
    const ts = scan(text).transitions;
    expect(ts.map((t) => [t.to, t.fromTests, t.guard])).toEqual([
      ['ST_A', ['ST_X'], undefined],
      ['ST_B', ['ST_X'], 'ready'],
      ['ST_C', ['ST_X'], 's==ST_X'],
    ]);
  });

  it('drops comments from the guard text', () => {
    const text = `void f(dl_t *dl)
{
  if (dl->a == 1 // first
      && /* second */ dl->b)
    set_state (dl, ST_A);
}
`;
    expect(scan(text).transitions[0]!.guard).toBe('dl->a==1&&dl->b');
  });

  it('collects calls anywhere in a state case block, nested event cases included', () => {
    const text = `void sm(ar_t *ar, int ev)
{
  switch (ar->state) {
  case ST_A:
    if (ar->x) { helper (ar); }
    for (;;) loop_fn (ar);
    switch (ev) {
    case EV_GO:
      on_go (ar, inner (ar));
      break;
    }
    break;
  }
}
`;
    expect(scan(text).stateCalls.map((c) => `${c.state} ${c.callee}`)).toEqual([
      'ST_A helper',
      'ST_A loop_fn',
      'ST_A on_go',
      'ST_A inner',
    ]);
  });

  it('gives no test source when a state comparison sits under || with a non-state operand', () => {
    const text = `void f(ar_t *p, int s)
{
  if (p->state == ST_A || p->force) set_state (p, ST_B);
  if ((s == ST_A || s == ST_B) && ready) set_state (p, ST_C);
  if (s == ST_A || (s == ST_B && t)) set_state (p, ST_D);
  if ((s == ST_A) || (s == ST_B)) set_state (p, ST_E);
  if (s == ST_A && (x || y)) set_state (p, ST_F);
}
`;
    expect(Object.fromEntries(scan(text).transitions.map((t) => [t.to, t.fromTests]))).toEqual({
      ST_B: [],
      ST_C: ['ST_A', 'ST_B'],
      ST_D: [],
      ST_E: ['ST_A', 'ST_B'],
      ST_F: ['ST_A'],
    });
  });

  it('uses the consequence of the test if as region for the guard and the triggers', () => {
    const text = `void f(ar_t *p)
{
  prepare ();
  if (p->state == ST_A) {
    if (p->cmd == 1)
      set_state (p, ST_C);
  }
}
`;
    const [t] = scan(text).transitions;
    expect(t!.fromTests).toEqual(['ST_A']);
    expect(t!.guard).toBe('p->cmd==1');
    expect(t!.region).toEqual({ startLine: 3, endLine: 6 });
  });

  it('gives one transition per branch of a ?: key when both name states', () => {
    const text = `void f(ar_t *p, int c)
{
  set_state (p, c ? ST_A : (ST_B));
  set_state (p, c ? ST_A : other);
  set_state (p, c ? ST_A : 0);
}
`;
    expect(scan(text).transitions.map((t) => [t.line, t.to])).toEqual([
      [2, 'ST_A'],
      [2, 'ST_B'],
    ]);
    const m = machine({ set: [{ assign: 'state', as: 'key', keyMember: true }] });
    const assign = `void g(dl_t *dl, int c)
{
  dl->state = c ? cfg->ST_X : ST_Y;
}
`;
    expect(scan(assign, [m]).transitions.map((t) => t.to)).toEqual(['ST_X', 'ST_Y']);
  });

  it('writes sig only when defined', () => {
    const text = `int x = (set_state (0, ST_A), 0);
`;
    const [t] = scan(text, [machine()], 'src/sm.cpp').transitions;
    expect(t).toBeDefined();
    expect('sig' in t!).toBe(false);
  });
});
