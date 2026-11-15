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
 * file the prefilter rejected; `handlersKey` is then set once pass 2 found that the file names none
 * of those handlers, so it is not read again while the handler set is the same. `rulesKey`
 * identifies the rules the results were computed for; the scan clears `files` when it changes.
 */
export interface ScanCache {
  rulesKey?: string;
  files: Map<
    string,
    { mtimeMs: number; size: number; scan: FileScan | null; handlersKey?: string }
  >;
}

/** Called for a file the scan leaves out: too large, or its parse threw. */
export type OnSkip = (path: string, reason: string) => void;

/** Files larger than this are not scanned. */
export const MAX_SCAN_BYTES = 2 * 1024 * 1024;

export const createScanCache = (): ScanCache => ({ files: new Map() });

/** Everything the results depend on besides file contents: rule records and anchored files. */
export function rulesKeyOf(connections: Connections): string {
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

/** Index of the last character of `close` after `i`, or null when there is none. */
function upTo(src: string, i: number, close: string): number | null {
  const at = src.indexOf(close, i);
  return at < 0 ? null : at;
}

/**
 * Index of the last character of the escape starting with the `\` at `i`: its payload
 * (`\xHH`, `\uXXXX`, `\u{…}`, `\p{…}`, `\k<…>`, `\cX`, `\123`) is not literal text. Null when
 * the escape is not understood.
 */
function escapeEnd(src: string, i: number): number | null {
  const n = src[i + 1];
  if (n === undefined) return null;
  const hex = (len: number) => new RegExp(`^[0-9a-fA-F]{${len}}`).test(src.slice(i + 2));
  switch (n) {
    case 'x':
      return hex(2) ? i + 3 : i + 1;
    case 'u':
      if (src[i + 2] === '{') return upTo(src, i + 2, '}');
      return hex(4) ? i + 5 : i + 1;
    case 'p':
    case 'P':
      return src[i + 2] === '{' ? upTo(src, i + 2, '}') : i + 1;
    case 'k':
      return src[i + 2] === '<' ? upTo(src, i + 2, '>') : i + 1;
    case 'c':
      return i + 2;
  }
  if (/\d/.test(n)) {
    let j = i + 1;
    while (/\d/.test(src[j + 1] ?? '')) j++;
    return j;
  }
  return i + 1;
}

/**
 * Longest run of three or more word characters that every match of the branch must contain; null
 * when there is none or the branch uses syntax this does not understand.
 */
function requiredRun(branch: string): string | null {
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
    if (c === '\\') {
      const e = escapeEnd(branch, i);
      if (e === null) return null;
      i = e;
    } else if (c === '[') i = skipClass(branch, i) - 1;
    else if (c === '(') i = skipGroup(branch, i) - 1;
    else if (c === '{') {
      // A quantifier body {n}, {n,} or {n,m}; anything else is not understood.
      const close = upTo(branch, i, '}');
      if (close === null || !/^\d+(,\d*)?$/.test(branch.slice(i + 1, close))) return null;
      i = close;
    }
  }
  end();
  return best.length >= 3 ? best : null;
}

/**
 * Literal text that any string matching the regular expression `src` must contain, one fragment per
 * top-level alternative; a file lacking all of them cannot contain a match. Null when some
 * alternative has no certain fragment, or uses syntax this does not understand, so every file must
 * be scanned.
 */
export function literalFragments(src: string): string[] | null {
  const out: string[] = [];
  for (const b of branches(src)) {
    const run = requiredRun(b);
    if (run === null) return null;
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

interface Stamp {
  mtimeMs: number;
  size: number;
}

const sameStamp = (a: Stamp | undefined, b: Stamp | undefined) =>
  !!a && !!b && a.mtimeMs === b.mtimeMs && a.size === b.size;

interface Source {
  paths: string[];
  /** Cache key material; undefined disables caching for the path. */
  stamp(path: string): Stamp | undefined;
  read(path: string): string | undefined;
}

/**
 * The two-pass scan, written once. Pass 1 parses files whose text contains a rule-name fragment;
 * pass 2 adds files defining a handler pass 1 found and files named by a connection anchor.
 * Yields once per file visited, cache hits included. Files over `MAX_SCAN_BYTES` and files whose
 * parse throws are left out and reported to `onSkip`.
 */
function* run(
  source: Source,
  connections: Connections,
  resolver: Resolver,
  cache: ScanCache | undefined,
  onSkip: OnSkip | undefined,
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

  const cached = (path: string, stamp: Stamp | undefined) => {
    const hit = cache?.files.get(path);
    return hit && sameStamp(hit, stamp) ? hit : undefined;
  };
  /**
   * Reads a file between two stats. `stamp` is set only when both stats agree, so the text is the
   * version the stamp describes and results computed from it may be cached.
   */
  const load = (path: string, before: Stamp | undefined) => {
    const text = source.read(path);
    if (text === undefined) return undefined;
    const stamp = sameStamp(before, source.stamp(path)) ? before : undefined;
    return { text, stamp };
  };
  const remember = (path: string, stamp: Stamp | undefined, scan: FileScan | null) => {
    if (cache && stamp) cache.files.set(path, { ...stamp, scan });
  };
  const skip = (path: string, reason: string) => {
    cache?.files.delete(path);
    onSkip?.(path, reason);
  };
  const tooLarge = (path: string, size: number) => {
    if (size <= MAX_SCAN_BYTES) return false;
    skip(path, `larger than 2 MB (${(size / (1024 * 1024)).toFixed(1)} MB)`);
    return true;
  };
  const parse = (path: string, text: string): FileScan | undefined => {
    try {
      return resolver.scan(path, text, rules);
    } catch (e) {
      skip(path, `parse failed: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  };

  const handlers = new Set<string>();
  const addHandlers = (scan: FileScan) => {
    for (const s of scan.sites) if (s.handler) handlers.add(s.handler);
  };
  const rejected: string[] = [];

  for (const path of source.paths) {
    yield;
    const before = source.stamp(path);
    const hit = cached(path, before);
    if (hit) {
      if (hit.scan) {
        result.set(path, hit.scan);
        addHandlers(hit.scan);
      } else rejected.push(path);
      continue;
    }
    if (before && tooLarge(path, before.size)) continue;
    const got = load(path, before);
    if (!got || (!before && tooLarge(path, got.text.length))) continue;
    if (fragments === null || fragments.some((f) => got.text.includes(f))) {
      const scan = parse(path, got.text);
      if (!scan) continue;
      result.set(path, scan);
      addHandlers(scan);
      remember(path, got.stamp, scan);
    } else {
      rejected.push(path);
      remember(path, got.stamp, null);
    }
  }

  const anchored = new Set<string>();
  for (const c of connections.connections)
    for (const a of [...(c.send ?? []), ...(c.receive ?? [])]) anchored.add(a.file);
  const handlersKey = [...handlers].sort().join('\n');

  for (const path of rejected) {
    const isAnchored = anchored.has(path);
    if (!isAnchored && handlers.size === 0) continue;
    yield;
    const before = source.stamp(path);
    const entry = cached(path, before);
    // Already known to name none of these handlers.
    if (!isAnchored && entry?.handlersKey === handlersKey) continue;
    const got = load(path, before);
    if (!got) continue;
    if (isAnchored || [...handlers].some((h) => got.text.includes(h))) {
      const scan = parse(path, got.text);
      if (!scan) continue;
      result.set(path, scan);
      remember(path, got.stamp, scan);
    } else if (entry && sameStamp(entry, got.stamp)) {
      // Only on the entry whose prefilter result is for this same text.
      entry.handlersKey = handlersKey;
    }
  }
  return result;
}

/** Pure: scans the given sources. Files the prefilter rejects are absent from the map. */
export function scanSources(
  sources: Iterable<SourceText>,
  connections: Connections,
  resolver: Resolver,
  onSkip?: OnSkip,
): Map<string, FileScan> {
  const texts = new Map<string, string>();
  for (const s of sources) texts.set(s.path, s.text);
  return drain(
    run(
      { paths: [...texts.keys()], stamp: () => undefined, read: (p) => texts.get(p) },
      connections,
      resolver,
      undefined,
      onSkip,
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
  onSkip?: OnSkip,
): Map<string, FileScan> {
  if (connections.rules.length === 0) return new Map();
  return drain(run(rootSource(root, listSourceFiles(root)), connections, resolver, cache, onSkip));
}

/**
 * Same result as scanRoot; awaits `pause()` after every 20 files visited (cache hits count).
 * Listing the files is not sliced.
 */
export async function scanRootSliced(
  root: string,
  connections: Connections,
  resolver: Resolver,
  cache: ScanCache | undefined,
  pause: () => Promise<void>,
  onSkip?: OnSkip,
): Promise<Map<string, FileScan>> {
  if (connections.rules.length === 0) return new Map();
  const gen = run(rootSource(root, listSourceFiles(root)), connections, resolver, cache, onSkip);
  let n = 0;
  for (;;) {
    const r = gen.next();
    if (r.done) return r.value;
    if (++n % SLICE === 0) await pause();
  }
}
