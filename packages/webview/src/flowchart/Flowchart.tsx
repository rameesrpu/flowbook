import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { project, type FlowPayload, type GroupTree, type Projection } from '@flowbook/core';
import { ArrowDefs } from '../arrows';
import { rootColors, rootOf } from '../model';
import type { Selection } from '../selection';
import {
  FlowEdgeView,
  FlowNodeView,
  GroupView,
  type EdgeData,
  type FlowNodeData,
  type GroupData,
} from './components';
import { layoutFlow, type Layout } from './layout';

// Custom names: React Flow ships default styles for its built-in 'group' type.
const nodeTypes = { fbNode: FlowNodeView, fbGroup: GroupView };
const edgeTypes = { flow: FlowEdgeView };

interface Props {
  payload: FlowPayload;
  tree: GroupTree;
  collapsed: ReadonlySet<string>;
  selection?: Selection;
  onToggle: (groupId: string) => void;
  onSelect: (selection: Selection | undefined) => void;
  onDrill: (flowId: string) => void;
}

export function Flowchart(props: Props) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}

function Canvas({ payload, tree, collapsed, selection, onToggle, onSelect, onDrill }: Props) {
  const { flow } = payload;
  const projection = useMemo(() => project(flow, tree, collapsed), [flow, tree, collapsed]);
  const [laidOut, setLaidOut] = useState<{ layout: Layout; projection: Projection }>();
  // A layout computed for an earlier flow or grouping must not be combined with the current one.
  const layout = laidOut?.projection === projection ? laidOut.layout : undefined;
  const [error, setError] = useState<string>();
  const { fitView } = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const el = wrapper.current;
    const viewport = el ? { width: el.clientWidth, height: el.clientHeight } : undefined;
    layoutFlow(flow, tree, projection, collapsed, viewport).then(
      (l) => !cancelled && (setLaidOut({ layout: l, projection }), setError(undefined)),
      (e: unknown) => !cancelled && setError(String(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [flow, tree, projection, collapsed]);

  useEffect(() => {
    if (layout)
      requestAnimationFrame(() => fitView({ padding: 0.12, duration: 200, maxZoom: 1.2 }));
  }, [layout, fitView]);

  // Which visible items and edges relate to the current selection.
  const focus = useMemo(() => {
    if (!selection) return undefined;
    const edges = new Set<string>();
    const items = new Set<string>();
    const stepIds = new Set<string>(
      selection.kind === 'edge'
        ? selection.steps
        : selection.kind === 'step'
          ? [selection.id]
          : selection.kind === 'block'
            ? (flow.blocks.find((b) => b.id === selection.id)?.steps ?? [])
            : [],
    );
    if (selection.kind === 'node') {
      const v = projection.visibleOf.get(selection.id) ?? selection.id;
      items.add(v);
      for (const e of projection.edges) {
        if (e.from === v || e.to === v) {
          edges.add(e.id);
          items.add(e.from);
          items.add(e.to);
        }
      }
    }
    for (const e of projection.edges) {
      if (e.steps.some((s) => stepIds.has(s))) {
        edges.add(e.id);
        items.add(e.from);
        items.add(e.to);
      }
    }
    return { edges, items };
  }, [selection, projection, flow.blocks]);

  const colors = useMemo(() => rootColors(tree), [tree]);
  const colorOf = useCallback((id: string) => colors.get(rootOf(tree, id) ?? ''), [colors, tree]);

  const { nodes, edges } = useMemo(() => {
    if (!layout) return { nodes: [], edges: [] };
    const nodes: Node[] = layout.items.map((item) => {
      const base = {
        id: item.id,
        position: { x: item.x, y: item.y },
        width: item.width,
        height: item.height,
        draggable: false,
        connectable: false,
      };
      if (item.kind === 'node') {
        const n = flow.nodes.find((x) => x.id === item.id)!;
        const data: FlowNodeData = {
          title: n.title,
          symbol: n.anchor ? `${n.anchor.symbol}${n.anchor.sig ?? ''}` : undefined,
          state: payload.anchors[n.id]?.state,
          entry: flow.meta.entry === n.id,
          drill: n.flow,
          drillTitle: n.flow ? payload.flowTitles[n.flow] : undefined,
          color: colorOf(n.id),
          dimmed: !!focus && !focus.items.has(n.id),
          onDrill,
        };
        return {
          ...base,
          type: 'fbNode',
          data,
          selected: selection?.kind === 'node' && selection.id === n.id,
          zIndex: 10,
        };
      }
      const data: GroupData = {
        group: item.group,
        collapsed: item.kind === 'collapsed',
        nodeCount: item.kind === 'collapsed' ? item.nodeCount : undefined,
        hiddenSteps: item.kind === 'collapsed' ? item.hiddenSteps : undefined,
        color: colorOf(item.id),
        dimmed: item.kind === 'collapsed' && !!focus && !focus.items.has(item.id),
        onToggle,
      };
      return {
        ...base,
        type: 'fbGroup',
        data,
        selectable: item.kind === 'collapsed',
        zIndex: item.kind === 'collapsed' ? 10 : item.group.depth,
      };
    });
    const edges: Edge[] = layout.edges.map((laid) => {
      const data: EdgeData = {
        laid,
        dimmed: !!focus && !focus.edges.has(laid.edge.id),
        highlighted: !!focus && focus.edges.has(laid.edge.id),
        onSelect: (id) => {
          const e = projection.edges.find((x) => x.id === id)!;
          onSelect({ kind: 'edge', id, steps: e.steps });
        },
      };
      return {
        id: laid.edge.id,
        source: laid.edge.from,
        target: laid.edge.to,
        type: 'flow',
        data,
        zIndex: 5,
      };
    });
    return { nodes, edges };
  }, [
    layout,
    flow,
    payload.anchors,
    payload.flowTitles,
    focus,
    selection,
    onToggle,
    onDrill,
    onSelect,
    projection.edges,
    colorOf,
  ]);

  if (error) return <div className="fb-error">Layout failed: {error}</div>;
  return (
    <div ref={wrapper} className="fb-flowchart">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        minZoom={0.1}
        maxZoom={2.5}
        onNodeClick={(_, node) =>
          onSelect(node.type === 'fbNode' ? { kind: 'node', id: node.id } : undefined)
        }
        onEdgeClick={(_, edge) => {
          const e = projection.edges.find((x) => x.id === edge.id);
          if (e) onSelect({ kind: 'edge', id: e.id, steps: e.steps });
        }}
        onPaneClick={() => onSelect(undefined)}
        proOptions={{ hideAttribution: false }}
      >
        <ArrowDefs />
        <Background gap={24} size={1} />
        <Controls showInteractive={false} />
        {(layout?.items.length ?? 0) > 14 && (
          <MiniMap
            pannable
            zoomable
            className="fb-minimap"
            nodeColor={(n) =>
              n.type === 'fbGroup' && !n.data.collapsed ? 'transparent' : 'var(--fb-minimap-node)'
            }
            nodeStrokeColor="var(--fb-node-border)"
          />
        )}
      </ReactFlow>
    </div>
  );
}
