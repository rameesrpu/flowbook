import ELK, { type ElkExtendedEdge, type ElkNode } from 'elkjs/lib/elk.bundled.js';
import {
  project,
  type Flow,
  type Group,
  type GroupTree,
  type Projection,
  type VisibleEdge,
} from '@flowbook/core/browser';
import { textWidth, truncate } from '../measure';
import { BLOCK_ICON } from '../model';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type LaidOutItem =
  | ({ kind: 'node'; id: string } & Box)
  | ({
      kind: 'group';
      id: string;
      group: Group;
      /** Single-child groups drawn inside this box's header instead of as nested boxes. */
      merged: Group[];
    } & Box)
  | ({ kind: 'collapsed'; id: string; group: Group; nodeCount: number; hiddenSteps: number } & Box);

export interface EdgeLabelParts {
  seq: string;
  guard?: string;
  text: string;
  /** Icons of the blocks (loop/alt/par) the edge's steps are in. */
  badges: string;
}

export interface LaidOutEdge {
  edge: VisibleEdge;
  points: { x: number; y: number }[];
  label?: Box & EdgeLabelParts;
}

export interface Layout {
  items: LaidOutItem[];
  edges: LaidOutEdge[];
  width: number;
  height: number;
}

type Viewport = { width: number; height: number };

/** Zoom at which a layout fits the viewport (with the padding fitView uses). */
export const fitScale = (l: { width?: number; height?: number }, viewport: Viewport) =>
  Math.min(viewport.width / ((l.width ?? 1) * 1.12), viewport.height / ((l.height ?? 1) * 1.12));

type ItemMeta = LaidOutItem extends infer T
  ? T extends unknown
    ? Omit<T, keyof Box>
    : never
  : never;

const elk = new ELK();

const NODE_PAD_X = 34;
const NODE_MIN = 120;
const NODE_MAX = 260;
export const SYMBOL_CHARS = 34;
export const LABEL_CHARS = 42;
const GROUP_HEADER = 30;
const FILE_HEADER = 24;

export function edgeLabel(e: VisibleEdge, flow: Flow): EdgeLabelParts {
  const first = e.seqs[0]!;
  const last = e.seqs[e.seqs.length - 1]!;
  const seq =
    e.seqs.length === 1 ? `${first}` : e.seqs.length <= 3 ? e.seqs.join(',') : `${first}–${last}`;
  const types = new Set(
    flow.blocks.filter((b) => b.steps.some((s) => e.steps.includes(s))).map((b) => b.type),
  );
  const badges = (['loop', 'alt', 'par'] as const)
    .filter((t) => types.has(t))
    .map((t) => BLOCK_ICON[t])
    .join('');
  const room = Math.max(8, LABEL_CHARS - (e.guard ? e.guard.length + 3 : 0));
  return { seq, guard: e.guard, text: truncate(e.label, room), badges };
}

/** Width of a rendered edge label; keep in sync with .fb-edge-label in styles.css. */
function labelWidth(p: EdgeLabelParts): number {
  let w = textWidth(p.seq, 10, { bold: true }) + 8 + textWidth(p.text, 11);
  if (p.guard) w += textWidth(`[${p.guard}]`, 11, { mono: true }) + 5;
  if (p.badges) w += textWidth(p.badges, 11) + 5;
  return Math.ceil(w + 14);
}

function nodeSize(title: string, subtitle: string | undefined, titleExtra = 0) {
  const w = Math.max(
    textWidth(title, 13, { bold: true }) + titleExtra,
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
  /** Size of the canvas; without an explicit direction, the direction that fits it best wins. */
  viewport?: Viewport,
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

  const items = new Map<string, ItemMeta>();
  const leaf = (id: string): ElkNode => {
    const n = nodeById.get(id)!;
    items.set(id, { kind: 'node', id });
    // Room for the status dot, entry marker and drill-down button next to the title.
    const extra = 14 + (flow.meta.entry === id ? 16 : 0) + (n.flow ? 28 : 0);
    const sub = n.anchor ? `${n.anchor.symbol}${n.anchor.sig ?? ''}` : 'external';
    return { id, ...nodeSize(n.title, sub, extra) };
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
      return { id, ...nodeSize(g.label, `${countNodes(tree, id)} nodes · 99 internal steps`, 34) };
    }
    // A group whose only content is one expanded group (module ▸ src/ ▸ file.c) is drawn as one
    // box with a combined header; nesting boxes there only costs space.
    const merged: Group[] = [];
    let inner = g;
    while (inner.nodes.length === 0 && inner.children.length === 1) {
      const c = tree.groups.get(inner.children[0]!)!;
      if (collapsed.has(c.id)) break;
      merged.push(c);
      inner = c;
    }
    items.set(id, { kind: 'group', id, group: g, merged });
    const header = [g, ...merged].map((x) => x.label).join(' / ');
    const headerWidth = textWidth(header, 12, { bold: true }) + 40;
    const padding =
      g.kind === 'file'
        ? `[top=${FILE_HEADER},left=8,bottom=8,right=8]`
        : `[top=${GROUP_HEADER},left=12,bottom=12,right=12]`;
    return {
      id,
      layoutOptions: {
        'elk.padding': padding,
        'elk.nodeSize.constraints': 'MINIMUM_SIZE',
        'elk.nodeSize.minimum': `(${headerWidth}, 40)`,
      },
      children: [...inner.children, ...inner.nodes]
        .sort(byRank)
        .map((c) => (tree.groups.has(c) ? group(c) : leaf(c))),
    };
  };

  const top = [
    ...tree.roots,
    ...flow.nodes.filter((n) => !tree.groupOf.has(n.id)).map((n) => n.id),
  ].sort(byRank);

  const labelParts = new Map<string, EdgeLabelParts>();
  // Returns are laid out as if they went caller → callee, so they run alongside their call
  // instead of looping around the whole diagram; their points are reversed afterwards.
  const reversed = (e: VisibleEdge) => e.type === 'return';
  const edges = (): ElkExtendedEdge[] =>
    projection.edges.map((e) => {
      const parts = edgeLabel(e, flow);
      labelParts.set(e.id, parts);
      return {
        id: e.id,
        sources: [reversed(e) ? e.to : e.from],
        targets: [reversed(e) ? e.from : e.to],
        labels: [{ id: `${e.id}:label`, text: parts.text, width: labelWidth(parts), height: 20 }],
      };
    });

  const graph = (direction: 'RIGHT' | 'DOWN'): ElkNode => ({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': direction,
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.cycleBreaking.strategy': 'MODEL_ORDER',
      'elk.layered.spacing.nodeNodeBetweenLayers': '50',
      'elk.layered.spacing.edgeNodeBetweenLayers': '20',
      'elk.spacing.nodeNode': '28',
      'elk.spacing.edgeEdge': '14',
      'elk.spacing.edgeLabel': '4',
      'elk.edgeLabels.placement': 'CENTER',
      'elk.json.edgeCoords': 'ROOT',
      'elk.json.shapeCoords': 'ROOT',
    },
    children: top.map((id) => (tree.groups.has(id) ? group(id) : leaf(id))),
    edges: edges(),
  });

  const explicit = flow.meta.layout?.direction;
  let result: ElkNode;
  if (explicit || !viewport) {
    result = await elk.layout(graph(explicit === 'TB' ? 'DOWN' : 'RIGHT'));
  } else {
    const [lr, tb] = await Promise.all([elk.layout(graph('RIGHT')), elk.layout(graph('DOWN'))]);
    const scale = (r: ElkNode) => Math.min(fitScale(r, viewport), 1.2);
    result = scale(tb) > scale(lr) * 1.1 ? tb : lr;
  }

  const laidOut: LaidOutItem[] = [];
  const collect = (n: ElkNode) => {
    const item = items.get(n.id);
    if (item) {
      laidOut.push({
        ...item,
        x: n.x ?? 0,
        y: n.y ?? 0,
        width: n.width ?? 0,
        height: n.height ?? 0,
      } as LaidOutItem);
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
        points: (() => {
          const pts = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
          return reversed(edge) ? pts.reverse() : pts;
        })(),
        label: label && {
          x: label.x ?? 0,
          y: label.y ?? 0,
          width: label.width ?? 0,
          height: label.height ?? 0,
          ...labelParts.get(e.id)!,
        },
      });
    }
    for (const c of n.children ?? []) collectEdges(c);
  };
  collectEdges(result);

  return {
    items: laidOut,
    edges: laidOutEdges,
    width: result.width ?? 0,
    height: result.height ?? 0,
  };
}

/** Labels stay legible down to this zoom; below it a coarser grouping level reads better. */
export const READABLE_ZOOM = 0.85;

/**
 * Returns the index of the first candidate grouping (ordered most detailed first) whose layout
 * fits the viewport at a readable zoom, or the last candidate if none does.
 */
export async function firstReadable(
  flow: Flow,
  tree: GroupTree,
  candidates: ReadonlySet<string>[],
  viewport: Viewport,
): Promise<number> {
  for (let i = 0; i < candidates.length - 1; i++) {
    const collapsed = candidates[i]!;
    const l = await layoutFlow(flow, tree, project(flow, tree, collapsed), collapsed, viewport);
    if (fitScale(l, viewport) >= READABLE_ZOOM) return i;
  }
  return candidates.length - 1;
}
