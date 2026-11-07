import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import {
  project,
  type AnchorStateName,
  type BlockRecord,
  type FlowPayload,
  type GroupTree,
  type StepRecord,
} from '@flowbook/core';
import { ArrowDefs, markerId } from '../arrows';
import { textWidth, truncate } from '../measure';
import { rootColors, rootOf, sortedSteps, STATE_INFO } from '../model';
import type { Selection } from '../selection';

interface Props {
  payload: FlowPayload;
  tree: GroupTree;
  collapsed: ReadonlySet<string>;
  selection?: Selection;
  onToggle: (groupId: string) => void;
  onSelect: (selection: Selection | undefined) => void;
  /** Double-click on a participant or message: open the node's code. */
  onOpenCode: (nodeId: string) => void;
  zoom: number;
  onZoom: (zoom: number) => void;
}

interface Participant {
  id: string;
  kind: 'node' | 'group';
  label: string;
  sub: string;
  state?: AnchorStateName;
  root?: string;
  color?: string;
  entry: boolean;
  x: number;
  half: number;
}

interface Message {
  step: StepRecord;
  from: number;
  to: number;
  /** Both ends inside the same collapsed group. */
  internal: boolean;
  label: { seq: string; guard?: string; text: string; width: number };
  y: number;
}

interface Frame {
  block: BlockRecord;
  start: number;
  end: number;
  depth: number;
  inner: number;
  x1: number;
  x2: number;
  top: number;
  bottom: number;
}

const PAD = 28;
const GAP = 28;
const BOX_MIN = 120;
const BOX_MAX = 220;
const BAND_H = 18;
const BOX_H = 44;
const ROW_H = 36;
const SELF_H = 44;
const SELF_W = 26;
const FRAME_HEAD = 26;
const FRAME_FOOT = 8;
const LABEL_CHARS = 56;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.5;
const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));

const GROUP_ICON = { module: '◆', folder: '▤', file: '▢' } as const;

interface Band {
  group: string;
  depth: number;
  label: string;
  color: string;
  x1: number;
  x2: number;
}

interface Model {
  participants: Participant[];
  messages: Message[];
  frames: Frame[];
  width: number;
  height: number;
  /** Open groups over the participants, one row per nesting depth (row 0 = top-level). */
  bands: Band[];
  bandRows: number;
  visibleOf: Map<string, string>;
}

function buildModel(payload: FlowPayload, tree: GroupTree, collapsed: ReadonlySet<string>): Model {
  const { flow } = payload;
  const projection = project(flow, tree, collapsed);
  const vis = (id: string) => projection.visibleOf.get(id) ?? id;
  const steps = sortedSteps(flow);
  const colors = rootColors(tree);

  // Participants in order of first appearance.
  const order: string[] = [];
  const add = (id: string) => order.includes(id) || order.push(id);
  if (flow.meta.entry) add(vis(flow.meta.entry));
  for (const s of steps) {
    add(vis(s.from));
    add(vis(s.to));
  }
  for (const n of flow.nodes) add(vis(n.id));

  const participants: Participant[] = order.map((id) => {
    const g = tree.groups.get(id);
    const root = rootOf(tree, id);
    let label: string;
    let sub: string;
    let state: AnchorStateName | undefined;
    if (g) {
      label = `${GROUP_ICON[g.kind]} ${g.label}`;
      const count = flow.nodes.filter((n) => vis(n.id) === id).length;
      sub = `${count} node${count === 1 ? '' : 's'} · click to expand`;
    } else {
      const n = flow.nodes.find((x) => x.id === id)!;
      label = n.title;
      sub = n.anchor ? n.anchor.symbol.split('::').slice(-2).join('::') : 'external';
      state = payload.anchors[id]?.state;
    }
    const w = Math.max(
      textWidth(label, 13, { bold: true }) + (state && state !== 'fresh' ? 14 : 0),
      textWidth(sub, 11, { mono: true }),
    );
    const width = Math.min(BOX_MAX, Math.max(BOX_MIN, Math.ceil(w + 24)));
    return {
      id,
      kind: g ? 'group' : 'node',
      label,
      sub,
      state,
      root,
      color: root ? colors.get(root) : undefined,
      entry: !g && flow.meta.entry === id,
      x: 0,
      half: width / 2,
    };
  });
  const index = new Map(participants.map((p, i) => [p.id, i]));

  const messages: Message[] = steps.map((s) => {
    const from = index.get(vis(s.from))!;
    const to = index.get(vis(s.to))!;
    const text = truncate(s.label, LABEL_CHARS);
    const seq = String(s.seq);
    let width = textWidth(seq, 12, { bold: true }) + 6 + textWidth(text, 13);
    if (s.guard) width += textWidth(`[${s.guard}]`, 12, { mono: true }) + 6;
    return {
      step: s,
      from,
      to,
      internal: from === to && tree.groups.has(participants[from]!.id),
      label: { seq, guard: s.guard, text, width: Math.ceil(width) },
      y: 0,
    };
  });

  // Horizontal positions: wide enough for boxes and for every label between its two lifelines.
  participants.forEach((p, j) => {
    if (j === 0) {
      p.x = PAD + p.half;
      return;
    }
    const prev = participants[j - 1]!;
    let x = prev.x + prev.half + GAP + p.half;
    for (const m of messages) {
      const lo = Math.min(m.from, m.to);
      const hi = Math.max(m.from, m.to);
      if (hi === j && lo < j) x = Math.max(x, participants[lo]!.x + m.label.width + 36);
      if (m.from === m.to && m.from === j - 1) x = Math.max(x, prev.x + m.label.width + 24);
    }
    p.x = Math.round(x);
  });
  const last = participants[participants.length - 1];
  let width = last ? last.x + last.half + PAD : PAD * 2;
  for (const m of messages) {
    if (m.from === m.to && m.from === participants.length - 1) {
      width = Math.max(width, last!.x + m.label.width + 24 + PAD);
    }
  }

  // Block frames: row span, nesting depth and how many levels nest inside each.
  const rowOf = new Map(messages.map((m, i) => [m.step.id, i]));
  const frames: Frame[] = flow.blocks
    .flatMap((b): Frame[] => {
      const rows = b.steps.map((s) => rowOf.get(s)).filter((r): r is number => r !== undefined);
      return rows.length
        ? [
            {
              block: b,
              start: Math.min(...rows),
              end: Math.max(...rows),
              depth: 0,
              inner: 0,
              x1: 0,
              x2: 0,
              top: 0,
              bottom: 0,
            },
          ]
        : [];
    })
    .sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const contains = (a: Frame, b: Frame) => a !== b && a.start <= b.start && a.end >= b.end;
  for (const f of frames)
    f.depth = frames.filter((o) => contains(o, f) && frames.indexOf(o) < frames.indexOf(f)).length;
  const innerOf = (f: Frame): number => {
    const kids = frames.filter((o) => contains(f, o) && o.depth === f.depth + 1);
    return kids.length ? 1 + Math.max(...kids.map(innerOf)) : 0;
  };
  for (const f of frames) f.inner = innerOf(f);

  // Vertical layout.
  let y = 18;
  messages.forEach((m, i) => {
    for (const f of frames.filter((f) => f.start === i)) {
      f.top = y;
      y += FRAME_HEAD;
    }
    m.y = y;
    y += m.from === m.to ? SELF_H : ROW_H;
    const ending = frames.filter((f) => f.end === i).sort((a, b) => b.depth - a.depth);
    for (const f of ending) {
      y += FRAME_FOOT;
      f.bottom = y;
    }
  });
  const height = y + 24;

  for (const f of frames) {
    let x1 = Infinity;
    let x2 = -Infinity;
    for (let r = f.start; r <= f.end; r++) {
      const m = messages[r]!;
      if (!f.block.steps.includes(m.step.id) && !frames.some((o) => contains(f, o))) continue;
      const a = participants[m.from]!.x;
      const b = participants[m.to]!.x;
      x1 = Math.min(x1, a, b);
      x2 = Math.max(x2, a, b, m.from === m.to ? a + Math.max(SELF_W, m.label.width + 8) : b);
    }
    const tab =
      textWidth(f.block.type, 11, { bold: true }) + textWidth(`[${f.block.label}]`, 12) + 40;
    const pad = 16 + 10 * f.inner;
    f.x1 = x1 - pad;
    f.x2 = Math.max(x2 + pad, f.x1 + tab);
    width = Math.max(width, f.x2 + 8);
  }

  // Bands over runs of participants that share an open group, one row per depth. Clicking a
  // band collapses that group, like a group header in the flowchart.
  const chains = participants.map((p) => {
    const chain: string[] = [];
    let g = tree.groups.get(
      p.kind === 'group' ? (tree.groups.get(p.id)?.parent ?? '') : (tree.groupOf.get(p.id) ?? ''),
    );
    while (g) {
      chain.unshift(g.id);
      g = g.parent ? tree.groups.get(g.parent) : undefined;
    }
    return chain;
  });
  const bandRows = Math.max(0, ...chains.map((c) => c.length));
  const bands: Band[] = [];
  for (let depth = 0; depth < bandRows; depth++) {
    let prev: Band | undefined;
    participants.forEach((p, i) => {
      const id = chains[i]![depth];
      if (!id) {
        prev = undefined;
        return;
      }
      if (prev && prev.group === id) {
        prev.x2 = p.x + p.half;
        return;
      }
      const g = tree.groups.get(id)!;
      prev = {
        group: id,
        depth,
        label: `${GROUP_ICON[g.kind]} ${g.label}`,
        color: p.color!,
        x1: p.x - p.half,
        x2: p.x + p.half,
      };
      bands.push(prev);
    });
  }

  return {
    participants,
    messages,
    frames,
    width: Math.ceil(width),
    height,
    bands,
    bandRows,
    visibleOf: projection.visibleOf,
  };
}

export function SequenceView({
  payload,
  tree,
  collapsed,
  selection,
  onToggle,
  onSelect,
  onOpenCode,
  zoom,
  onZoom,
}: Props) {
  const model = useMemo(() => buildModel(payload, tree, collapsed), [payload, tree, collapsed]);
  const { participants, messages, frames, width, height, bands, bandRows } = model;
  const { flow } = payload;
  const headerH = bandRows * BAND_H + 6 + BOX_H + 10;

  // Zoom: Ctrl/Cmd + wheel (or pinch) keeps the point under the cursor in place.
  const scroller = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const anchor = useRef<{ x: number; y: number; from: number }>();
  const zoomTo = (next: number, at?: { x: number; y: number }) => {
    const z = clampZoom(next);
    if (z === zoomRef.current) return;
    const el = scroller.current;
    if (el) {
      const x = at?.x ?? el.clientWidth / 2;
      const y = at?.y ?? el.clientHeight / 2;
      anchor.current = { x, y, from: zoomRef.current };
    }
    onZoom(z);
  };
  const zoomToRef = useRef(zoomTo);
  zoomToRef.current = zoomTo;
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomToRef.current(zoomRef.current * Math.exp(-e.deltaY * 0.002), {
        x: e.clientX - r.left,
        y: e.clientY - r.top,
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  useLayoutEffect(() => {
    const el = scroller.current;
    const a = anchor.current;
    anchor.current = undefined;
    if (!el || !a) return;
    const k = zoom / a.from;
    el.scrollLeft = (el.scrollLeft + a.x) * k - a.x;
    el.scrollTop = (el.scrollTop + a.y) * k - a.y;
  }, [zoom]);

  // Steps and participants related to the selection.
  const focus = useMemo(() => {
    if (!selection) return undefined;
    const steps = new Set<string>();
    const parts = new Set<number>();
    if (selection.kind === 'node') {
      const target = model.visibleOf.get(selection.id) ?? selection.id;
      const p = participants.findIndex((x) => x.id === target);
      parts.add(p);
      for (const m of messages) {
        if (m.from === p || m.to === p) {
          steps.add(m.step.id);
          parts.add(m.from).add(m.to);
        }
      }
    } else {
      const ids =
        selection.kind === 'step'
          ? [selection.id]
          : selection.kind === 'edge'
            ? selection.steps
            : (flow.blocks.find((b) => b.id === selection.id)?.steps ?? []);
      for (const id of ids) steps.add(id);
      for (const m of messages) if (steps.has(m.step.id)) parts.add(m.from).add(m.to);
    }
    return { steps, parts, block: selection.kind === 'block' ? selection.id : undefined };
  }, [selection, participants, messages, flow, model.visibleOf]);

  if (messages.length === 0) {
    return <div className="fb-empty">This flow has no steps yet.</div>;
  }

  return (
    <div className="fb-seq-wrap">
      <div ref={scroller} className="fb-seq" onClick={() => onSelect(undefined)}>
        <ArrowDefs />
        <div className="fb-seq__inner" style={{ width, zoom }}>
          <div className="fb-seq__header" style={{ height: headerH }}>
            {bands.map((b) => {
              const g = tree.groups.get(b.group)!;
              return (
                <button
                  key={`${b.group}-${b.x1}`}
                  className={`fb-seq__band fb-seq__band--depth${Math.min(b.depth, 2)}`}
                  style={
                    {
                      left: b.x1,
                      top: 4 + b.depth * BAND_H,
                      width: b.x2 - b.x1,
                      height: BAND_H - 2,
                      '--fb-band': b.color,
                    } as React.CSSProperties
                  }
                  title={`${g.kind} ${g.path ?? g.label} — click to collapse`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggle(b.group);
                  }}
                >
                  {b.label}
                </button>
              );
            })}
            {participants.map((p, i) => {
              const selected = selection?.kind === 'node' && selection.id === p.id;
              return (
                <button
                  key={p.id}
                  className={[
                    'fb-seq__box',
                    p.kind === 'group' && 'fb-seq__box--group',
                    p.sub === 'external' && 'fb-seq__box--external',
                    selected && 'is-selected',
                    focus && !focus.parts.has(i) && 'fb-dimmed',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  style={
                    {
                      left: p.x - p.half,
                      top: bandRows * BAND_H + 6,
                      width: p.half * 2,
                      height: BOX_H,
                      '--fb-band': p.color,
                    } as React.CSSProperties
                  }
                  title={
                    p.kind === 'group'
                      ? 'Click to expand this group'
                      : p.sub === 'external'
                        ? p.id
                        : `${p.id} — double-click to open code`
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    if (p.kind === 'group') onToggle(p.id);
                    else onSelect({ kind: 'node', id: p.id });
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    if (p.kind === 'node') onOpenCode(p.id);
                  }}
                >
                  <span className="fb-seq__box-title">
                    {p.entry && <span className="fb-seq__entry">▶</span>}
                    {p.state && p.state !== 'fresh' && (
                      <span
                        className={`fb-status fb-status--${p.state}`}
                        title={STATE_INFO[p.state].label}
                      />
                    )}
                    <span className="fb-node__text">{p.label}</span>
                  </span>
                  <span className="fb-seq__box-sub">{p.sub}</span>
                </button>
              );
            })}
          </div>
          <svg width={width} height={height} className="fb-seq__svg">
            {participants.map((p, i) => (
              <line
                key={p.id}
                x1={p.x}
                x2={p.x}
                y1={0}
                y2={height}
                className={`fb-seq__lifeline${focus && !focus.parts.has(i) ? ' fb-dimmed' : ''}`}
              />
            ))}
            {frames.map((f) => {
              const tabW = textWidth(f.block.type, 11, { bold: true }) + 16;
              const active = focus?.block === f.block.id;
              return (
                <g
                  key={f.block.id}
                  className={`fb-frame fb-frame--${f.block.type}${active ? ' is-selected' : ''}${focus && !active ? ' fb-faded' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect({ kind: 'block', id: f.block.id });
                  }}
                >
                  <rect
                    x={f.x1}
                    y={f.top}
                    width={f.x2 - f.x1}
                    height={f.bottom - f.top}
                    rx={3}
                    className="fb-frame__box"
                  />
                  <path
                    d={`M ${f.x1} ${f.top} h ${tabW} v 12 l -6 6 h ${-(tabW - 6)} z`}
                    className="fb-frame__tab"
                  />
                  <text x={f.x1 + 7} y={f.top + 13} className="fb-frame__type">
                    {f.block.type}
                  </text>
                  <text x={f.x1 + tabW + 8} y={f.top + 13} className="fb-frame__label">
                    [{f.block.label}]
                  </text>
                </g>
              );
            })}
            {messages.map((m) => {
              const a = participants[m.from]!.x;
              const b = participants[m.to]!.x;
              const self = m.from === m.to;
              const type = m.step.type;
              const hl = !!focus?.steps.has(m.step.id);
              const dim = focus && !hl;
              const lineY = m.y + 22;
              const d = self
                ? `M ${a} ${lineY} H ${a + SELF_W} V ${lineY + 14} H ${a + 1}`
                : `M ${a} ${lineY} H ${b}`;
              const lx = self ? a + 6 : (a + b) / 2;
              const ly = lineY - 7;
              const lw = m.label.width;
              const bx = self ? lx - 3 : lx - lw / 2 - 4;
              return (
                <g
                  key={m.step.id}
                  className={[
                    'fb-msg',
                    `fb-msg--${type}`,
                    hl && 'is-selected',
                    dim && 'fb-dimmed',
                    m.internal && 'fb-msg--internal',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect({ kind: 'step', id: m.step.id });
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    const from = flow.nodes.find((n) => n.id === m.step.from);
                    onOpenCode(from?.anchor ? m.step.from : m.step.to);
                  }}
                >
                  <title>
                    {`${m.step.seq}. ${m.step.guard ? `[${m.step.guard}] ` : ''}${m.step.label}${m.internal ? ' (inside collapsed group)' : ''}`}
                  </title>
                  <path d={d} className="fb-msg__hit" />
                  <rect
                    x={bx}
                    y={ly - 13}
                    width={lw + 8}
                    height={18}
                    rx={3}
                    className="fb-msg__label-bg"
                  />
                  <path
                    d={d}
                    className={`fb-line fb-line--${type}`}
                    markerEnd={`url(#${markerId(type, hl)})`}
                  />
                  <text
                    x={lx}
                    y={ly}
                    textAnchor={self ? 'start' : 'middle'}
                    className="fb-msg__label"
                  >
                    <tspan className="fb-msg__seq">{m.label.seq}</tspan>
                    {m.label.guard && (
                      <tspan dx={6} className="fb-msg__guard">
                        [{m.label.guard}]
                      </tspan>
                    )}
                    <tspan dx={6}>{m.label.text}</tspan>
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      </div>
      <div className="fb-zoom" role="group" aria-label="Zoom">
        <button
          title="Zoom out (Ctrl + wheel)"
          onClick={() => zoomTo(zoom / 1.15)}
          disabled={zoom <= ZOOM_MIN}
        >
          −
        </button>
        <button title="Reset zoom" className="fb-zoom__level" onClick={() => zoomTo(1)}>
          {Math.round(zoom * 100)}%
        </button>
        <button
          title="Zoom in (Ctrl + wheel)"
          onClick={() => zoomTo(zoom * 1.15)}
          disabled={zoom >= ZOOM_MAX}
        >
          +
        </button>
      </div>
    </div>
  );
}
