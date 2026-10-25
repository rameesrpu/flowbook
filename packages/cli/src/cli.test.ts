import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resolver } from '@flowbook/resolver';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { check, resolve, stale, stamp, type Context } from './commands.js';

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
    expect(out.at(-1)).toBe('2 flows, 17 nodes: 0 errors, 0 warnings (0 stale, 0 unstamped)');
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
