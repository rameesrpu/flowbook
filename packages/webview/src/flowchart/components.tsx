import {
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  Position,
  type EdgeProps,
  type NodeProps,
} from '@xyflow/react';
import type { AnchorStateName, Group } from '@flowbook/core';
import { markerId, type EdgeStyle } from '../arrows';
import { truncate } from '../measure';
import { STATE_INFO } from '../model';
import { SYMBOL_CHARS, type LaidOutEdge } from './layout';
import { roundedPath } from './path';

export interface FlowNodeData extends Record<string, unknown> {
  title: string;
  symbol?: string;
  state?: AnchorStateName;
  entry: boolean;
  drill?: string;
  drillTitle?: string;
  color?: string;
  dimmed: boolean;
  onDrill: (flowId: string) => void;
}

export interface GroupData extends Record<string, unknown> {
  group: Group;
  collapsed: boolean;
  nodeCount?: number;
  hiddenSteps?: number;
  color?: string;
  dimmed: boolean;
  onToggle: (id: string) => void;
}

export interface EdgeData extends Record<string, unknown> {
  laid: LaidOutEdge;
  dimmed: boolean;
  highlighted: boolean;
  onSelect: (edgeId: string) => void;
}

// Edges are drawn from ELK's geometry, but React Flow still needs handles to attach them.
const Handles = () => (
  <>
    <Handle type="target" position={Position.Left} className="fb-handle" isConnectable={false} />
    <Handle type="source" position={Position.Right} className="fb-handle" isConnectable={false} />
  </>
);

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(' ');

export function FlowNodeView({ data, selected }: NodeProps & { data: FlowNodeData }) {
  const external = data.symbol === undefined;
  return (
    <div
      className={cx(
        'fb-node',
        external && 'fb-node--external',
        data.entry && 'fb-node--entry',
        selected && 'fb-node--selected',
        data.dimmed && 'fb-dimmed',
      )}
      style={data.color ? ({ '--fb-band': data.color } as React.CSSProperties) : undefined}
    >
      <Handles />
      <div className="fb-node__title">
        {data.entry && (
          <span className="fb-node__entry" title="Entry point of this flow">
            ▶
          </span>
        )}
        {data.state && data.state !== 'fresh' && (
          <span
            className={`fb-status fb-status--${data.state}`}
            title={STATE_INFO[data.state].label}
          />
        )}
        <span className="fb-node__text">{data.title}</span>
        {data.drill && (
          <button
            className="fb-node__drill"
            title={`Open detailed flow: ${data.drillTitle ?? data.drill}`}
            onClick={(e) => {
              e.stopPropagation();
              data.onDrill(data.drill!);
            }}
          >
            ⤵
          </button>
        )}
      </div>
      {external ? (
        <div className="fb-node__symbol fb-node__symbol--external">external</div>
      ) : (
        <div className="fb-node__symbol">{truncate(data.symbol!, SYMBOL_CHARS)}</div>
      )}
    </div>
  );
}

const KIND_ICON = { module: '◆', folder: '▤', file: '▢' } as const;
const KIND_LABEL = { module: 'module', folder: 'folder', file: 'file' } as const;

export function GroupView({ data }: NodeProps & { data: GroupData }) {
  const { group } = data;
  const style = data.color ? ({ '--fb-band': data.color } as React.CSSProperties) : undefined;
  if (data.collapsed) {
    return (
      <div
        className={cx('fb-collapsed', `fb-collapsed--${group.kind}`, data.dimmed && 'fb-dimmed')}
        style={style}
        title={`${KIND_LABEL[group.kind]} ${group.path ?? group.label} — click to expand`}
        onClick={(e) => {
          e.stopPropagation();
          data.onToggle(group.id);
        }}
      >
        <Handles />
        <div className="fb-node__title">
          <span className="fb-group__icon">{KIND_ICON[group.kind]}</span>
          <span className="fb-node__text">{group.label}</span>
          <span className="fb-group__chevron">▸</span>
        </div>
        <div className="fb-node__symbol fb-node__symbol--count">
          {data.nodeCount} node{data.nodeCount === 1 ? '' : 's'}
          {data.hiddenSteps
            ? ` · ${data.hiddenSteps} internal step${data.hiddenSteps === 1 ? '' : 's'}`
            : ''}
        </div>
      </div>
    );
  }
  return (
    <div
      className={cx(
        'fb-group',
        `fb-group--${group.kind}`,
        `fb-group--depth${Math.min(group.depth, 3)}`,
      )}
      style={style}
    >
      <Handles />
      <button
        className="fb-group__header"
        title={`${KIND_LABEL[group.kind]} ${group.path ?? group.label} — click to collapse`}
        onClick={(e) => {
          e.stopPropagation();
          data.onToggle(group.id);
        }}
      >
        <span className="fb-group__chevron">▾</span>
        <span className="fb-group__icon">{KIND_ICON[group.kind]}</span>
        <span className="fb-group__label">{group.label}</span>
      </button>
    </div>
  );
}

export function FlowEdgeView({ id, data }: EdgeProps & { data: EdgeData }) {
  const { laid } = data;
  const style: EdgeStyle = laid.edge.aggregated ? 'aggregated' : laid.edge.type;
  const cls = cx(
    'fb-edge',
    `fb-edge--${style}`,
    data.dimmed && 'fb-dimmed',
    data.highlighted && 'fb-edge--highlighted',
  );
  const label = laid.label;
  return (
    <>
      <BaseEdge
        id={id}
        path={roundedPath(laid.points)}
        markerEnd={`url(#${markerId(style, data.highlighted)})`}
        className={cls}
        interactionWidth={14}
      />
      {label && (
        <EdgeLabelRenderer>
          <div
            className={`fb-edge-label nodrag nopan ${cls}`}
            style={{
              transform: `translate(${label.x}px, ${label.y}px)`,
              width: label.width,
              height: label.height,
            }}
            title={
              laid.edge.aggregated
                ? `${laid.edge.steps.length} steps — click to list`
                : `${laid.edge.guard ? `[${laid.edge.guard}] ` : ''}${laid.edge.label}`
            }
            onClick={(e) => {
              e.stopPropagation();
              data.onSelect(laid.edge.id);
            }}
          >
            {label.badges && <span className="fb-edge-label__badges">{label.badges}</span>}
            <span className="fb-edge-label__seq">{label.seq}</span>
            {label.guard && <span className="fb-guard">[{label.guard}]</span>}
            <span className="fb-edge-label__text">{label.text}</span>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
