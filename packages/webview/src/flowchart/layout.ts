import ELK, { type ElkExtendedEdge, type ElkNode } from 'elkjs/lib/elk.bundled.js';
import type { Flow, Group, GroupTree, Projection, VisibleEdge } from '@flowbook/core';
import { textWidth, truncate } from '../measure';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type LaidOutItem =
  | ({ kind: 'node'; id: string } & Box)
  | ({ kind: 'group'; id: string; group: Group } & Box)
  | ({ kind: 'collapsed'; id: string; group: Group; nodeCount: number; hiddenSteps: number } & Box);

export interface LaidOutEdge {
  edge: VisibleEdge;
  points: { x: number; y: number }[];
  label?: Box & { text: string };
}

export interface Layout {
  items: LaidOutItem[];
  edges: LaidOutEdge[];
}

const elk = new ELK();

const NODE_PAD_X = 24;
const NODE_MIN = 120;
const NODE_MAX = 260;
export const SYMBOL_CHARS = 34;
export const LABEL_CHARS = 42;
const GROUP_HEADER = 30;

export function edgeLabel(e: VisibleEdge): string {
  const first = e.seqs[0]!;
  const last = e.seqs[e.seqs.length - 1]!;
  const seq = first === last ? `${first}` : `${first}–${last}`;
  const guard = e.guard ? `[${e.guard}] ` : '';
  return truncate(`${seq}  ${guard}${e.label}`, LABEL_CHARS);
}

function nodeSize(title: string, subtitle: string | undefined) {
  const w = Math.max(
    textWidth(title, 13, { bold: true }),
    subtitle ? textWidth(truncate(subtitle, SYMBOL_CHARS), 11, { mono: true }) : 0,
  );
  return {
    width: Math.round(Math.min(NODE_MAX, Math.max(NODE_MIN, w + NODE_PAD_X))),
    height: subtitle ? 50 : 34,
  };
}

/** Counts nodes inside a group, including nested groups. */
function countNodes(tree: GroupTree, id: string): number {
  const g = tree.groups.get(id)!;
  return g.nodes.length + g.children.reduce((n, c) => n + countNodes(tree, c), 0);
}

/**
 * Lays out the visible graph with ELK: expanded groups become compound nodes, collapsed groups
 * leaf nodes. Model order follows the flow's step order so the scenario reads left to right.
 */
export async function layoutFlow(
  flow: Flow,
  tree: GroupTree,
  projection: Projection,
  collapsed: ReadonlySet<string>,
): Promise<Layout> {
  // Order nodes by first appearance in the scenario.
  const order = new Map<string, number>();
  const visit = (id: string) => order.has(id) || order.set(id, order.size);
  if (flow.meta.entry) visit(flow.meta.entry);
  for (const s of [...flow.steps].sort((a, b) => a.seq - b.seq)) {
    visit(s.from);
    visit(s.to);
  }
  for (const n of flow.nodes) visit(n.id);
  const nodeById = new Map(flow.nodes.map((n) => [n.id, n]));
  const rank = (id: string): number => {
    const g = tree.groups.get(id);
    if (!g) return order.get(id) ?? 0;
    return Math.min(...g.nodes.map(rank), ...g.children.map(rank), Infinity);
  };
  const byRank = (a: string, b: string) => rank(a) - rank(b);

  const items = new Map<string, Omit<LaidOutItem, keyof Box>>();
  const leaf = (id: string): ElkNode => {
    const n = nodeById.get(id)!;
    items.set(id, { kind: 'node', id });
    return { id, ...nodeSize(n.title, n.anchor?.symbol) };
  };
  const group = (id: string): ElkNode => {
    const g = tree.groups.get(id)!;
    if (collapsed.has(id)) {
      items.set(id, {
        kind: 'collapsed',
        id,
        group: g,
        nodeCount: countNodes(tree, id),
        hiddenSteps: projection.internal.get(id)?.length ?? 0,
      });
      return { id, ...nodeSize(g.label, `${countNodes(tree, id)} nodes`) };
    }
    items.set(id, { kind: 'group', id, group: g });
    const headerWidth = textWidth(g.label, 12, { bold: true }) + 40;
    return {
      id,
      layoutOptions: {
        'elk.padding': `[top=${GROUP_HEADER},left=12,bottom=12,right=12]`,
        'elk.nodeSize.constraints': 'MINIMUM_SIZE',
        'elk.nodeSize.minimum': `(${headerWidth}, 40)`,
      },
      children: [...g.children, ...g.nodes].sort(byRank).map((c) => (tree.groups.has(c) ? group(c) : leaf(c))),
    };
  };

  const top = [
    ...tree.roots,
    ...flow.nodes.filter((n) => !tree.groupOf.has(n.id)).map((n) => n.id),
  ].sort(byRank);

  const edges: ElkExtendedEdge[] = projection.edges.map((e) => {
    const text = edgeLabel(e);
    return {
      id: e.id,
      sources: [e.from],
      targets: [e.to],
      labels: [{ id: `${e.id}:label`, text, width: textWidth(text, 11) + 12, height: 18 }],
    };
  });

  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': flow.meta.layout?.direction === 'TB' ? 'DOWN' : 'RIGHT',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.cycleBreaking.strategy': 'MODEL_ORDER',
      'elk.layered.spacing.nodeNodeBetweenLayers': '70',
      'elk.layered.spacing.edgeNodeBetweenLayers': '20',
      'elk.spacing.nodeNode': '28',
      'elk.spacing.edgeEdge': '14',
      'elk.spacing.edgeLabel': '4',
      'elk.edgeLabels.placement': 'CENTER',
      'elk.json.edgeCoords': 'ROOT',
      'elk.json.shapeCoords': 'ROOT',
    },
    children: top.map((id) => (tree.groups.has(id) ? group(id) : leaf(id))),
    edges,
  };

  const result = await elk.layout(graph);

  const laidOut: LaidOutItem[] = [];
  const collect = (n: ElkNode) => {
    const item = items.get(n.id);
    if (item) {
      laidOut.push({ ...item, x: n.x ?? 0, y: n.y ?? 0, width: n.width ?? 0, height: n.height ?? 0 } as LaidOutItem);
    }
    for (const c of n.children ?? []) collect(c);
  };
  collect(result);

  const edgeById = new Map(projection.edges.map((e) => [e.id, e]));
  const laidOutEdges: LaidOutEdge[] = [];
  const collectEdges = (n: ElkNode) => {
    for (const e of (n.edges ?? []) as ElkExtendedEdge[]) {
      const section = e.sections?.[0];
      const edge = edgeById.get(e.id);
      if (!section || !edge) continue;
      const label = e.labels?.[0];
      laidOutEdges.push({
        edge,
        points: [section.startPoint, ...(section.bendPoints ?? []), section.endPoint],
        label: label && {
          x: label.x ?? 0,
          y: label.y ?? 0,
          width: label.width ?? 0,
          height: label.height ?? 0,
          text: label.text ?? '',
        },
      });
    }
    for (const c of n.children ?? []) collectEdges(c);
  };
  collectEdges(result);

  return { items: laidOut, edges: laidOutEdges };
}
