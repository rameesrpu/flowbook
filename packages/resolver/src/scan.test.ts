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

// Every file read of the scan goes through this pass-through spy, so tests can count reads.
const { readSpy } = vi.hoisted(() => ({ readSpy: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  readSpy.mockImplementation(fs.readFileSync);
  return { ...fs, readFileSync: readSpy };
});
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

  it('does not cache a file saved between its read and the cache write (I1)', () => {
    const root = temp();
    put(root, 'src/a.c', 'void a(void) { job_post(1); }');
    const c = conns([rule('job', 'job_post')]);
    const cache = createScanCache();
    const real = resolver.scan.bind(resolver);
    // Saves a new version of the file while the old text is being parsed.
    const racing = vi.spyOn(resolver, 'scan').mockImplementationOnce((path, text, rules) => {
      const result = real(path, text, rules);
      put(root, 'src/a.c', 'void a(void) { job_post(1); job_post(2); }');
      utimesSync(join(root, 'src/a.c'), new Date(), new Date(Date.now() + 5000));
      return result;
    });
    expect(scanRoot(root, c, resolver, cache).get('src/a.c')!.sites).toHaveLength(1);
    racing.mockRestore();
    const spy = vi.spyOn(resolver, 'scan');
    const next = scanRoot(root, c, resolver, cache);
    expect(spy.mock.calls.map((x) => x[0])).toEqual(['src/a.c']);
    expect(next.get('src/a.c')!.sites).toHaveLength(2);
    spy.mockRestore();
  });

  it('does not re-read files the prefilter rejected while the handler set is unchanged (I2)', () => {
    const root = temp();
    const timer: RuleRecord = {
      kind: 'rule',
      id: 'timer',
      title: 'T',
      type: 'timer',
      send: [{ call: 'timer_add', handler: 2 }],
    };
    put(root, 'src/a.c', 'void go(void) { timer_add(1, late, 0); }');
    put(root, 'src/b.c', 'void late(void) {}');
    for (let i = 0; i < 4; i++) put(root, `src/u${i}.c`, `void u${i}(void) {}`);
    const c = conns([timer]);
    const cache = createScanCache();
    const reads = () =>
      readSpy.mock.calls
        .map((x) => String(x[0]))
        .filter((p) => p.startsWith(root))
        .map((p) => p.slice(root.length + 1));
    readSpy.mockClear();
    const first = scanRoot(root, c, resolver, cache);
    expect([...first.keys()].sort()).toEqual(['src/a.c', 'src/b.c']);
    expect(reads().filter((p) => p.includes('/u'))).toHaveLength(8); // both passes
    readSpy.mockClear();
    expect(scanRoot(root, c, resolver, cache)).toEqual(first);
    expect(reads()).toEqual([]);
    // A new handler name: the rejected files are read again.
    put(root, 'src/a.c', 'void go(void) { timer_add(1, late, 0); timer_add(2, u1, 0); }');
    utimesSync(join(root, 'src/a.c'), new Date(), new Date(Date.now() + 5000));
    readSpy.mockClear();
    const third = scanRoot(root, c, resolver, cache);
    expect(
      reads()
        .filter((p) => p.includes('/u'))
        .sort(),
    ).toEqual(['src/u0.c', 'src/u1.c', 'src/u2.c', 'src/u3.c']);
    expect([...third.keys()].sort()).toEqual(['src/a.c', 'src/b.c', 'src/u1.c']);
  });

  it('scanRootSliced pauses during long runs of cache hits (I2)', async () => {
    const root = temp();
    for (let i = 0; i < 45; i++) put(root, `src/f${i}.c`, `void f${i}(void) { job_post(1); }`);
    const c = conns([rule('job', 'job_post')]);
    const cache = createScanCache();
    await scanRootSliced(root, c, resolver, cache, async () => {});
    const pause = vi.fn(async () => {});
    const spy = vi.spyOn(resolver, 'scan');
    await scanRootSliced(root, c, resolver, cache, pause);
    expect(spy).not.toHaveBeenCalled();
    expect(pause).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('skips and reports a file over 2 MB (M2)', () => {
    const root = temp();
    put(root, 'src/a.c', 'void a(void) { job_post(1); }');
    put(root, 'src/big.c', `void big(void) { job_post(1); }\n${'int x;\n'.repeat(450_000)}`);
    const spy = vi.spyOn(resolver, 'scan');
    const skipped: string[] = [];
    const scans = scanRoot(
      root,
      conns([rule('job', 'job_post')]),
      resolver,
      createScanCache(),
      (p, r) => skipped.push(`${p}: ${r}`),
    );
    expect([...scans.keys()]).toEqual(['src/a.c']);
    expect(spy.mock.calls.map((x) => x[0])).toEqual(['src/a.c']);
    expect(skipped).toEqual(['src/big.c: larger than 2 MB (3.0 MB)']);
    spy.mockRestore();
  });

  it('skips and reports a file whose parse throws, and scans the rest (M2)', () => {
    const root = temp();
    put(root, 'src/a.c', 'void a(void) { job_post(1); }');
    put(root, 'src/b.c', 'void b(void) { job_post(2); }');
    const real = resolver.scan.bind(resolver);
    const spy = vi.spyOn(resolver, 'scan').mockImplementation((path, text, rules) => {
      if (path === 'src/a.c') throw new Error('boom');
      return real(path, text, rules);
    });
    const skipped: string[] = [];
    const cache = createScanCache();
    const scans = scanRoot(root, conns([rule('job', 'job_post')]), resolver, cache, (p, r) =>
      skipped.push(`${p}: ${r}`),
    );
    expect([...scans.keys()]).toEqual(['src/b.c']);
    expect(skipped).toEqual(['src/a.c: parse failed: boom']);
    expect(cache.files.has('src/a.c')).toBe(false);
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

  it('scans a file a quantified class matches (M1)', () => {
    const files = [
      { path: 'a.c', text: 'void a(void) { FOO_CB(1); }' },
      { path: 'b.c', text: 'void b(void) { other(); }' },
    ];
    const scans = scanSources(files, conns([rule('r', '[A-Z_]{2,100}_CB')]), resolver);
    expect(scans.get('a.c')!.sites).toHaveLength(1);
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
    // M1: quantifier bodies and escape payloads are not literal text.
    ['[A-Z_]{2,100}_CB', ['_CB']],
    ['x{2,100}', null],
    ['(ab){1000}post', ['post']],
    ['\\x41bcdef', ['bcdef']],
    ['\\u0041bcdef', ['bcdef']],
    ['\\p{Lu}abc', ['abc']],
    ['\\k<name>abc', ['abc']],
    ['\\123abc', ['abc']],
    ['a{bc', null],
  ])('%s', (src, expected) => {
    expect(literalFragments(src)).toEqual(expected);
  });
});

describe('readWorkspace', () => {
  it('readWorkspace loads the fixture connections', () => {
    expect(readWorkspace(fixture).connections.rules).toHaveLength(5);
  });
});
