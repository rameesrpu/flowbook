import { BaseEdge, EdgeLabelRenderer, Handle, Position, type EdgeProps, type NodeProps } from '@xyflow/react';
import type { AnchorStateName, Group, VisibleEdge } from '@flowbook/core';
import { truncate } from '../measure';
import { SYMBOL_CHARS, type LaidOutEdge } from './layout';
import { roundedPath } from './path';

export interface FlowNodeData extends Record<string, unknown> {
  title: string;
  symbol?: string;
  state?: AnchorStateName;
  entry: boolean;
  drill?: string;
  dimmed: boolean;
  onDrill: (flowId: string) => void;
}

export interface GroupData extends Record<string, unknown> {
  group: Group;
  collapsed: boolean;
  nodeCount?: number;
  hiddenSteps?: number;
  dimmed: boolean;
  onToggle: (id: string) => void;
}

export interface EdgeData extends Record<string, unknown> {
  laid: LaidOutEdge;
  dimmed: boolean;
  highlighted: boolean;
  onSelect: (edgeId: string) => void;
}

const STATE_TITLES: Partial<Record<AnchorStateName, string>> = {
  stale: 'Code changed since this node was verified',
  unstamped: 'Not stamped yet',
  missing: 'Symbol not found',
  'missing-file': 'Source file not found',
  ambiguous: 'Anchor matches several overloads',
};

// Edges are drawn from ELK's geometry, but React Flow still needs handles to attach them.
const Handles = () => (
  <>
    <Handle type="target" position={Position.Left} className="fb-handle" isConnectable={false} />
    <Handle type="source" position={Position.Right} className="fb-handle" isConnectable={false} />
  </>
);

export function FlowNodeView({ data, selected }: NodeProps & { data: FlowNodeData }) {
  const external = data.symbol === undefined;
  return (
    <div
      className={[
        'fb-node',
        external && 'fb-node--external',
        data.entry && 'fb-node--entry',
        selected && 'fb-node--selected',
        data.dimmed && 'fb-dimmed',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <Handles />
      <div className="fb-node__title">
        {data.state && data.state !== 'fresh' && (
          <span className={`fb-status fb-status--${data.state}`} title={STATE_TITLES[data.state]} />
        )}
        <span>{data.title}</span>
        {data.drill && (
          <button
            className="fb-node__drill"
            title="Open the detailed flow"
            onClick={(e) => {
              e.stopPropagation();
              data.onDrill(data.drill!);
            }}
          >
            ⤵
          </button>
        )}
      </div>
      {!external && <div className="fb-node__symbol">{truncate(data.symbol!, SYMBOL_CHARS)}</div>}
    </div>
  );
}

const KIND_ICON = { module: '◆', folder: '▤', file: '▢' } as const;

export function GroupView({ data }: NodeProps & { data: GroupData }) {
  const { group } = data;
  if (data.collapsed) {
    return (
      <div
        className={`fb-collapsed fb-collapsed--${group.kind}${data.dimmed ? ' fb-dimmed' : ''}`}
        title={`${group.path ?? group.label} — click to expand`}
        onClick={(e) => {
          e.stopPropagation();
          data.onToggle(group.id);
        }}
      >
        <Handles />
        <div className="fb-node__title">
          <span className="fb-group__icon">{KIND_ICON[group.kind]}</span>
          <span>{group.label}</span>
          <span className="fb-group__chevron">▸</span>
        </div>
        <div className="fb-node__symbol">
          {data.nodeCount} nodes{data.hiddenSteps ? ` · ${data.hiddenSteps} internal steps` : ''}
        </div>
      </div>
    );
  }
  return (
    <div className={`fb-group fb-group--${group.kind} fb-group--depth${Math.min(group.depth, 3)}`}>
      <Handles />
      <button
        className="fb-group__header"
        title={`${group.path ?? group.label} — click to collapse`}
        onClick={(e) => {
          e.stopPropagation();
          data.onToggle(group.id);
        }}
      >
        <span className="fb-group__chevron">▾</span>
        <span className="fb-group__icon">{KIND_ICON[group.kind]}</span>
        {group.label}
      </button>
    </div>
  );
}

const typeClass = (e: VisibleEdge) => `fb-edge--${e.aggregated ? 'aggregated' : e.type}`;

export function FlowEdgeView({ id, data, markerEnd }: EdgeProps & { data: EdgeData }) {
  const { laid } = data;
  const cls = [
    'fb-edge',
    typeClass(laid.edge),
    data.dimmed && 'fb-dimmed',
    data.highlighted && 'fb-edge--highlighted',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <>
      <BaseEdge id={id} path={roundedPath(laid.points)} markerEnd={markerEnd} className={cls} interactionWidth={14} />
      {laid.label && (
        <EdgeLabelRenderer>
          <div
            className={`fb-edge-label ${cls}`}
            style={{
              transform: `translate(${laid.label.x}px, ${laid.label.y}px)`,
              width: laid.label.width,
              height: laid.label.height,
            }}
            title={laid.edge.aggregated ? `${laid.edge.steps.length} steps — click to list` : laid.edge.label}
            onClick={(e) => {
              e.stopPropagation();
              data.onSelect(laid.edge.id);
            }}
          >
            {laid.label.text}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
