import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react';
import { useEffect, useMemo, useState } from 'react';
import { project, type FlowPayload, type GroupTree } from '@flowbook/core';
import type { Selection } from '../selection';
import { FlowEdgeView, FlowNodeView, GroupView, type EdgeData, type FlowNodeData, type GroupData } from './components';
import { layoutFlow, type Layout } from './layout';

const nodeTypes = { flow: FlowNodeView, group: GroupView };
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
  const [layout, setLayout] = useState<Layout>();
  const [error, setError] = useState<string>();
  const { fitView } = useReactFlow();

  useEffect(() => {
    let cancelled = false;
    layoutFlow(flow, tree, projection, collapsed).then(
      (l) => !cancelled && (setLayout(l), setError(undefined)),
      (e: unknown) => !cancelled && setError(String(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [flow, tree, projection, collapsed]);

  useEffect(() => {
    if (layout) requestAnimationFrame(() => fitView({ padding: 0.12, duration: 200, maxZoom: 1.2 }));
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
          dimmed: !!focus && !focus.items.has(n.id),
          onDrill,
        };
        return {
          ...base,
          type: 'flow',
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
        dimmed: item.kind === 'collapsed' && !!focus && !focus.items.has(item.id),
        onToggle,
      };
      return {
        ...base,
        type: 'group',
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
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
        zIndex: 5,
      };
    });
    return { nodes, edges };
  }, [layout, flow, payload.anchors, focus, selection, onToggle, onDrill, onSelect, projection.edges]);

  if (error) return <div className="fb-error">Layout failed: {error}</div>;
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      nodesDraggable={false}
      nodesConnectable={false}
      minZoom={0.1}
      maxZoom={2.5}
      onNodeClick={(_, node) => node.type === 'flow' && onSelect({ kind: 'node', id: node.id })}
      onEdgeClick={(_, edge) => {
        const e = projection.edges.find((x) => x.id === edge.id);
        if (e) onSelect({ kind: 'edge', id: e.id, steps: e.steps });
      }}
      onPaneClick={() => onSelect(undefined)}
      proOptions={{ hideAttribution: false }}
    >
      <Background gap={24} size={1} />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable className="fb-minimap" />
    </ReactFlow>
  );
}
