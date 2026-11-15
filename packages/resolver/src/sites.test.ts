import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONNECTIONS_FILE, parseConnections, type RuleRecord } from '@flowbook/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { Resolver } from './resolver.js';

const fixture = fileURLToPath(new URL('../../../fixtures/cpp-sample/', import.meta.url));
const read = (file: string) => readFileSync(fixture + file, 'utf8');
const fixtureRules: RuleRecord[] = parseConnections(
  read('.flowbook/connections.jsonl'),
  CONNECTIONS_FILE,
).rules;

let resolver: Resolver;
beforeAll(async () => {
  resolver = await Resolver.create();
});

const label = (s: ReturnType<Resolver['scan']>['sites'][number]) =>
  `${s.rule} ${s.role} ${s.matcher} ${s.symbol ?? '-'} ${s.key ?? '-'} ${s.handler ?? '-'}`;
const sites = (file: string) => resolver.scan(file, read(file), fixtureRules).sites.map(label);
const scan = (path: string, text: string, rules: RuleRecord[]) =>
  resolver.scan(path, text, rules).sites;

const rule = (over: Partial<RuleRecord> & Pick<RuleRecord, 'send'>): RuleRecord => ({
  kind: 'rule',
  id: 'r',
  title: 'R',
  type: 'queue',
  ...over,
});

describe('scan', () => {
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

  it('does not match declarations, definitions or #define lines', () => {
    expect(sites('src/rt/rt.h')).toEqual([]);
  });

  it('reports the line of the matched name', () => {
    const text = read('src/rt/jobs.c');
    const site = scan('src/rt/jobs.c', text, fixtureRules).find((s) => s.key === 'JOB_TICK')!;
    expect(text.split('\n')[site.line]).toContain('case JOB_TICK');
  });

  it('takes a non-identifier key as text without whitespace', () => {
    const r = rule({ send: [{ call: 'event_set', key: 1 }] });
    const [s] = scan('x.c', 'void f(void) { event_set(A | B); }', [r]);
    expect(s?.key).toBe('A|B');
  });

  it('marks a handler that is not an identifier', () => {
    const r = rule({ send: [{ call: 'timer_add', handler: 2 }] });
    const [s] = scan('x.c', 'void f(void) { timer_add(1, tbl[0], 0); }', [r]);
    expect(s?.unresolvedHandler).toBe(true);
    expect(s?.handler).toBeUndefined();
  });

  it('matches a function-like macro invocation by name', () => {
    const r = rule({ send: [{ call: 'POST_JOB', key: 2 }] });
    const [s] = scan('x.c', 'void f(void) { POST_JOB(j, JOB_X); }', [r]);
    expect(s?.key).toBe('JOB_X');
  });

  it('resolves a handler wrapped in & or parentheses', () => {
    const timer = fixtureRules.filter((r) => r.id === 'timer');
    const [amp] = scan('x.c', 'void f(void) { timer_add(1, &late, 0); }', timer);
    expect(amp).toMatchObject({ handler: 'late' });
    expect(amp?.unresolvedHandler).toBeUndefined();
    const [paren] = scan('x.c', 'void f(void) { timer_add(1, (&(late)), 0); }', timer);
    expect(paren).toMatchObject({ handler: 'late' });
    const [plain] = scan('x.c', 'void f(void) { timer_add(1, (late), 0); }', timer);
    expect(plain).toMatchObject({ handler: 'late' });
  });

  it('resolves an address-of handler in a designated initializer', () => {
    const cb = fixtureRules.filter((r) => r.id === 'app-cb');
    const text = 'struct app_cfg app = {.state_cb = &app_state};';
    const [s] = scan('x.c', text, cb);
    expect(s).toMatchObject({ key: 'state_cb', handler: 'app_state' });
    expect(s?.unresolvedHandler).toBeUndefined();
  });

  it('treats assigning NULL, nullptr or 0 to a handler field as no registration', () => {
    const r = rule({
      send: [{ invoke: 'reset_cb' }],
      receive: [{ assign: '.*_cb', as: 'handler' }],
    });
    const text =
      'struct ops o = {.reset_cb = NULL};\nvoid f(struct ops *cfg) { cfg->reset_cb = 0; cfg->reset_cb = (NULL); }\nstruct ops p = {.reset_cb = &real};\n';
    const found = scan('x.c', text, [r]).filter((s) => s.role === 'receive');
    expect(found.map((s) => `${s.key} ${s.handler ?? '-'}`)).toEqual(['reset_cb real']);
    const cpp = scan('x.cpp', 'void f(Ops *o) { o->reset_cb = nullptr; }', [r]);
    expect(cpp.filter((s) => s.role === 'receive')).toEqual([]);
  });

  it('keeps a call or cast handler unresolved', () => {
    const timer = fixtureRules.filter((r) => r.id === 'timer');
    const [s] = scan(
      'x.c',
      'void f(void) { timer_add(1, get(), 0); timer_add(1, (cb_t)p, 0); }',
      timer,
    );
    expect(s?.unresolvedHandler).toBe(true);
  });

  it('honours files globs', () => {
    const rules = fixtureRules.map((r) => ({
      ...r,
      send: r.send.map((m) => ({ ...m, files: ['src/other/**'] })),
      receive: r.receive?.map((m) => ({ ...m, files: ['src/other/**'] })),
    }));
    expect(scan('src/rt/jobs.c', read('src/rt/jobs.c'), rules)).toEqual([]);
  });

  it('gives two sites for two posts with one key in one function', () => {
    const r = rule({ send: [{ call: 'post', key: 1 }] });
    const found = scan('x.c', 'void f(void) { post(K); post(K); }', [r]);
    expect(found.map((s) => `${s.symbol} ${s.key}`)).toEqual(['f K', 'f K']);
  });

  it('survives a file with syntax errors', () => {
    const r = rule({ send: [{ call: 'job_post', key: 2 }] });
    const found = scan('x.c', 'void f(void) { job_post(&j, JOB_X, cb); @@@ ', [r]);
    expect(found).toHaveLength(1);
  });

  it('works with the C++ grammar', () => {
    const r = rule({ send: [{ invoke: '.*_cb' }] });
    const text = 'struct S { void run(Cfg* cfg) { cfg->state_cb(1); } };';
    const [s] = scan('x.cpp', text, [r]);
    expect(s).toMatchObject({ matcher: 'invoke', symbol: 'S::run', key: 'state_cb' });
  });

  it('returns no sites without rules', () => {
    expect(scan('src/rt/jobs.c', read('src/rt/jobs.c'), [])).toEqual([]);
  });
});
