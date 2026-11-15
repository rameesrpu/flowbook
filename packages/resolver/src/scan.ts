import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type Connections, type Matcher } from '@flowbook/core';
import { listSourceFiles } from './fs.js';
import type { Resolver } from './resolver.js';
import { compileName, type FileScan } from './sites.js';

export interface SourceText {
  /** Root-relative POSIX path. */
  path: string;
  text: string;
}

/**
 * Results of earlier scans, reused while a file's `mtimeMs` and `size` match. A `null` scan is a
 * file the prefilter rejected. `rulesKey` identifies the rules the results were computed for; the
 * scan clears `files` when it changes.
 */
export interface ScanCache {
  rulesKey?: string;
  files: Map<string, { mtimeMs: number; size: number; scan: FileScan | null }>;
}

export const createScanCache = (): ScanCache => ({ files: new Map() });

/** Everything the results depend on besides file contents: rule records and anchored files. */
function rulesKeyOf(connections: Connections): string {
  const rules = connections.rules.map((r) => ({ ...r, line: undefined }));
  const anchored = new Set<string>();
  for (const c of connections.connections)
    for (const a of [...(c.send ?? []), ...(c.receive ?? [])]) anchored.add(a.file);
  return JSON.stringify([rules, [...anchored].sort()]);
}

const SLICE = 20;
const WORD = /\w/;
const QUANTIFIER = /[*?{]/;

const nameOf = (m: Matcher): string =>
  'call' in m
    ? m.call
    : 'case' in m
      ? m.case
      : 'test' in m
        ? m.test
        : 'assign' in m
          ? m.assign
          : m.invoke;

/** Index just past the `)` closing the group opened at `i`, honouring escapes and classes. */
function skipGroup(src: string, i: number): number {
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i]!;
    if (c === '\\') i++;
    else if (c === '[') i = skipClass(src, i) - 1;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i + 1;
  }
  return src.length;
}

/** Index just past the `]` closing the class opened at `i`. */
function skipClass(src: string, i: number): number {
  for (i++; i < src.length; i++) {
    if (src[i] === '\\') i++;
    else if (src[i] === ']') return i + 1;
  }
  return src.length;
}

/** Splits at top-level `|`; null when the expression is too odd to reason about. */
function branches(src: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === '\\') i++;
    else if (c === '[') i = skipClass(src, i) - 1;
    else if (c === '(') i = skipGroup(src, i) - 1;
    else if (c === '|') {
      out.push(src.slice(start, i));
      start = i + 1;
    }
  }
  out.push(src.slice(start));
  return out;
}

/** Longest run of three or more word characters that every match of the branch must contain. */
function requiredRun(branch: string): string | undefined {
  let best = '';
  let run = '';
  const end = () => {
    if (run.length > best.length) best = run;
    run = '';
  };
  for (let i = 0; i < branch.length; i++) {
    const c = branch[i]!;
    if (WORD.test(c)) {
      // A following *, ? or {n} makes this character optional: it ends the run, unused.
      if (QUANTIFIER.test(branch[i + 1] ?? '')) end();
      else run += c;
      continue;
    }
    end();
    if (c === '\\') i++;
    else if (c === '[') i = skipClass(branch, i) - 1;
    else if (c === '(') i = skipGroup(branch, i) - 1;
  }
  end();
  return best.length >= 3 ? best : undefined;
}

/**
 * Literal text that any string matching the regular expression `src` must contain, one fragment per
 * top-level alternative; a file lacking all of them cannot contain a match. Null when some
 * alternative has no certain fragment, so every file must be scanned.
 */
export function literalFragments(src: string): string[] | null {
  const out: string[] = [];
  for (const b of branches(src)) {
    const run = requiredRun(b);
    if (run === undefined) return null;
    out.push(run);
  }
  return out;
}

/** Fragments of every matcher name; null when any rule name has none. */
function ruleFragments(connections: Connections): string[] | null {
  const all: string[] = [];
  for (const rule of connections.rules) {
    for (const m of [...rule.send, ...(rule.receive ?? [])]) {
      if (!compileName(nameOf(m))) continue;
      const f = literalFragments(nameOf(m));
      if (f === null) return null;
      all.push(...f);
    }
  }
  return all;
}

interface Source {
  paths: string[];
  /** Cache key material; undefined disables caching for the path. */
  stamp(path: string): { mtimeMs: number; size: number } | undefined;
  read(path: string): string | undefined;
}

/**
 * The two-pass scan, written once. Pass 1 parses files whose text contains a rule-name fragment;
 * pass 2 adds files defining a handler pass 1 found and files named by a connection anchor.
 * Yields after every file whose text was read.
 */
function* run(
  source: Source,
  connections: Connections,
  resolver: Resolver,
  cache: ScanCache | undefined,
): Generator<void, Map<string, FileScan>> {
  const result = new Map<string, FileScan>();
  if (connections.rules.length === 0) return result;
  const rules = connections.rules;
  const fragments = ruleFragments(connections);
  const present = new Set(source.paths);
  if (cache) {
    const key = rulesKeyOf(connections);
    if (cache.rulesKey !== key) {
      cache.files.clear();
      cache.rulesKey = key;
    }
    for (const p of cache.files.keys()) if (!present.has(p)) cache.files.delete(p);
  }

  const remember = (path: string, scan: FileScan | null) => {
    const stamp = source.stamp(path);
    if (cache && stamp) cache.files.set(path, { ...stamp, scan });
  };
  const cached = (path: string) => {
    const hit = cache?.files.get(path);
    const stamp = hit && source.stamp(path);
    return hit && stamp && hit.mtimeMs === stamp.mtimeMs && hit.size === stamp.size
      ? hit
      : undefined;
  };

  const handlers = new Set<string>();
  const addHandlers = (scan: FileScan) => {
    for (const s of scan.sites) if (s.handler) handlers.add(s.handler);
  };
  const rejected: string[] = [];

  for (const path of source.paths) {
    const hit = cached(path);
    if (hit) {
      if (hit.scan) {
        result.set(path, hit.scan);
        addHandlers(hit.scan);
      } else rejected.push(path);
      continue;
    }
    const text = source.read(path);
    yield;
    if (text === undefined) continue;
    if (fragments === null || fragments.some((f) => text.includes(f))) {
      const scan = resolver.scan(path, text, rules);
      result.set(path, scan);
      addHandlers(scan);
      remember(path, scan);
    } else {
      rejected.push(path);
      remember(path, null);
    }
  }

  const anchored = new Set<string>();
  for (const c of connections.connections)
    for (const a of [...(c.send ?? []), ...(c.receive ?? [])]) anchored.add(a.file);

  for (const path of rejected) {
    if (!anchored.has(path) && handlers.size === 0) continue;
    const text = source.read(path);
    yield;
    if (text === undefined) continue;
    if (anchored.has(path) || [...handlers].some((h) => text.includes(h))) {
      const scan = resolver.scan(path, text, rules);
      result.set(path, scan);
      remember(path, scan);
    }
  }
  return result;
}

/** Pure: scans the given sources. Files the prefilter rejects are absent from the map. */
export function scanSources(
  sources: Iterable<SourceText>,
  connections: Connections,
  resolver: Resolver,
): Map<string, FileScan> {
  const texts = new Map<string, string>();
  for (const s of sources) texts.set(s.path, s.text);
  return drain(
    run(
      { paths: [...texts.keys()], stamp: () => undefined, read: (p) => texts.get(p) },
      connections,
      resolver,
      undefined,
    ),
  );
}

function rootSource(root: string, paths: string[]): Source {
  return {
    paths,
    stamp(path) {
      try {
        const st = statSync(join(root, path));
        return st.isFile() ? { mtimeMs: st.mtimeMs, size: st.size } : undefined;
      } catch {
        return undefined;
      }
    },
    read(path) {
      try {
        return readFileSync(join(root, path), 'utf8');
      } catch {
        return undefined;
      }
    },
  };
}

function drain<T>(gen: Generator<void, T>): T {
  for (;;) {
    const r = gen.next();
    if (r.done) return r.value;
  }
}

export function scanRoot(
  root: string,
  connections: Connections,
  resolver: Resolver,
  cache?: ScanCache,
): Map<string, FileScan> {
  if (connections.rules.length === 0) return new Map();
  return drain(run(rootSource(root, listSourceFiles(root)), connections, resolver, cache));
}

/** Same result as scanRoot; awaits `pause()` after every 20 files read. */
export async function scanRootSliced(
  root: string,
  connections: Connections,
  resolver: Resolver,
  cache: ScanCache | undefined,
  pause: () => Promise<void>,
): Promise<Map<string, FileScan>> {
  if (connections.rules.length === 0) return new Map();
  const gen = run(rootSource(root, listSourceFiles(root)), connections, resolver, cache);
  let n = 0;
  for (;;) {
    const r = gen.next();
    if (r.done) return r.value;
    if (++n % SLICE === 0) await pause();
  }
}
