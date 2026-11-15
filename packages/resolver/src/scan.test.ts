import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONNECTIONS_FILE,
  parseConnections,
  type Connections,
  type RuleRecord,
} from '@flowbook/core';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { listSourceFiles, readWorkspace } from './fs.js';
import { Resolver } from './resolver.js';
import {
  createScanCache,
  literalFragments,
  scanRoot,
  scanRootSliced,
  scanSources,
  type ScanCache,
} from './scan.js';

const fixture = fileURLToPath(new URL('../../../fixtures/cpp-sample/', import.meta.url));
const fixtureConnections = parseConnections(
  readFileSync(fixture + CONNECTIONS_FILE, 'utf8'),
  CONNECTIONS_FILE,
);

let resolver: Resolver;
beforeAll(async () => {
  resolver = await Resolver.create();
});

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'flowbook-scan-'));
  temps.push(d);
  return d;
};
const put = (root: string, path: string, text: string) => {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), text);
};

const rule = (id: string, name: string): RuleRecord => ({
  kind: 'rule',
  id,
  title: id,
  type: 'queue',
  send: [{ call: name }],
  receive: [{ case: 'NEVER_X' }],
});
const conns = (rules: RuleRecord[], anchors: string[] = []): Connections => ({
  rules: rules.map((r, i) => ({ ...r, line: i + 1 })),
  connections: anchors.map((file, i) => ({
    kind: 'connection',
    id: `c${i}`,
    rule: rules[0]!.id,
    title: 'c',
    send: [{ file, symbol: 'f' }],
    receive: [{ file, symbol: 'f' }],
    line: 10 + i,
  })),
});

describe('listSourceFiles', () => {
  it('lists fixture sources, sorted, POSIX', () => {
    const files = listSourceFiles(fixture);
    expect(files).toContain('src/rt/jobs.c');
    expect(files).toContain('src/net/server.cpp');
    expect(files).toEqual([...files].sort());
  });

  it('skips dot-directories, node_modules, build, dist and out', () => {
    const root = temp();
    for (const d of ['.git', '.flowbook', 'node_modules', 'build', 'dist', 'out'])
      put(root, `${d}/x.c`, 'int x;');
    put(root, 'src/a.c', 'int a;');
    put(root, 'src/notes.txt', 'x');
    expect(listSourceFiles(root)).toEqual(['src/a.c']);
  });
});

describe('scanRoot', () => {
  it('scans only files a rule can match', () => {
    const scans = scanRoot(fixture, fixtureConnections, resolver);
    expect([...scans.keys()]).toContain('src/rt/jobs.c');
    expect([...scans.keys()]).toContain('src/rt/app.c');
    expect([...scans.keys()]).not.toContain('src/util/log.c');
  });

  it('reads nothing when there are no rules', () => {
    const spy = vi.spyOn(resolver, 'scan');
    const scans = scanRoot(fixture, { rules: [], connections: [] }, resolver);
    expect(scans.size).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('scanRootSliced returns what scanRoot returns and pauses', async () => {
    const root = temp();
    for (let i = 0; i < 25; i++) put(root, `src/f${i}.c`, `void f${i}(void) { job_post(1); }`);
    const c = conns([rule('job', 'job_post')]);
    const pause = vi.fn(async () => {});
    const sliced = await scanRootSliced(root, c, resolver, undefined, pause);
    expect(sliced).toEqual(scanRoot(root, c, resolver));
    expect(sliced.size).toBe(25);
    expect(pause).toHaveBeenCalled();
  });

  it('reuses the cache for unchanged files and rescans changed ones', () => {
    const root = temp();
    put(root, 'src/a.c', 'void a(void) { job_post(1); }');
    put(root, 'src/b.c', 'void b(void) { job_post(2); }');
    put(root, 'src/c.c', 'void c(void) { other(); }');
    const c = conns([rule('job', 'job_post')]);
    const cache: ScanCache = createScanCache();
    const first = scanRoot(root, c, resolver, cache);
    const spy = vi.spyOn(resolver, 'scan');
    expect(scanRoot(root, c, resolver, cache)).toEqual(first);
    expect(spy).not.toHaveBeenCalled();
    put(root, 'src/a.c', 'void a(void) { job_post(1); job_post(3); }');
    utimesSync(join(root, 'src/a.c'), new Date(), new Date(Date.now() + 5000));
    const second = scanRoot(root, c, resolver, cache);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(second.get('src/a.c')!.sites).toHaveLength(2);
    spy.mockRestore();
  });

  it('drops cached results when the rules change', () => {
    const cache = createScanCache();
    const first = scanRoot(fixture, fixtureConnections, resolver, cache);
    const timerSites = (m: typeof first) =>
      [...m.values()].flatMap((f) => f.sites).filter((s) => s.rule === 'timer');
    expect(timerSites(first).length).toBeGreaterThan(0);
    const changed: Connections = {
      ...fixtureConnections,
      rules: fixtureConnections.rules.map((r) =>
        r.id === 'timer' ? { ...r, send: [{ call: 'timer_gone', handler: 2 }] } : r,
      ),
    };
    const spy = vi.spyOn(resolver, 'scan');
    const second = scanRoot(fixture, changed, resolver, cache);
    expect(timerSites(second)).toEqual([]);
    expect(spy.mock.calls.map((c) => c[0])).toContain('src/rt/jobs.c');
    spy.mockRestore();
  });

  it('skips a file that cannot be read', () => {
    const root = temp();
    put(root, 'src/a.c', 'void a(void) { job_post(1); }');
    put(root, 'src/dir.c/inner.txt', 'x');
    const cache: ScanCache = createScanCache();
    cache.files.set('src/gone.c', { mtimeMs: 1, size: 1, scan: null });
    const scans = scanRoot(root, conns([rule('job', 'job_post')]), resolver, cache);
    expect([...scans.keys()]).toEqual(['src/a.c']);
  });
});

describe('scanSources', () => {
  it('ignores a matcher with an invalid regular expression', () => {
    const c = conns([rule('bad', 'foo('), rule('ok', 'bar')]);
    const scans = scanSources(
      [{ path: 'a.c', text: 'void f(void) { foo(1); bar(2); }' }],
      c,
      resolver,
    );
    expect(scans.get('a.c')!.sites.map((x) => x.rule)).toEqual(['ok']);
  });

  it('includes a file that only defines a handler', () => {
    const c = conns([
      {
        kind: 'rule',
        id: 'timer',
        title: 'T',
        type: 'timer',
        send: [{ call: 'timer_add', handler: 2 }],
      },
    ]);
    const scans = scanSources(
      [
        { path: 'a.c', text: 'void go(void) { timer_add(1, late, 0); }' },
        { path: 'b.c', text: 'void late(void) {}' },
        { path: 'c.c', text: 'void other(void) {}' },
      ],
      c,
      resolver,
    );
    expect([...scans.keys()].sort()).toEqual(['a.c', 'b.c']);
    expect(scans.get('b.c')!.sites).toEqual([]);
    expect(scans.get('b.c')!.symbols.map((s) => s.symbol)).toContain('late');
  });

  it('includes a file named by a connection anchor', () => {
    const c = conns([rule('job', 'job_post')], ['x.c']);
    const scans = scanSources(
      [
        { path: 'x.c', text: 'void f(void) {}' },
        { path: 'y.c', text: 'void g(void) {}' },
      ],
      c,
      resolver,
    );
    expect([...scans.keys()]).toEqual(['x.c']);
    expect(scans.get('x.c')!.sites).toEqual([]);
  });

  it('scans every file for alternation names', () => {
    const c = conns([rule('r', 'foo|bar')]);
    const scans = scanSources(
      [
        { path: 'a.c', text: 'void a(void) { foo(); }' },
        { path: 'b.c', text: 'void b(void) { bar(); }' },
        { path: 'c.c', text: 'void c(void) { baz(); }' },
      ],
      c,
      resolver,
    );
    expect([...scans.keys()].sort()).toEqual(['a.c', 'b.c']);
  });

  it('never skips a file an optional or repeated fragment could match', () => {
    const files = [
      { path: 'a.c', text: 'void a(void) { post(); }' },
      { path: 'b.c', text: 'void b(void) { abpost(); }' },
      { path: 'c.c', text: 'void c(void) { ab(); }' },
      { path: 'd.c', text: 'void d(void) { abcccc(); }' },
    ];
    const opt = scanSources(files, conns([rule('r', '(abc)?post')]), resolver);
    expect(opt.get('a.c')!.sites).toHaveLength(1);
    const star = scanSources(files, conns([rule('r', 'abc*')]), resolver);
    expect(star.get('c.c')!.sites).toHaveLength(1);
    expect(star.get('d.c')!.sites).toHaveLength(1);
  });
});

describe('literalFragments', () => {
  it.each([
    ['job_post', ['job_post']],
    ['JOB_.*', ['JOB_']],
    ['foo|bar', ['foo', 'bar']],
    ['(abc)?post', ['post']],
    ['abc*', null],
    ['abcd?', ['abc']],
    ['abc+', ['abc']],
    ['[abc]def', ['def']],
    ['.*_cb', ['_cb']],
    ['a|.*', null],
    ['(foo|bar)_x', null],
    ['\\wfoo', ['foo']],
  ])('%s', (src, expected) => {
    expect(literalFragments(src)).toEqual(expected);
  });
});

describe('readWorkspace', () => {
  it('readWorkspace loads the fixture connections', () => {
    expect(readWorkspace(fixture).connections.rules).toHaveLength(5);
  });
});
