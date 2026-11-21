import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve as resolvePath } from 'node:path';
import { CONNECTIONS_FILE, MACHINES_FILE, type Anchor } from '@flowbook/core';
import {
  anchorDiagnostics,
  buildConnectionIndex,
  buildMachineIndex,
  checkAnchors,
  fileLister,
  machineSummaries,
  headCommitFor,
  readWorkspace,
  ruleSummaries,
  scanRoot,
  sourceReader,
  type ConnectionIndex,
  type MachineView,
  type Transition,
  type Via,
  type OnSkip,
  type Pairing,
  type Reactor,
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

/** Reports a file the connection scan left out, on stderr. */
const skipped =
  (ctx: Context): OnSkip =>
  (path, reason) =>
    ctx.io.err(`warning: skipped ${displayPath(ctx.root, path)}: ${reason}`);

export function check(ctx: Context, opts: { strict?: boolean; json?: boolean } = {}): number {
  const ws = readWorkspace(ctx.root);
  const statuses = checkAnchors(ws, sourceReader(ctx.root), ctx.resolver, fileLister(ctx.root));
  const hasMachines = (ws.connections.machines ?? []).length > 0;
  const scans =
    ws.connections.rules.length > 0 || hasMachines
      ? scanRoot(ctx.root, ws.connections, ctx.resolver, undefined, skipped(ctx))
      : undefined;
  const index = scans ? buildConnectionIndex(ws.connections, scans) : undefined;
  const machineIndex = scans && index ? buildMachineIndex(ws.connections, scans, index) : undefined;
  const diagnostics = sortDiagnostics([
    ...ws.diagnostics,
    ...anchorDiagnostics(statuses, opts.strict),
    ...(index?.diagnostics ?? []),
    ...(machineIndex?.diagnostics ?? []),
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
        `${diagnostics.length - errors} warnings (${count('stale')} stale, ${count('unstamped')} unstamped)` +
        (hasMachines && machineIndex
          ? unknownSources(machineSummaries(machineIndex).reduce((n, m) => n + m.unknown, 0))
          : ''),
    );
  }
  return errors > 0 ? 1 : 0;
}

const unknownSources = (n: number) => `, ${n} unknown source state${n === 1 ? '' : 's'}`;

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
  const statuses = checkAnchors(
    ws,
    sourceReader(ctx.root),
    ctx.resolver,
    fileLister(ctx.root),
  ).filter((s) => wanted.has(s.flow.meta.id));
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
  const statuses = checkAnchors(
    ws,
    sourceReader(ctx.root),
    ctx.resolver,
    fileLister(ctx.root),
  ).filter((s) => s.state !== 'fresh' && s.state !== 'unstamped');
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

const leaf = (symbol: string) => symbol.slice(symbol.lastIndexOf(':') + 1);

/**
 * True when the reactor is one of several definitions of one handler name: the send site's
 * handler (`p.candidates`), or a registered handler whose name has more than one definition.
 */
function isCandidate(p: Pairing, r: Reactor): boolean {
  if (r.via === 'handler') return p.candidates !== undefined;
  if (r.via !== 'registered' || r.symbol === undefined) return false;
  const name = leaf(r.symbol);
  return (
    p.reactors.filter((o) => o.via === 'registered' && leaf(o.symbol ?? '') === name).length > 1
  );
}

function reactorText(index: ConnectionIndex, p: Pairing): string {
  return p.reactors
    .map((r) => {
      const at = index.sites.find((s) => s.role === 'receive' && samePlace(s, r));
      const how = r.via === 'key' && r.key !== undefined && at ? ` (${at.matcher} ${r.key})` : '';
      const status = r.confirmed ? '' : isCandidate(p, r) ? ' (candidate)' : ' ?';
      return `${spot(r)}${how}${status}`;
    })
    .join(', ');
}

function siteLine(
  index: ConnectionIndex,
  site: Site,
  unpaired: boolean,
  pairingOf: Map<Site, Pairing>,
): string {
  const what = `${site.rule} ${site.role} ${site.key ?? site.handler ?? ''}`.trimEnd();
  const head = `${site.file}:${site.line + 1}: ${what}`;
  if (site.role === 'send') {
    const p = pairingOf.get(site)!;
    const missing = p.missingReceive ? ` · no receive site for ${site.key}` : '';
    if (p.reactors.length === 0 && site.forwards) {
      const { param, position } = site.forwards;
      return `${head} → forwards parameter ${param} (argument ${position} of ${leaf(site.symbol ?? '')})`;
    }
    return `${head} → ${p.reactors.length ? reactorText(index, p) : 'unpaired'}${missing}`;
  }
  if (unpaired) return `${head} → unpaired`;
  const n = sendersOfSite(index, site).length;
  return `${head} ← ${n} sender${n === 1 ? '' : 's'}`;
}

/**
 * Lists every connection site with what it pairs to, then one summary line per rule. Errors in
 * the connections file go to stderr first and make the exit code 1, since a rule they drop
 * finds nothing.
 */
export function sites(
  ctx: Context,
  opts: { rule?: string; unpaired?: boolean; json?: boolean } = {},
): number {
  const ws = readWorkspace(ctx.root);
  const { rules } = ws.connections;
  const ruleErrors = sortDiagnostics(
    ws.diagnostics.filter((d) => d.severity === 'error' && d.file === CONNECTIONS_FILE),
  );
  for (const d of ruleErrors) ctx.io.err(formatDiagnostic(d, ctx.root));
  const code = ruleErrors.length > 0 ? 1 : 0;
  if (opts.rule !== undefined && !rules.some((r) => r.id === opts.rule)) {
    ctx.io.err(`error: unknown rule "${opts.rule}"; known: ${rules.map((r) => r.id).join(', ')}`);
    return 1;
  }
  const index = buildConnectionIndex(
    ws.connections,
    scanRoot(ctx.root, ws.connections, ctx.resolver, undefined, skipped(ctx)),
  );
  const silent = new Set(index.unpairedReceives);
  const pairingOf = new Map(index.pairings.map((p) => [p.send, p]));
  const isUnpaired = (s: Site) => {
    if (s.role !== 'send') return silent.has(s);
    const p = pairingOf.get(s)!;
    return (p.reactors.length === 0 && !p.forwarded) || p.missingReceive === true;
  };
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
        const p = pairingOf.get(s)!;
        return {
          ...row,
          ...(s.forwards ? { forwards: s.forwards } : {}),
          ...(p.forwarded ? { forwarded: true } : {}),
          reactors: p.reactors.map((r) => ({ ...r, line: r.line + 1, column: r.column + 1 })),
          ...(p.missingReceive ? { missingReceive: true } : {}),
        };
      }
      return {
        ...row,
        senders: sendersOfSite(index, s).map((p) => ({ file: p.send.file, line: p.send.line + 1 })),
      };
    });
    ctx.io.out(JSON.stringify({ sites: rows, rules: summaries }, null, 2));
    return code;
  }
  for (const s of shown) ctx.io.out(siteLine(index, s, silent.has(s), pairingOf));
  for (const r of summaries) {
    ctx.io.out(
      `${r.rule}: ${r.send} send, ${r.receive} receive, ${r.paired} ${r.keyed ? 'keys' : 'sends'} paired ` +
        `(${r.confirmed} confirmed), ${r.unpaired} unpaired` +
        (r.missingReceive > 0 ? `, ${r.missingReceive} without receive site` : '') +
        (r.forwarding > 0 ? `, ${r.forwarding} forwarding` : ''),
    );
  }
  return code;
}

const VIA_WORDS: [Via, string][] = [
  ['case', 'from a case'],
  ['test', 'from a test'],
  ['scope', 'from a scope'],
  ['caller', 'from a caller'],
  ['table', 'from a table'],
  ['none', 'unknown'],
];

function transitionLine(m: MachineView, t: Transition): string {
  const short = (s: string) => (s !== '*' && s.startsWith(m.prefix) ? s.slice(m.prefix.length) : s);
  const label = t.label !== undefined ? `${t.label} ` : '';
  let line = `${t.site.file}:${t.site.line + 1}: ${m.id} ${label}${short(t.from)} → ${short(t.to)}`;
  if (t.event !== undefined) line += ` on ${t.event}`;
  else if (t.site.symbol !== undefined) line += ` in ${t.site.symbol}`;
  if (t.guard !== undefined) line += ` if ${t.guard}`;
  const first = t.triggers[0];
  if (first) {
    const r = first.reactors[0];
    const more = t.triggers.length > 1 ? ` (+${t.triggers.length - 1} more)` : '';
    line += ` · sets off ${first.send.rule} → ${r ? spot(r) : 'unpaired'}${more}`;
  }
  return line;
}

/**
 * Lists every state transition with its source state and what it sets off, then one summary
 * line per machine. Diagnostics of the machines file and the machine index go to stderr first;
 * errors in either make the exit code 1.
 */
export function states(
  ctx: Context,
  opts: { machine?: string; unknown?: boolean; json?: boolean } = {},
): number {
  const ws = readWorkspace(ctx.root);
  const known = ws.connections.machines ?? [];
  const fileDiagnostics = sortDiagnostics(ws.diagnostics.filter((d) => d.file === MACHINES_FILE));
  const fileErrors = fileDiagnostics.filter((d) => d.severity === 'error');
  for (const d of fileErrors) ctx.io.err(formatDiagnostic(d, ctx.root));
  if (opts.machine !== undefined && !known.some((m) => m.id === opts.machine)) {
    ctx.io.err(
      `error: unknown machine "${opts.machine}"; known: ${known.map((m) => m.id).join(', ')}`,
    );
    return 1;
  }
  const scans = scanRoot(ctx.root, ws.connections, ctx.resolver, undefined, skipped(ctx));
  const index = buildConnectionIndex(ws.connections, scans);
  const mi = buildMachineIndex(ws.connections, scans, index);
  // Like rule errors for `sites`: a record an error drops or breaks finds the wrong thing.
  const errors = fileErrors.length + mi.diagnostics.filter((d) => d.severity === 'error').length;
  const code = errors > 0 ? 1 : 0;
  const wanted = (id: string) => opts.machine === undefined || id === opts.machine;
  const machines = mi.machines.filter((m) => wanted(m.id));
  const summaries = machineSummaries(mi).filter((s) => wanted(s.machine));
  if (opts.json) {
    const view = opts.unknown
      ? machines.map((m) => ({ ...m, transitions: m.transitions.filter((t) => t.from === '*') }))
      : machines;
    const diagnostics = sortDiagnostics([...fileDiagnostics, ...mi.diagnostics]);
    ctx.io.out(JSON.stringify({ machines: view, diagnostics }, null, 2));
    return code;
  }
  for (const d of mi.diagnostics) ctx.io.err(formatDiagnostic(d, ctx.root));
  for (const m of machines)
    for (const t of m.transitions)
      if (!opts.unknown || t.from === '*') ctx.io.out(transitionLine(m, t));
  for (const s of summaries) {
    const via = VIA_WORDS.filter(([v]) => s.via[v] > 0).map(([v, w]) => `${s.via[v]} ${w}`);
    ctx.io.out(
      `${s.machine}: ${s.states} states, ${s.transitions} transitions` +
        (via.length ? ` (${via.join(', ')})` : '') +
        (s.setsOff > 0 ? `, ${s.setsOff} sets off` : ''),
    );
  }
  return code;
}
