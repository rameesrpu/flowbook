import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resolver } from '@flowbook/resolver';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { check, resolve, sites, stale, stamp, states, type Context } from './commands.js';

const fixture = fileURLToPath(new URL('../../../fixtures/cpp-sample', import.meta.url));

let resolver: Resolver;
let root: string;
let out: string[];
let err: string[];
let ctx: Context;

beforeAll(async () => {
  resolver = await Resolver.create();
});
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'flowbook-'));
  cpSync(fixture, root, { recursive: true });
  out = [];
  err = [];
  ctx = { root, resolver, io: { out: (l) => out.push(l), err: (l) => err.push(l) } };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const edit = (file: string, from: string, to: string) => {
  const path = join(root, file);
  writeFileSync(path, readFileSync(path, 'utf8').replace(from, to));
};

describe('check', () => {
  it('passes on the stamped fixture', () => {
    expect(check(ctx)).toBe(0);
    expect(out.at(-1)).toBe(
      '2 flows, 17 nodes: 0 errors, 0 warnings (0 stale, 0 unstamped), 1 unknown source state',
    );
  });

  it('ignores comment and formatting changes', () => {
    edit('src/net/event_loop.cpp', 'void EventLoop::run() {', '// loop\nvoid EventLoop::run()\n{');
    expect(check(ctx)).toBe(0);
    expect(out.at(-1)).toMatch(/0 stale/);
  });

  it('reports stale nodes as warnings, or errors with --strict', () => {
    edit('src/net/event_loop.cpp', 'dispatch(fd);', 'dispatch(fd + 0);');
    expect(check(ctx)).toBe(0);
    expect(out.join('\n')).toMatch(
      /startup\.jsonl:9: warning: stale: src\/net\/event_loop\.cpp#net::EventLoop::run/,
    );
    out.length = 0;
    expect(check(ctx, { strict: true })).toBe(1);
  });

  it('reports renamed functions with suggestions', () => {
    edit('src/util/log.c', 'void log_init(int verbose)', 'void log_setup(int verbose)');
    expect(check(ctx)).toBe(1);
    expect(out.join('\n')).toMatch(
      /startup\.jsonl:3: error: no definition for src\/util\/log\.c#log_init; run `flowbook resolve src\/util\/log\.c`/,
    );
  });

  it('suggests files with the same name for a wrong anchor path', () => {
    edit('.flowbook/flows/startup.jsonl', '"file":"src/util/log.c"', '"file":"log.c"');
    expect(check(ctx)).toBe(1);
    expect(out.join('\n')).toMatch(
      /startup\.jsonl:3: error: source file not found: log\.c; did you mean src\/util\/log\.c\?/,
    );
  });

  it('asks for a signature when an anchor hits an overload', () => {
    edit('.flowbook/flows/startup.jsonl', ',"sig":"(Timer*)"', '');
    expect(check(ctx)).toBe(1);
    expect(out.join('\n')).toMatch(
      /is overloaded; add "sig" with one of: \(int,Callback,void\*\) \| \(Timer\*\)/,
    );
  });
});

describe('stale', () => {
  it('lists only changed or broken nodes', () => {
    expect(stale(ctx)).toBe(0);
    edit('src/proto/parser.cpp', 'return type < 16;', 'return type < 32;');
    out.length = 0;
    expect(stale(ctx, { json: true })).toBe(1);
    expect(JSON.parse(out[0]!)).toMatchObject([
      { flow: 'packet-handling', node: 'valid-type', state: 'stale' },
    ]);
  });
});

describe('stamp', () => {
  it('refreshes fingerprints and only touches node lines', () => {
    edit('src/proto/parser.cpp', 'return type < 16;', 'return type < 32;');
    const path = join(root, '.flowbook/flows/packet-handling.jsonl');
    const before = readFileSync(path, 'utf8').split('\n');
    expect(stamp(ctx, ['packet-handling'])).toBe(0);
    const after = readFileSync(path, 'utf8').split('\n');
    const changed = after.flatMap((l, i) => (l === before[i] ? [] : [i + 1]));
    // Outside git, every node loses "verified"; lines of other kinds must be untouched.
    expect(changed.every((n) => JSON.parse(after[n - 1]!).kind === 'node')).toBe(true);
    expect(JSON.parse(after[7]!)).not.toHaveProperty('verified');
    out.length = 0;
    expect(check(ctx)).toBe(0);
    expect(out.at(-1)).toMatch(/0 stale/);
  });

  it('requires flow ids or --all', () => {
    expect(stamp(ctx, [])).toBe(1);
    expect(stamp(ctx, ['nope'])).toBe(1);
    expect(err).toEqual([
      'error: name the flows to stamp, or pass --all',
      'error: unknown flow(s): nope',
    ]);
  });
});

describe('resolve', () => {
  it('lists definitions as ready-to-use anchors, with sig only for overloads', () => {
    expect(resolve(ctx, join(root, 'src/net/event_loop.cpp'), undefined, undefined)).toBe(0);
    expect(out[0]).toMatch(
      /^\s+5 {2}function {2}\{"file":"src\/net\/event_loop\.cpp","symbol":"net::EventLoop::add","sig":"\(int,Callback,void\*\)"\}$/,
    );
    expect(out[2]).toMatch(
      /\{"file":"src\/net\/event_loop\.cpp","symbol":"net::EventLoop::run"\}$/,
    );
  });

  it('suggests qualified names', () => {
    expect(resolve(ctx, join(root, 'src/net/event_loop.cpp'), 'run', undefined)).toBe(1);
    expect(err[1]).toMatch(/did you mean: 13 {2}function {2}\{.*"net::EventLoop::run"\}/);
  });
});

describe('sites', () => {
  it('prints a summary line per rule', () => {
    expect(sites(ctx)).toBe(0);
    expect(out.slice(-5)).toEqual([
      'job: 5 send, 3 receive, 3 keys paired (1 confirmed), 0 unpaired, 1 forwarding',
      'timer: 1 send, 0 receive, 1 sends paired (1 confirmed), 0 unpaired',
      'event: 3 send, 1 receive, 1 keys paired (1 confirmed), 0 unpaired',
      'app-cb: 1 send, 2 receive, 1 keys paired (0 confirmed), 1 unpaired',
      'mbox: 3 send, 2 receive, 2 keys paired (1 confirmed), 0 unpaired',
    ]);
  });

  it('shows reactors of a send site', () => {
    sites(ctx);
    expect(
      out.some((l) =>
        /jobs\.c:\d+: job send JOB_READ_CNF → rt_main \(case JOB_READ_CNF\), read_done$/.test(l),
      ),
    ).toBe(true);
  });

  it('marks unconfirmed reactors', () => {
    sites(ctx);
    expect(out.find((l) => l.includes('JOB_WRITE_CNF → '))).toContain(
      'rt_main (case JOB_WRITE_CNF) ?',
    );
  });

  it('flags a keyed post whose key has no receive site', () => {
    edit('src/rt/jobs.c', 'case JOB_WRITE_CNF:', '');
    sites(ctx);
    expect(out.find((l) => l.includes('job send JOB_WRITE_CNF → '))).toMatch(
      /→ write_done \? · no receive site for JOB_WRITE_CNF$/,
    );
    expect(out.find((l) => l.startsWith('job: '))).toContain(', 1 without receive site');
    out.length = 0;
    sites(ctx, { json: true });
    const data = JSON.parse(out.join('\n')) as {
      sites: { key?: string; role: string; missingReceive?: boolean }[];
      rules: { rule: string; missingReceive: number }[];
    };
    const send = data.sites.find((s) => s.role === 'send' && s.key === 'JOB_WRITE_CNF')!;
    expect(send.missingReceive).toBe(true);
    expect(data.sites.find((s) => s.key === 'JOB_READ_CNF')!.missingReceive).toBeUndefined();
    expect(data.rules.find((r) => r.rule === 'job')!.missingReceive).toBe(1);
  });

  describe('forwarding sends', () => {
    const wrapper = (file: string, code: string) =>
      writeFileSync(join(root, file), readFileSync(join(root, file), 'utf8') + code);

    it('names the forwarded parameter, counts it, and leaves --unpaired alone', () => {
      wrapper('src/rt/jobs.c', '\nvoid wrap(int a, int kind) { event_set(kind); }\n');
      sites(ctx);
      expect(out.find((l) => l.includes('event send kind'))).toMatch(
        /jobs\.c:\d+: event send kind → forwards parameter kind \(argument 2 of wrap\)$/,
      );
      expect(out.find((l) => l.startsWith('event: '))).toMatch(/, 1 forwarding$/);
      expect(out.find((l) => l.startsWith('job: '))).toMatch(/, 1 forwarding$/);
      out.length = 0;
      sites(ctx, { json: true });
      const data = JSON.parse(out.join('\n')) as {
        sites: { key?: string; forwards?: unknown; forwarded?: boolean }[];
      };
      const row = data.sites.find((s) => s.key === 'kind')!;
      expect(row.forwards).toEqual({ param: 'kind', position: 2 });
      expect(row.forwarded).toBe(true);
      out.length = 0;
      sites(ctx, { unpaired: true });
      expect(out.some((l) => l.includes('event send kind'))).toBe(false);
    });

    it('prints the reactors of a forwarding send that has some', () => {
      wrapper(
        'src/rt/jobs.c',
        '\nvoid wrap2(int a, job_type_t kind) { job_post(0, kind, read_done); }\n',
      );
      sites(ctx);
      const line = out.find((l) => l.includes('job send kind'))!;
      expect(line).toContain('read_done');
      expect(line).not.toContain('no receive site');
      expect(line).not.toContain('forwards parameter');
    });
  });

  it('--unpaired lists only unpaired sites', () => {
    sites(ctx, { unpaired: true });
    const lines = out.filter((l) => /^\S+:\d+: /.test(l));
    expect(lines).toHaveLength(1);
    expect(lines.some((l) => /app\.c:\d+: app-cb receive data_cb → unpaired$/.test(l))).toBe(true);
  });

  it('--rule filters and rejects an unknown rule', () => {
    expect(sites(ctx, { rule: 'timer' })).toBe(0);
    expect(out.filter((l) => /^\S+:\d+: /.test(l)).every((l) => l.includes(' timer '))).toBe(true);
    out.length = 0;
    expect(sites(ctx, { rule: 'nope' })).toBe(1);
    expect(err.join('\n')).toContain('unknown rule');
  });

  it('--json is parseable and 1-based', () => {
    expect(sites(ctx, { json: true })).toBe(0);
    const data = JSON.parse(out.join('\n')) as {
      sites: { file: string; line: number; rule: string; role: string; key?: string }[];
      rules: { rule: string }[];
    };
    expect(data.rules.map((r) => r.rule)).toEqual(['job', 'timer', 'event', 'app-cb', 'mbox']);
    const src = readFileSync(join(root, 'src/rt/jobs.c'), 'utf8').split('\n');
    const tick = data.sites.find((s) => s.role === 'receive' && s.key === 'JOB_TICK')!;
    expect(src[tick.line - 1]).toContain('case JOB_TICK');
  });

  it('marks each of several handler candidates (I3)', () => {
    edit(
      'src/rt/jobs.c',
      'static void on_poll_timeout(void *arg) {',
      'void on_poll_timeout(void *arg) {',
    );
    writeFileSync(join(root, 'src/rt/poll.c'), 'void on_poll_timeout(void *arg) { (void)arg; }\n');
    edit('src/rt/app.c', 'static void app_state(int state)', 'void app_state(int state)');
    writeFileSync(join(root, 'src/rt/ui.c'), 'void app_state(int state) { (void)state; }\n');
    expect(sites(ctx)).toBe(0);
    expect(out.find((l) => l.includes('timer send on_poll_timeout'))).toMatch(
      /jobs\.c:24: timer send on_poll_timeout → on_poll_timeout \(candidate\), on_poll_timeout \(candidate\)$/,
    );
    expect(out.find((l) => l.includes('app-cb send state_cb'))).toMatch(
      /→ src\/rt\/app\.c:6 \(assign state_cb\) \?, app_state \(candidate\), app_state \(candidate\)$/,
    );
  });

  it('prints errors in connections.jsonl to stderr and exits 1 (I4)', () => {
    edit('.flowbook/connections.jsonl', '"timer_add","handler":2', '"timer_add","handlr":2');
    expect(sites(ctx)).toBe(1);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/\.flowbook\/connections\.jsonl:2: error: .*handlr/);
    // The site lines are still printed; the timer rule is not loaded.
    expect(out.some((l) => l.includes(' job send '))).toBe(true);
    expect(out.some((l) => l.includes(' timer '))).toBe(false);
    err.length = 0;
    out.length = 0;
    expect(sites(ctx, { json: true })).toBe(1);
    expect(err[0]).toMatch(/connections\.jsonl:2: error:/);
    expect(() => JSON.parse(out.join('\n'))).not.toThrow();
    // The dropped rule's id is unknown; the error says why.
    err.length = 0;
    expect(sites(ctx, { rule: 'timer' })).toBe(1);
    expect(err[0]).toMatch(/connections\.jsonl:2: error:/);
    expect(err[1]).toContain('unknown rule "timer"');
  });

  it('--unpaired lists a send missing its receive site (M5)', () => {
    edit('src/rt/jobs.c', 'case JOB_WRITE_CNF:', '');
    sites(ctx, { unpaired: true });
    expect(
      out.some((l) =>
        /jobs\.c:17: job send JOB_WRITE_CNF → write_done \? · no receive site for JOB_WRITE_CNF$/.test(
          l,
        ),
      ),
    ).toBe(true);
  });

  it('--json columns are 1-based (M7)', () => {
    sites(ctx, { json: true });
    const data = JSON.parse(out.join('\n')) as {
      sites: { key?: string; role: string; reactors?: { line: number; column: number }[] }[];
    };
    const src = readFileSync(join(root, 'src/rt/jobs.c'), 'utf8').split('\n');
    const read = data.sites.find((s) => s.role === 'send' && s.key === 'JOB_READ_CNF')!;
    const [cse] = read.reactors!;
    expect(src[cse!.line - 1]!.indexOf('JOB_READ_CNF') + 1).toBe(cse!.column);
  });

  it('warns about a skipped file on stderr (M2)', () => {
    writeFileSync(
      join(root, 'src/rt/big.c'),
      `void big(void) { job_post(0, JOB_READ_CNF, 0); }\n${'int x;\n'.repeat(450_000)}`,
    );
    expect(sites(ctx)).toBe(0);
    expect(err).toEqual([
      expect.stringMatching(/^warning: skipped \S*src\/rt\/big\.c: larger than 2 MB \(3\.0 MB\)$/),
    ]);
    err.length = 0;
    expect(check(ctx)).toBe(0);
    expect(err).toEqual([expect.stringMatching(/^warning: skipped \S*src\/rt\/big\.c: /)]);
  });

  it('prints nothing but returns 0 without a connections file', () => {
    rmSync(join(root, '.flowbook/connections.jsonl'));
    expect(sites(ctx)).toBe(0);
    expect(out).toEqual([]);
    expect(err).toEqual([]);
  });
});

describe('check with connections', () => {
  it('stays clean on the fixture', () => {
    expect(check(ctx)).toBe(0);
    expect(out.at(-1)).toBe(
      '2 flows, 17 nodes: 0 errors, 0 warnings (0 stale, 0 unstamped), 1 unknown source state',
    );
  });

  it('is unchanged when connections.jsonl is deleted', () => {
    rmSync(join(root, '.flowbook/connections.jsonl'));
    expect(check(ctx)).toBe(0);
    expect(out.at(-1)).toBe(
      '2 flows, 17 nodes: 0 errors, 0 warnings (0 stale, 0 unstamped), 1 unknown source state',
    );
  });

  it('fails when a confirmed key loses its case', () => {
    edit('src/rt/jobs.c', 'case JOB_READ_CNF:', '');
    expect(check(ctx)).toBe(1);
    const text = out.join('\n');
    expect(text).toContain('connections.jsonl:6: error:');
    expect(text).toContain('has no receive site');
  });

  it('fails on an invalid regular expression', () => {
    edit('.flowbook/connections.jsonl', '"JOB_.*"', '"JOB_("');
    expect(check(ctx)).toBe(1);
    expect(out.join('\n')).toMatch(/connections\.jsonl:1: error:/);
  });

  it('warns about a rule that matches nothing', () => {
    const path = join(root, '.flowbook/connections.jsonl');
    const text = readFileSync(path, 'utf8').replace(/\n*$/, '\n');
    writeFileSync(
      path,
      text +
        '{"kind":"rule","id":"ghost","title":"Ghost","type":"queue","send":[{"call":"nope_fn","handler":1}]}\n',
    );
    expect(check(ctx)).toBe(0);
    expect(out.join('\n')).toMatch(/connections\.jsonl:\d+: warning: rule "ghost" matches no site/);
  });
});

describe('states', () => {
  it('prints a line per transition and a summary per machine', () => {
    expect(states(ctx)).toBe(0);
    expect(out).toContain(
      'src/rt/sm_link.c:19: link IDLE → RUN on LINK_EV_START · sets off event → rt_main',
    );
    expect(out).toContain('src/rt/sm_link.c:29: link RUN → FAIL on LINK_EV_ERROR if l->retries>3');
    expect(out).toContain(
      'src/rt/sm_cm.c:17: cm T1 INIT → RUN on CM_EV_START · sets off event → rt_main',
    );
    expect(out).toContain('src/rt/sm_dl.c:13: dl STARTUP → PREOP in dl_startup if d->cmd==1');
    expect(out).toContain('src/rt/sm_dev.c:13: dev * → POWER_ON in dev_abort');
    expect(out.slice(-4)).toEqual([
      'link: 3 states, 3 transitions (3 from a case), 1 sets off',
      'dl: 3 states, 2 transitions (2 from a caller)',
      'cm: 3 states, 4 transitions (4 from a table), 1 sets off',
      'dev: 3 states, 3 transitions (1 from a case, 1 from a scope, 1 unknown)',
    ]);
  });

  it('filters by machine', () => {
    states(ctx, { machine: 'dev' });
    expect(out).toHaveLength(4);
    expect(out.every((l) => l.includes(' dev ') || l.startsWith('dev:'))).toBe(true);
  });

  it('rejects an unknown machine', () => {
    expect(states(ctx, { machine: 'nope' })).toBe(1);
    expect(err[0]).toContain('unknown machine "nope"');
  });

  it('lists only unknown source states with --unknown', () => {
    states(ctx, { unknown: true });
    expect(out.filter((l) => l.includes(' → '))).toEqual([
      'src/rt/sm_dev.c:13: dev * → POWER_ON in dev_abort',
    ]);
  });

  it('prints machines and diagnostics as json', () => {
    states(ctx, { json: true, machine: 'cm' });
    const data = JSON.parse(out.join('\n')) as {
      machines: { id: string; transitions: { from: string; via: string }[] }[];
      diagnostics: unknown[];
    };
    expect(data.machines.map((m) => m.id)).toEqual(['cm']);
    expect(data.machines[0]!.transitions.map((t) => t.from)).toEqual([
      'CM_ST_INIT',
      'CM_ST_INIT',
      'CM_ST_RUN',
      'CM_ST_RUN',
    ]);
    expect(data.diagnostics).toEqual([]);
  });

  it('exits 1 when the machines file has errors', () => {
    edit('.flowbook/machines.jsonl', '"id":"dev"', '"idd":"dev"');
    expect(states(ctx)).toBe(1);
    expect(err.some((l) => l.includes('machines.jsonl'))).toBe(true);
  });
});

describe('check with machines', () => {
  it('reports machine diagnostics and never fails strict on unknown sources', () => {
    edit('.flowbook/machines.jsonl', '"state":"DEV_ST_POWER_ON"', '"state":"DEV_ST_TYPO"');
    expect(check(ctx, { strict: true })).toBe(0);
    expect(out.some((l) => l.includes('DEV_ST_TYPO') && l.includes('warning'))).toBe(true);
    expect(out.at(-1)).toContain('1 unknown source state');
  });
});
