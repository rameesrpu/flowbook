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

  it('gives one test site per identifier inside nested conditions (M6)', () => {
    const r = rule({ send: [{ call: 'event_set', key: 1 }], receive: [{ test: 'EVT_.*' }] });
    const text =
      'int f(int x) { if (x & (EVT_A ? EVT_B : 0)) return 1; while (x ? EVT_C : 0) {} return 0; }';
    const found = scan('x.c', text, [r]).filter((s) => s.role === 'receive');
    expect(found.map((s) => s.key)).toEqual(['EVT_A', 'EVT_B', 'EVT_C']);
  });

  it('keyMember takes the last member', () => {
    const r = rule({ send: [{ call: 'os_mbox_post|post', key: 1, keyMember: true }] });
    const text = [
      'void f(struct port *port, struct master *master, struct x *p) {',
      '  os_mbox_post (port->master->mbox_avail, j, 0);',
      '  os_mbox_post (master->mbox_avail, j, 0);',
      '  post (&boxes[i].mbox);',
      '  post ((void *)p->mbox);',
      '  post (get_box (port));',
      '}',
    ].join('\n');
    expect(scan('x.c', text, [r]).map((s) => s.key)).toEqual([
      'mbox_avail',
      'mbox_avail',
      'mbox',
      'mbox',
      'get_box(port)',
    ]);
  });

  it('keyMember on assign', () => {
    const r = rule({
      send: [{ call: 'post' }],
      receive: [{ assign: 'box', as: 'key', keyMember: true }],
    });
    const [s] = scan('x.c', 'void f(void) { job->box = port->master->mbox; }', [r]);
    expect(s?.key).toBe('mbox');
  });

  it('keeps the key text without keyMember', () => {
    const r = rule({ send: [{ call: 'post', key: 1 }] });
    const [s] = scan('x.c', 'void f(void) { post(&boxes[i].mbox); }', [r]);
    expect(s?.key).toBe('&boxes[i].mbox');
  });

  it('keys filters sites', () => {
    const r = rule({ send: [{ assign: 'type', as: 'key', keys: 'JOB_EXIT' }] });
    const found = scan('x.c', 'void f(void) { job->type = JOB_NONE; job->type = JOB_EXIT; }', [r]);
    expect(found.map((s) => s.key)).toEqual(['JOB_EXIT']);
    const call = rule({ send: [{ call: 'post', key: 1, keys: '.*' }] });
    expect(scan('x.c', 'void f(void) { post (); }', [call])).toEqual([]);
  });

  it('skips a matcher whose keys expression is invalid', () => {
    const r = rule({ send: [{ call: 'post', key: 1, keys: '(' }, { call: 'other' }] });
    const found = scan('x.c', 'void f(void) { post(A); other(); }', [r]);
    expect(found.map((s) => s.key ?? '-')).toEqual(['-']);
  });

  it('marks forwarding sites', () => {
    const post = rule({ send: [{ call: 'post', key: 1, handler: 2 }] });
    const [wrap] = scan('x.c', 'void wrap (int a, int type, cb_t cb) { post (type, cb); }', [post]);
    expect(wrap?.forwards).toEqual({ param: 'type', position: 2 });

    const tadd = rule({ send: [{ call: 'tadd', handler: 1 }] });
    const [w2] = scan('x.c', 'void w2 (cb_t cb) { tadd (cb); }', [tadd]);
    expect(w2?.forwards).toEqual({ param: 'cb', position: 1 });

    const assign = rule({ send: [{ assign: 'type', as: 'key' }] });
    const [h] = scan('x.c', 'void h (int type) { job->type = type; }', [assign]);
    expect(h?.forwards).toEqual({ param: 'type', position: 1 });

    const [constant] = scan('x.c', 'void wrap (int type, cb_t cb) { post (JOB_A, cb); }', [post]);
    expect(constant).toBeDefined();
    expect(constant?.forwards).toBeUndefined();

    const recv = rule({ send: [{ call: 'post', key: 1 }], receive: [{ call: 'take', key: 1 }] });
    const [r] = scan('x.c', 'void g (int type) { take (type); }', [recv]);
    expect(r?.role).toBe('receive');
    expect(r?.forwards).toBeUndefined();

    const [v] = scan('x.c', 'void v (void) { post (x, y); }', [post]);
    expect(v).toBeDefined();
    expect(v?.forwards).toBeUndefined();
  });

  it('reads parameters through pointer, reference and function-pointer declarators', () => {
    const r = rule({ send: [{ call: 'post', handler: 1 }] });
    const c = 'static int *mk (struct s *box, void (*cb)(int)) { post (cb); return 0; }';
    expect(scan('x.c', c, [r])[0]?.forwards).toEqual({ param: 'cb', position: 2 });
    const cpp = 'int &S::mk (Box &box, int n) { post (box); return n; }';
    expect(scan('x.cpp', cpp, [r])[0]?.forwards).toEqual({ param: 'box', position: 1 });
  });

  it('returns no sites without rules', () => {
    expect(scan('src/rt/jobs.c', read('src/rt/jobs.c'), [])).toEqual([]);
  });
});
