import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resolver, type ReadSource } from '@flowbook/resolver';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildPayload,
  definitionDiff,
  languageOf,
  lensTargets,
  loadRoot,
  locate,
  nameRange,
  problemCount,
  rootOfFlowbookFile,
  snippetOf,
  type RootState,
} from './model.js';

const fixture = resolve(fileURLToPath(import.meta.url), '../../../../fixtures/cpp-sample');
const read = (rel: string) => readFileSync(join(fixture, rel), 'utf8');

let resolver: Resolver;
let state: RootState;

beforeAll(async () => {
  resolver = await Resolver.create();
  state = loadRoot(fixture, resolver);
});

describe('buildPayload', () => {
  it('builds the payload for a fixture flow', () => {
    const p = buildPayload(state, 'startup', 'run')!;
    expect(p.flow.meta.title).toBe('Server startup');
    expect(p.groups.map((g) => g.name)).toEqual(['Networking', 'Protocol']);
    expect(p.flowTitles).toEqual({
      startup: 'Server startup',
      'packet-handling': 'Packet handling',
    });
    expect(p.focus).toBe('run');
    expect(Object.keys(p.anchors).sort()).toEqual([
      'accept',
      'add-fd',
      'add-timer',
      'log-init',
      'main',
      'run',
      'server-run',
      'validate-fd',
    ]);
    expect(p.anchors['run']).toMatchObject({
      state: 'fresh',
      symbol: 'net::EventLoop::run',
      sig: '()',
    });
    expect(typeof p.anchors['run']!.line).toBe('number');
    expect(p.anchors['add-timer']).toMatchObject({ state: 'fresh', sig: '(Timer*)' });
    expect(p.diagnostics).toEqual([]);
  });

  it('lists usages in other flows only', () => {
    const p = buildPayload(state, 'startup')!;
    expect(p.focus).toBeUndefined();
    expect(p.usages).toEqual({
      run: [
        {
          flow: 'packet-handling',
          flowTitle: 'Packet handling',
          node: 'run',
          nodeTitle: 'Event loop',
        },
      ],
    });
  });

  it('returns undefined for an unknown flow', () => {
    expect(buildPayload(state, 'nope')).toBeUndefined();
  });

  it('reports stale and missing anchors from the source it was given', () => {
    const edited: ReadSource = (rel) => {
      const text = readFileSync(join(fixture, rel), 'utf8');
      if (rel === 'src/net/event_loop.cpp')
        return text.replace('dispatch(fd);', 'dispatch(fd + 1);');
      if (rel === 'src/main.c') return text.replace(/\bmain\(/, 'start(');
      return text;
    };
    const s = loadRoot(fixture, resolver, edited);
    const p = buildPayload(s, 'startup')!;
    expect(p.anchors['run']!.state).toBe('stale');
    expect(p.anchors['main']).toEqual({ state: 'missing' });
    expect(p.diagnostics.map((d) => d.severity)).toContain('error');
    expect(problemCount(s, p.flow)).toBeGreaterThanOrEqual(2);
    expect(problemCount(state, p.flow)).toBe(0);
  });
});

describe('snippets', () => {
  it('extracts the definition text', () => {
    const text = read('src/net/server.cpp');
    const sym = resolver
      .listSymbols('src/net/server.cpp', text)
      .find((s) => s.symbol === 'helper')!;
    const snip = snippetOf(text, 'src/net/server.cpp', sym);
    expect(snip).toEqual({
      code: 'static int helper(int fd) { return fd >= 0 ? fd : -1; }',
      startLine: sym.startLine,
      language: 'cpp',
    });
    expect(nameRange(text, sym)).toMatchObject({ line: sym.nameLine });
    const r = nameRange(text, sym);
    expect(text.split('\n')[r.line]!.slice(r.start, r.end)).toBe('helper');
  });

  it('truncates long definitions', () => {
    const body = Array.from({ length: 200 }, (_, i) => `  x += ${i};`).join('\n');
    const text = `int f(void) {\n  int x = 0;\n${body}\n  return x;\n}\n`;
    const sym = resolver.listSymbols('a.c', text)[0]!;
    const snip = snippetOf(text, 'a.c', sym, 120);
    const lines = snip.code.split('\n');
    expect(lines).toHaveLength(121);
    expect(lines[120]).toMatch(/84 more lines/);
    expect(snip.language).toBe('c');
  });

  it('picks the language from the extension', () => {
    expect(languageOf('src/main.c')).toBe('c');
    expect(languageOf('src/a.hpp')).toBe('cpp');
    expect(languageOf('src/a.h')).toBe('cpp');
  });

  it('selects the leaf of a qualified out-of-line name', () => {
    const text = read('src/net/event_loop.cpp');
    const sym = resolver
      .listSymbols('src/net/event_loop.cpp', text)
      .find((s) => s.symbol === 'net::EventLoop::run')!;
    const r = nameRange(text, sym);
    expect(text.split('\n')[r.line]!.slice(r.start, r.end)).toBe('run');
  });
});

describe('definitionDiff', () => {
  const anchor = { file: 'src/net/server.cpp', symbol: 'accept_conn' };

  it('diffs only the definition, with file line numbers', () => {
    const old = read(anchor.file);
    const now = old.replace('log_write(LOG_INFO, "accepted");', 'log_write(LOG_INFO, "ok");');
    const r = definitionDiff(resolver, anchor, old, now, 'abcdef1234');
    expect('diff' in r).toBe(true);
    const diff = (r as { diff: string }).diff;
    const start = old.split('\n').findIndex((l) => l.includes('accept_conn(int')) + 1;
    expect(diff.split('\n')[0]).toBe(`@@ -${start},5 +${start},5 @@`);
    expect(diff).toContain('-  log_write(LOG_INFO, "accepted");');
    expect(diff).toContain('+  log_write(LOG_INFO, "ok");');
    expect(diff).not.toContain('server_run');
  });

  it('explains when the symbol is absent at the commit', () => {
    const now = read(anchor.file);
    const old = now.replace(/accept_conn/g, 'accept_old');
    expect(definitionDiff(resolver, anchor, old, now, 'abcdef1234')).toEqual({
      error: 'accept_conn does not exist in src/net/server.cpp at abcdef1',
    });
  });
});

describe('lensTargets', () => {
  it('finds anchored definitions, including overloads by signature', () => {
    const rel = 'src/net/event_loop.cpp';
    const targets = lensTargets(state, rel, resolver.listSymbols(rel, read(rel)));
    const bySymbol = targets.map((t) => [
      `${t.symbol.symbol}${t.symbol.sig}`,
      t.usages.map((u) => `${u.flow}/${u.node}`),
    ]);
    expect(bySymbol).toEqual(
      expect.arrayContaining([
        ['net::EventLoop::run()', ['packet-handling/run', 'startup/run']],
        ['net::EventLoop::add(int,Callback,void*)', ['startup/add-fd']],
        ['net::EventLoop::add(Timer*)', ['startup/add-timer']],
      ]),
    );
  });
});

describe('paths', () => {
  it('finds the root of flowbook files', () => {
    expect(rootOfFlowbookFile('/r/x/.flowbook/config.jsonl')).toBe('/r/x');
    expect(rootOfFlowbookFile('/r/x/.flowbook/flows/a.jsonl')).toBe('/r/x');
    expect(rootOfFlowbookFile('/r/x/.flowbook/other.jsonl')).toBeUndefined();
  });

  it('locates a file in the innermost root', () => {
    expect(locate(['/r', '/r/sub'], '/r/sub/src/a.c')).toEqual({ root: '/r/sub', rel: 'src/a.c' });
    expect(locate(['/r'], '/rx/a.c')).toBeUndefined();
  });
});
