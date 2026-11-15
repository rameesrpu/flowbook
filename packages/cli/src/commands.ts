import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve as resolvePath } from 'node:path';
import type { Anchor } from '@flowbook/core';
import {
  anchorDiagnostics,
  buildConnectionIndex,
  checkAnchors,
  headCommitFor,
  readWorkspace,
  ruleSummaries,
  scanRoot,
  sourceReader,
  type ConnectionIndex,
  type Pairing,
  type Site,
  type Resolver,
  type SymbolInfo,
} from '@flowbook/resolver';
import { displayPath, formatDiagnostic, sortDiagnostics, type Io } from './io.js';

export interface Context {
  root: string;
  resolver: Resolver;
  io: Io;
}

export function check(ctx: Context, opts: { strict?: boolean; json?: boolean } = {}): number {
  const ws = readWorkspace(ctx.root);
  const statuses = checkAnchors(ws, sourceReader(ctx.root), ctx.resolver);
  const index =
    ws.connections.rules.length > 0
      ? buildConnectionIndex(ws.connections, scanRoot(ctx.root, ws.connections, ctx.resolver))
      : undefined;
  const diagnostics = sortDiagnostics([
    ...ws.diagnostics,
    ...anchorDiagnostics(statuses, opts.strict),
    ...(index?.diagnostics ?? []),
  ]);
  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  if (opts.json) {
    ctx.io.out(JSON.stringify({ errors, diagnostics }, null, 2));
  } else {
    for (const d of diagnostics) ctx.io.out(formatDiagnostic(d, ctx.root));
    const count = (s: string) => statuses.filter((x) => x.state === s).length;
    const nodes = ws.flows.reduce((n, f) => n + f.nodes.length, 0);
    ctx.io.out(
      `${ws.flows.length} flows, ${nodes} nodes: ${errors} errors, ` +
        `${diagnostics.length - errors} warnings (${count('stale')} stale, ${count('unstamped')} unstamped)`,
    );
  }
  return errors > 0 ? 1 : 0;
}

/** The anchor an agent should write for a symbol; `sig` only when the name is overloaded. */
function anchorFor(file: string, sym: SymbolInfo, all: SymbolInfo[]): Anchor {
  const overloaded = all.filter((s) => s.symbol === sym.symbol).length > 1;
  return overloaded ? { file, symbol: sym.symbol, sig: sym.sig } : { file, symbol: sym.symbol };
}

export function resolve(
  ctx: Context,
  fileArg: string,
  symbol: string | undefined,
  sig: string | undefined,
): number {
  // Accept paths relative to the current directory or to the root.
  const fromCwd = resolvePath(fileArg);
  const absolute = existsSync(fromCwd) ? fromCwd : resolvePath(ctx.root, fileArg);
  const file = relative(ctx.root, absolute).split('\\').join('/');
  let text: string;
  try {
    text = readFileSync(join(ctx.root, file), 'utf8');
  } catch {
    ctx.io.err(`error: cannot read ${file}`);
    return 1;
  }
  const all = ctx.resolver.listSymbols(file, text);
  const line = (s: SymbolInfo) =>
    `${String(s.nameLine + 1).padStart(5)}  ${s.kind.padEnd(8)}  ${JSON.stringify(anchorFor(file, s, all))}`;
  if (symbol === undefined) {
    for (const s of all) ctx.io.out(line(s));
    return 0;
  }
  const r = ctx.resolver.match({ file, symbol, sig }, all);
  if (r.status === 'ok') {
    ctx.io.out(JSON.stringify(anchorFor(file, r.symbol, all)));
    ctx.io.out(`line ${r.symbol.nameLine + 1}, fp ${r.symbol.fp}`);
    return 0;
  }
  if (r.status === 'ambiguous') {
    ctx.io.err(`error: ${symbol} is overloaded; pick one:`);
    for (const s of r.candidates) ctx.io.err(line(s));
  } else {
    ctx.io.err(`error: no definition of ${symbol}${sig ?? ''} in ${file}`);
    for (const s of r.suggestions) ctx.io.err(`did you mean: ${line(s).trim()}`);
  }
  return 1;
}

/**
 * Records the current fingerprint and HEAD commit on every resolvable node of the given flows.
 * Only node lines are rewritten; everything else in the file is left byte-for-byte unchanged.
 */
export function stamp(ctx: Context, flowIds: string[], all = false): number {
  const ws = readWorkspace(ctx.root);
  const known = new Set(ws.flows.map((f) => f.meta.id));
  const unknown = flowIds.filter((id) => !known.has(id));
  if (unknown.length) {
    ctx.io.err(`error: unknown flow(s): ${unknown.join(', ')}`);
    return 1;
  }
  if (!all && flowIds.length === 0) {
    ctx.io.err('error: name the flows to stamp, or pass --all');
    return 1;
  }
  const wanted = new Set(all ? known : flowIds);
  const commits = new Map<string, string | undefined>();
  const commitFor = (file: string) => {
    if (!commits.has(file)) commits.set(file, headCommitFor(ctx.root, file));
    return commits.get(file);
  };
  let outsideGit = false;
  const statuses = checkAnchors(ws, sourceReader(ctx.root), ctx.resolver).filter((s) =>
    wanted.has(s.flow.meta.id),
  );
  let failed = 0;
  for (const flow of ws.flows.filter((f) => wanted.has(f.meta.id))) {
    const mine = statuses.filter((s) => s.flow === flow);
    const updates = new Map<number, { fp: string; sha?: string }>();
    for (const s of mine) {
      if (s.state === 'fresh' || s.state === 'stale' || s.state === 'unstamped') {
        const sha = commitFor(s.node.anchor!.file);
        if (!sha) outsideGit = true;
        updates.set(s.node.line, { fp: s.symbol.fp, sha });
      }
    }
    for (const d of anchorDiagnostics(mine.filter((s) => !updates.has(s.node.line)))) {
      ctx.io.err(formatDiagnostic(d, ctx.root));
      failed++;
    }
    const path = join(ctx.root, flow.file);
    const lines = readFileSync(path, 'utf8').split('\n');
    let changed = 0;
    for (const [lineNo, { fp, sha }] of updates) {
      const record = JSON.parse(lines[lineNo - 1]!) as Record<string, unknown>;
      if (record.fp === fp && (sha === undefined || record.verified === sha)) continue;
      record.fp = fp;
      if (sha) record.verified = sha;
      else delete record.verified;
      lines[lineNo - 1] = JSON.stringify(record);
      changed++;
    }
    if (changed) writeFileSync(path, lines.join('\n'));
    ctx.io.out(`${flow.meta.id}: stamped ${updates.size} nodes (${changed} updated)`);
  }
  if (outsideGit) {
    ctx.io.err(
      'warning: some sources are not in a git repository; their "verified" commits were not recorded',
    );
  }
  return failed > 0 ? 1 : 0;
}

/** Lists nodes whose code changed or can no longer be found — an agent's update to-do list. */
export function stale(ctx: Context, opts: { json?: boolean } = {}): number {
  const ws = readWorkspace(ctx.root);
  const statuses = checkAnchors(ws, sourceReader(ctx.root), ctx.resolver).filter(
    (s) => s.state !== 'fresh' && s.state !== 'unstamped',
  );
  const rows = statuses.map((s) => ({
    flow: s.flow.meta.id,
    node: s.node.id,
    state: s.state,
    anchor: s.node.anchor!,
    verified: s.node.verified,
    file: s.flow.file,
    line: s.node.line,
  }));
  if (opts.json) ctx.io.out(JSON.stringify(rows, null, 2));
  else if (rows.length === 0) ctx.io.out('all anchored nodes are fresh');
  else {
    for (const r of rows) {
      const since = r.verified ? ` (verified at ${r.verified.slice(0, 7)})` : '';
      ctx.io.out(
        `${displayPath(ctx.root, r.file)}:${r.line}: ${r.state}: ${r.flow}/${r.node} → ${r.anchor.file}#${r.anchor.symbol}${since}`,
      );
    }
  }
  return rows.length > 0 ? 1 : 0;
}

const samePlace = (a: { file: string; line: number; column: number }, b: typeof a) =>
  a.file === b.file && a.line === b.line && a.column === b.column;

const spot = (t: { file: string; line: number; symbol?: string }) =>
  t.symbol ?? `${t.file}:${t.line + 1}`;

/** Pairings whose reactors include this receive site itself (by key or anchor). */
const sendersOfSite = (index: ConnectionIndex, site: Site) =>
  index.pairings.filter((p) =>
    p.reactors.some((r) => r.via !== 'handler' && r.via !== 'registered' && samePlace(r, site)),
  );

function reactorText(index: ConnectionIndex, p: Pairing): string {
  return p.reactors
    .map((r) => {
      const at = index.sites.find((s) => s.role === 'receive' && samePlace(s, r));
      const how = r.via === 'key' && r.key !== undefined && at ? ` (${at.matcher} ${r.key})` : '';
      return `${spot(r)}${how}${r.confirmed ? '' : ' ?'}`;
    })
    .join(', ');
}

function siteLine(index: ConnectionIndex, site: Site, unpaired: boolean): string {
  const what = `${site.rule} ${site.role} ${site.key ?? site.handler ?? ''}`.trimEnd();
  const head = `${site.file}:${site.line + 1}: ${what}`;
  if (site.role === 'send') {
    const p = index.pairings.find((x) => x.send === site)!;
    return `${head} → ${p.reactors.length ? reactorText(index, p) : 'unpaired'}`;
  }
  if (unpaired) return `${head} → unpaired`;
  const n = sendersOfSite(index, site).length;
  return `${head} ← ${n} sender${n === 1 ? '' : 's'}`;
}

/** Lists every connection site with what it pairs to, then one summary line per rule. */
export function sites(
  ctx: Context,
  opts: { rule?: string; unpaired?: boolean; json?: boolean } = {},
): number {
  const ws = readWorkspace(ctx.root);
  const { rules } = ws.connections;
  if (opts.rule !== undefined && !rules.some((r) => r.id === opts.rule)) {
    ctx.io.err(`error: unknown rule "${opts.rule}"; known: ${rules.map((r) => r.id).join(', ')}`);
    return 1;
  }
  const index = buildConnectionIndex(
    ws.connections,
    scanRoot(ctx.root, ws.connections, ctx.resolver),
  );
  const silent = new Set(index.unpairedReceives);
  const isUnpaired = (s: Site) =>
    s.role === 'send'
      ? index.pairings.find((p) => p.send === s)!.reactors.length === 0
      : silent.has(s);
  const shown = index.sites.filter(
    (s) => (opts.rule === undefined || s.rule === opts.rule) && (!opts.unpaired || isUnpaired(s)),
  );
  const summaries = ruleSummaries(index, ws.connections).filter(
    (r) => opts.rule === undefined || r.rule === opts.rule,
  );
  if (opts.json) {
    const rows = shown.map((s) => {
      const row = {
        file: s.file,
        line: s.line + 1,
        rule: s.rule,
        role: s.role,
        key: s.key,
        handler: s.handler,
        symbol: s.symbol,
      };
      if (s.role === 'send') {
        const p = index.pairings.find((x) => x.send === s)!;
        return { ...row, reactors: p.reactors.map((r) => ({ ...r, line: r.line + 1 })) };
      }
      return {
        ...row,
        senders: sendersOfSite(index, s).map((p) => ({ file: p.send.file, line: p.send.line + 1 })),
      };
    });
    ctx.io.out(JSON.stringify({ sites: rows, rules: summaries }, null, 2));
    return 0;
  }
  for (const s of shown) ctx.io.out(siteLine(index, s, silent.has(s)));
  for (const r of summaries) {
    ctx.io.out(
      `${r.rule}: ${r.send} send, ${r.receive} receive, ${r.paired} ${r.keyed ? 'keys' : 'sends'} paired ` +
        `(${r.confirmed} confirmed), ${r.unpaired} unpaired`,
    );
  }
  return 0;
}
