/**
 * Lens text and peek targets for state-machine transitions (spec: Extension, lenses only). Pure
 * with respect to `vscode` so it can be unit-tested against the fixture.
 */
import type { Connections } from '@flowbook/core';
import {
  buildConnectionIndex,
  buildMachineIndex,
  type ConnectionIndex,
  type FileScan,
  type MachineIndex,
  type MachineView,
  type Site,
  type Target,
  type Transition,
} from '@flowbook/resolver';
import { reactorTargets } from './connections-model.js';

export interface MachineLens {
  line: number; // 0-based
  title: string;
  /** The triggered reactors, peeked like `Go to Reactor`'s; empty when nothing is set off. */
  targets: Target[];
}

/** The reactor's enclosing function, or `file.c:line` (1-based) at file scope. */
const spot = (t: Target) =>
  t.symbol ?? `${t.file.slice(t.file.lastIndexOf('/') + 1)}:${t.line + 1}`;

/**
 * `↳ <title>: [label ]FROM[, FROM…] → TO on EVENT|in FUNCTION[ if GUARD][ · sets off RULE →
 * REACTOR (+N more)]`, worded like `flowbook states`; `froms` (default `t.from`) are the sources
 * of the transitions one lens joins. State names drop the machine's prefix; an unknown source
 * reads `any state`.
 */
export function transitionLensTitle(m: MachineView, t: Transition, froms = [t.from]): string {
  const short = (s: string) =>
    s === '*' ? 'any state' : s.startsWith(m.prefix) ? s.slice(m.prefix.length) : s;
  const label = t.label !== undefined ? `${t.label} ` : '';
  let title = `↳ ${m.title}: ${label}${froms.map(short).join(', ')} → ${short(t.to)}`;
  if (t.event !== undefined) title += ` on ${t.event}`;
  else if (t.site.symbol !== undefined) title += ` in ${t.site.symbol}`;
  if (t.guard !== undefined) title += ` if ${t.guard}`;
  const first = t.triggers[0];
  if (first) {
    const r = first.reactors[0];
    const more = t.triggers.length > 1 ? ` (+${t.triggers.length - 1} more)` : '';
    title += ` · sets off ${first.send.rule} → ${r ? spot(r) : 'unpaired'}${more}`;
  }
  return title;
}

/**
 * One lens per transition whose site (set call or table row) is in `rel`, in line order;
 * transitions with the same site, target, event, guard and label share one lens that lists
 * their sources. `sites` are the connection index's sites, used to pick the shown reactors as
 * `Go to Reactor` does.
 */
export function machineLenses(mi: MachineIndex, rel: string, sites: Site[] = []): MachineLens[] {
  const out: MachineLens[] = [];
  for (const m of mi.machines) {
    const groups = new Map<string, { t: Transition; froms: string[] }>();
    for (const t of m.transitions) {
      if (t.site.file !== rel) continue;
      const key = JSON.stringify([
        t.site.line,
        t.site.column,
        t.to,
        t.event ?? null,
        t.guard ?? null,
        t.label ?? null,
      ]);
      const g = groups.get(key);
      if (!g) groups.set(key, { t, froms: [t.from] });
      else if (!g.froms.includes(t.from)) g.froms.push(t.from);
    }
    for (const { t, froms } of groups.values())
      out.push({
        line: t.site.line,
        title: transitionLensTitle(m, t, froms),
        targets: reactorTargets(t.triggers, sites),
      });
  }
  return out.sort((a, b) => a.line - b.line);
}

/**
 * The machine index for a document with unsaved edits: `docScan` (scanned with the machines)
 * stands in for the saved scan of `rel`. `index` is the document's connection index
 * (`documentIndex`), built when not given.
 */
export function documentMachineIndex(
  connections: Connections,
  scans: Map<string, FileScan>,
  rel: string,
  docScan: FileScan,
  index?: ConnectionIndex,
): MachineIndex {
  const copy = new Map(scans);
  copy.set(rel, docScan);
  return buildMachineIndex(connections, copy, index ?? buildConnectionIndex(connections, copy));
}
