import {
  MACHINES_FILE,
  type Connections,
  type Diagnostic,
  type Located,
  type MachineRecord,
  type ScopeRecord,
} from '@flowbook/core';
import type { TransitionSite } from './machines.js';
import type { ConnectionIndex, Pairing, Target } from './pairing.js';
import { match } from './resolver.js';
import type { FileScan } from './sites.js';
import type { SymbolInfo } from './symbols.js';

export type Via = 'case' | 'scope' | 'caller' | 'table' | 'none';

export interface Transition {
  /** Source state, or '*' when unknown. */
  from: string;
  to: string;
  event?: string;
  via: Via;
  guard?: string;
  label?: string;
  /** The set site, or the table row. 0-based. */
  site: Target;
  /** Table rows: the definition of the `action` function. */
  action?: Target;
  /** Pairings whose send site lies in the region (rows: in the action function). */
  triggers: Pairing[];
}

export interface MachineView {
  id: string;
  title: string;
  context?: string;
  /** Case labels and every source and target seen, without '*', sorted. */
  states: string[];
  /** Longest common prefix of `states` ending at a `_`; dropped for display. */
  prefix: string;
  /** In file, line and column order. */
  transitions: Transition[];
}

export interface MachineIndex {
  machines: MachineView[];
  /** File MACHINES_FILE, 1-based line of the record. */
  diagnostics: Diagnostic[];
}

export interface MachineSummary {
  machine: string;
  states: number;
  transitions: number;
  /** Transitions with source '*'. */
  unknown: number;
  /** Transitions with at least one trigger. */
  setsOff: number;
  via: Record<Via, number>;
}

interface Definition {
  file: string;
  info: SymbolInfo;
}

type Report = (
  record: Located<{ id: string }>,
  message: string,
  severity?: Diagnostic['severity'],
) => void;

const leaf = (symbol: string) => symbol.slice(symbol.lastIndexOf(':') + 1);

const holds = (d: Definition, t: TransitionSite) =>
  t.file === d.file && t.symbol === d.info.symbol && t.sig === d.info.sig;

const compareTargets = (a: Target, b: Target) =>
  a.file !== b.file ? (a.file < b.file ? -1 : 1) : a.line - b.line || a.column - b.column;

/** Longest common prefix of `states` that ends at a `_` and leaves every name non-empty. */
export function statePrefix(states: string[]): string {
  if (states.length === 0) return '';
  let common = states[0]!;
  for (const s of states.slice(1)) {
    let i = 0;
    while (i < common.length && i < s.length && common[i] === s[i]) i++;
    common = common.slice(0, i);
  }
  const shortest = Math.min(...states.map((s) => s.length));
  let cut = common.lastIndexOf('_');
  while (cut >= 0 && cut + 1 >= shortest) cut = common.lastIndexOf('_', cut - 1);
  return cut < 0 ? '' : common.slice(0, cut + 1);
}

/** Resolved `in` anchors of a scope; reports the ones that do not resolve. */
function resolveScope(
  scope: Located<ScopeRecord>,
  scans: Map<string, FileScan>,
  report: Report,
): Definition[] {
  const out: Definition[] = [];
  for (const anchor of scope.in) {
    const scan = scans.get(anchor.file);
    const r = scan ? match(anchor, scan.symbols) : undefined;
    const text = `${anchor.file}#${anchor.symbol}${anchor.sig ?? ''}`;
    if (r?.status === 'ok') out.push({ file: anchor.file, info: r.symbol });
    else if (r?.status === 'ambiguous')
      report(
        scope,
        `${text} is overloaded; add "sig" with one of: ${r.candidates.map((c) => c.sig).join(' | ')}`,
      );
    else report(scope, `no definition for ${text}`);
  }
  return out;
}

/** Function definitions of all scans, by the last `::` segment of their symbol. */
function collectDefinitions(scans: Map<string, FileScan>): Map<string, Definition[]> {
  const out = new Map<string, Definition[]>();
  for (const [file, scan] of scans)
    for (const info of scan.symbols) {
      if (info.kind !== 'function') continue;
      const key = leaf(info.symbol);
      const list = out.get(key);
      if (list) list.push({ file, info });
      else out.set(key, [{ file, info }]);
    }
  return out;
}

const definitionTarget = (d: Definition): Target => ({
  file: d.file,
  line: d.info.nameLine,
  column: d.info.nameColumn,
  symbol: d.info.symbol,
});

function siteTarget(t: TransitionSite): Target {
  const out: Target = { file: t.file, line: t.line, column: t.column };
  if (t.symbol !== undefined) out.symbol = t.symbol;
  return out;
}

/** Pairings whose send site is in `file` between the 0-based lines, inclusive. */
const triggersIn = (index: ConnectionIndex, file: string, start: number, end: number) =>
  index.pairings.filter((p) => p.send.file === file && p.send.line >= start && p.send.line <= end);

/** Source state of a set site: case, scope, caller, else '*'. */
function sourcesOf(
  t: TransitionSite,
  scopes: { record: Located<ScopeRecord>; functions: Definition[] }[],
  scan: FileScan | undefined,
): { from: string; via: Via }[] {
  if (t.fromCases.length > 0) return t.fromCases.map((from) => ({ from, via: 'case' as const }));
  const scope = scopes.find((s) => s.functions.some((d) => holds(d, t)));
  if (scope) return [{ from: scope.record.state, via: 'scope' }];
  if (t.symbol !== undefined && scan) {
    const name = leaf(t.symbol);
    const states = new Set(
      scan.stateCalls
        .filter((c) => c.machine === t.machine && leaf(c.callee) === name)
        .map((c) => c.state),
    );
    // Called from two different state cases: ambiguous, so unknown.
    if (states.size === 1) return [{ from: [...states][0]!, via: 'caller' }];
  }
  return [{ from: '*', via: 'none' }];
}

function buildMachine(
  m: Located<MachineRecord>,
  scopes: Located<ScopeRecord>[],
  scans: Map<string, FileScan>,
  index: ConnectionIndex,
  definitions: Map<string, Definition[]>,
  report: Report,
): MachineView {
  const sites: TransitionSite[] = [];
  const labels = new Set<string>();
  for (const scan of scans.values()) {
    for (const t of scan.transitions) if (t.machine === m.id) sites.push(t);
    for (const l of scan.stateLabels) if (l.machine === m.id) labels.add(l.state);
  }

  const resolved = scopes
    .filter((s) => s.machine === m.id)
    .sort((a, b) => a.line - b.line)
    .map((record) => ({ record, functions: resolveScope(record, scans, report) }));
  for (const { record, functions } of resolved)
    for (const d of functions)
      if (!sites.some((t) => t.kind === 'set' && holds(d, t)))
        report(record, `${d.file}#${d.info.symbol} has no set site of machine "${m.id}"`);

  const fromMaps = (m.tables ?? []).map((t) => t.from);
  const fromOf = (table: string | undefined) => {
    for (const map of fromMaps)
      if (table !== undefined && Object.hasOwn(map, table)) return map[table];
    return undefined;
  };

  const transitions: Transition[] = [];
  for (const t of sites) {
    const base = { to: t.to, site: siteTarget(t) };
    const extra = (out: Transition) => {
      if (t.event !== undefined) out.event = t.event;
      if (t.guard !== undefined) out.guard = t.guard;
      if (t.label !== undefined) out.label = t.label;
      return out;
    };
    if (t.kind === 'row') {
      const from = fromOf(t.table);
      const all = t.action !== undefined ? (definitions.get(leaf(t.action)) ?? []) : [];
      const def = all.find((d) => d.file === t.file) ?? all[0];
      const triggers = def
        ? triggersIn(index, def.file, def.info.startLine, def.info.endLine)
        : triggersIn(index, t.file, t.region.startLine, t.region.endLine);
      const out = extra({
        from: from ?? '*',
        via: from !== undefined ? 'table' : 'none',
        ...base,
        triggers,
      });
      if (def) out.action = definitionTarget(def);
      transitions.push(out);
      continue;
    }
    const triggers = triggersIn(index, t.file, t.region.startLine, t.region.endLine);
    for (const { from, via } of sourcesOf(t, resolved, scans.get(t.file)))
      transitions.push(extra({ from, via, ...base, triggers }));
  }
  transitions.sort((a, b) => compareTargets(a.site, b.site));

  if (transitions.length === 0) report(m, `machine "${m.id}" has no transition`, 'warning');

  // A `from` key must name a table array the scans saw.
  const tables = new Set(sites.flatMap((t) => (t.kind === 'row' && t.table ? [t.table] : [])));
  for (const map of fromMaps)
    for (const array of Object.keys(map))
      if (!tables.has(array))
        report(m, `"from" key "${array}" matches no table of machine "${m.id}"`);

  // Typo guard: a named state that never occurs as a target or a case label.
  const known = new Set([...labels, ...sites.map((t) => t.to)]);
  for (const map of fromMaps)
    for (const [array, state] of Object.entries(map))
      if (!known.has(state))
        report(
          m,
          `"from" state "${state}" (for ${array}) is never a target or a case label`,
          'warning',
        );
  for (const { record } of resolved)
    if (!known.has(record.state))
      report(record, `scope state "${record.state}" is never a target or a case label`, 'warning');

  const states = new Set(labels);
  for (const t of transitions) {
    states.add(t.from);
    states.add(t.to);
  }
  states.delete('*');
  const sorted = [...states].sort();
  const view: MachineView = {
    id: m.id,
    title: m.title,
    states: sorted,
    prefix: statePrefix(sorted),
    transitions,
  };
  if (m.context !== undefined) view.context = m.context;
  return view;
}

/**
 * Joins transition sites to their source states and triggers, per machine, and checks the
 * machine and scope records against the scans. Record-only checks are `validateMachines`'.
 */
export function buildMachineIndex(
  connections: Connections,
  scans: Map<string, FileScan>,
  index: ConnectionIndex,
): MachineIndex {
  const diagnostics: Diagnostic[] = [];
  const report: Report = (record, message, severity = 'error') =>
    diagnostics.push({ severity, file: MACHINES_FILE, line: record.line, id: record.id, message });
  const definitions = collectDefinitions(scans);
  const scopes = connections.scopes ?? [];
  // Scopes of an unknown machine are reported by validateMachines.
  const machines = (connections.machines ?? []).map((m) =>
    buildMachine(m, scopes, scans, index, definitions, report),
  );
  // Stable: diagnostics of one record keep the order they were found in.
  diagnostics.sort((a, b) => a.line! - b.line!);
  return { machines, diagnostics };
}

/** Counts per machine, for the summary line. */
export function machineSummaries(mi: MachineIndex): MachineSummary[] {
  return mi.machines.map((m) => {
    const via: Record<Via, number> = { case: 0, scope: 0, caller: 0, table: 0, none: 0 };
    for (const t of m.transitions) via[t.via]++;
    return {
      machine: m.id,
      states: m.states.length,
      transitions: m.transitions.length,
      unknown: m.transitions.filter((t) => t.from === '*').length,
      setsOff: m.transitions.filter((t) => t.triggers.length > 0).length,
      via,
    };
  });
}
