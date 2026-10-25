import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve as resolvePath } from 'node:path';
import type { Anchor } from '@flowbook/core';
import {
  anchorDiagnostics,
  checkAnchors,
  headCommit,
  readWorkspace,
  sourceReader,
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
  const diagnostics = sortDiagnostics([
    ...ws.diagnostics,
    ...anchorDiagnostics(statuses, opts.strict),
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
  const file = relative(ctx.root, resolvePath(fileArg)).split('\\').join('/');
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
  const sha = headCommit(ctx.root);
  const statuses = checkAnchors(ws, sourceReader(ctx.root), ctx.resolver).filter((s) =>
    wanted.has(s.flow.meta.id),
  );
  let failed = 0;
  for (const flow of ws.flows.filter((f) => wanted.has(f.meta.id))) {
    const mine = statuses.filter((s) => s.flow === flow);
    const updates = new Map<number, string>();
    for (const s of mine) {
      if (s.state === 'fresh' || s.state === 'stale' || s.state === 'unstamped') {
        updates.set(s.node.line, s.symbol.fp);
      }
    }
    for (const d of anchorDiagnostics(mine.filter((s) => !updates.has(s.node.line)))) {
      ctx.io.err(formatDiagnostic(d, ctx.root));
      failed++;
    }
    const path = join(ctx.root, flow.file);
    const lines = readFileSync(path, 'utf8').split('\n');
    let changed = 0;
    for (const [lineNo, fp] of updates) {
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
  if (!sha) ctx.io.err('warning: not a git repository; "verified" commits were not recorded');
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
