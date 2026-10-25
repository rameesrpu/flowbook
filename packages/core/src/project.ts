import { ancestorsOf, type GroupTree } from './grouping.js';
import type { Flow } from './parse.js';
import type { StepType } from './schema.js';

export interface VisibleEdge {
  id: string;
  /** Visible endpoint ids: a node id, or a group id when the node is inside a collapsed group. */
  from: string;
  to: string;
  steps: string[];
  seqs: number[];
  /** True when the edge stands for steps that touch a collapsed group. */
  aggregated: boolean;
  /** The step's label, or a summary like "3 steps" for aggregated edges. */
  label: string;
  type: StepType;
  guard?: string;
}

export interface Projection {
  /** Visible id for every node in the flow. */
  visibleOf: Map<string, string>;
  edges: VisibleEdge[];
  /** Steps hidden because both ends fall inside the same collapsed group. */
  internal: Map<string, string[]>;
}

/**
 * Maps a flow onto the groups that are currently collapsed. A node inside a collapsed group is
 * represented by its outermost collapsed ancestor; steps between the same pair of visible ends
 * are merged when either end is a collapsed group.
 */
export function project(flow: Flow, tree: GroupTree, collapsed: ReadonlySet<string>): Projection {
  const visibleOf = new Map<string, string>();
  for (const n of flow.nodes) {
    const outer = ancestorsOf(tree, n.id).find((g) => collapsed.has(g));
    visibleOf.set(n.id, outer ?? n.id);
  }

  const edges: VisibleEdge[] = [];
  const merged = new Map<string, VisibleEdge>();
  const internal = new Map<string, string[]>();
  const steps = [...flow.steps].sort((a, b) => a.seq - b.seq);
  for (const s of steps) {
    const from = visibleOf.get(s.from) ?? s.from;
    const to = visibleOf.get(s.to) ?? s.to;
    const aggregated = from !== s.from || to !== s.to;
    if (!aggregated) {
      edges.push({
        id: s.id,
        from,
        to,
        steps: [s.id],
        seqs: [s.seq],
        aggregated: false,
        label: s.label,
        type: s.type,
        guard: s.guard,
      });
      continue;
    }
    if (from === to) {
      internal.set(from, [...(internal.get(from) ?? []), s.id]);
      continue;
    }
    const key = `${from}\u0000${to}`;
    const existing = merged.get(key);
    if (existing) {
      existing.steps.push(s.id);
      existing.seqs.push(s.seq);
      existing.label = `${existing.steps.length} steps`;
      if (existing.type !== s.type) existing.type = 'call';
      existing.guard = undefined;
    } else {
      const edge: VisibleEdge = {
        id: `agg:${from}->${to}`,
        from,
        to,
        steps: [s.id],
        seqs: [s.seq],
        aggregated: true,
        label: s.label,
        type: s.type,
        guard: s.guard,
      };
      merged.set(key, edge);
      edges.push(edge);
    }
  }
  return { visibleOf, edges, internal };
}
