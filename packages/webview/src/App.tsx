import '@xyflow/react/dist/style.css';
import './styles.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ancestorsOf,
  buildGroups,
  collapseBelow,
  type FlowPayload,
  type GroupTree,
  type HostMessage,
  type Snippet,
} from '@flowbook/core';
import { ErrorBoundary } from './ErrorBoundary';
import { Flowchart } from './flowchart/Flowchart';
import type { Host } from './host';
import { SequenceView } from './sequence/SequenceView';
import type { Selection } from './selection';
import { SidePanel } from './SidePanel';

export type View = 'flow' | 'sequence';
export type Level = 'modules' | 'folders' | 'files' | 'all';

const LEVELS: { level: Level; label: string; title: string }[] = [
  { level: 'modules', label: 'Modules', title: 'Collapse everything to top-level modules' },
  { level: 'folders', label: 'Folders', title: 'Open modules, collapse what is inside them' },
  { level: 'files', label: 'Files', title: 'Open two levels of grouping' },
  { level: 'all', label: 'All', title: 'Show every node' },
];

interface FlowViewState {
  view?: View;
  level?: Level;
  collapsed?: string[];
}

interface Crumb {
  id: string;
  title: string;
}

export interface PersistedState {
  flows: Record<string, FlowViewState>;
  trail: Crumb[];
  panelWidth: number;
  panelOpen: boolean;
}

export type Loadable<T> = { status: 'loading' } | { status: 'done'; value?: T; error?: string };

const DEFAULT_STATE: PersistedState = { flows: {}, trail: [], panelWidth: 360, panelOpen: true };

export function levelCollapsed(tree: GroupTree, level: Level): Set<string> {
  switch (level) {
    case 'modules':
      return collapseBelow(tree, 0);
    case 'folders':
      return collapseBelow(tree, 1);
    case 'files':
      return collapseBelow(tree, 2);
    default:
      return new Set();
  }
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && [...a].every((x) => b.has(x));

/** Keeps a selection only if what it points at still exists after a reload. */
function survives(sel: Selection | undefined, p: FlowPayload): Selection | undefined {
  if (!sel) return undefined;
  const f = p.flow;
  switch (sel.kind) {
    case 'node':
      return f.nodes.some((n) => n.id === sel.id) ? sel : undefined;
    case 'step':
      return f.steps.some((s) => s.id === sel.id) ? sel : undefined;
    case 'block':
      return f.blocks.some((b) => b.id === sel.id) ? sel : undefined;
    default:
      return undefined;
  }
}

export function App({ host }: { host: Host }) {
  const [persist, setPersist] = useState<PersistedState>(() => ({
    ...DEFAULT_STATE,
    ...host.getState<Partial<PersistedState>>(),
  }));
  const [payload, setPayload] = useState<FlowPayload>();
  const [missing, setMissing] = useState<string>();
  const [selection, setSelection] = useState<Selection>();
  const [snippets, setSnippets] = useState<Record<string, Loadable<Snippet>>>({});
  const [diffs, setDiffs] = useState<Record<string, Loadable<string>>>({});
  const pendingNav = useRef<string | undefined>(undefined);
  const payloadRef = useRef<FlowPayload | undefined>(undefined);

  useEffect(() => host.setState(persist), [host, persist]);

  useEffect(() => {
    const off = host.onMessage((m: HostMessage) => {
      switch (m.type) {
        case 'load': {
          const p = m.payload;
          const id = p.flow.meta.id;
          const prev = payloadRef.current;
          const reload = prev?.flow.meta.id === id;
          payloadRef.current = p;
          setPayload(p);
          setMissing(undefined);
          setSnippets({});
          setDiffs({});
          setSelection((sel) =>
            p.focus ? { kind: 'node', id: p.focus } : reload ? survives(sel, p) : undefined,
          );
          const expected = pendingNav.current === id;
          pendingNav.current = undefined;
          setPersist((s) => {
            let trail = s.trail;
            const at = trail.findIndex((c) => c.id === id);
            if (at >= 0) trail = trail.slice(0, at);
            else if (!reload && !expected) trail = [];
            let flows = s.flows;
            // Make sure the focused node is visible.
            const saved = s.flows[id];
            if (p.focus && saved?.collapsed) {
              const anc = new Set(ancestorsOf(buildGroups(p.flow.nodes, p.groups), p.focus));
              flows = {
                ...flows,
                [id]: { ...saved, collapsed: saved.collapsed.filter((g) => !anc.has(g)) },
              };
            }
            return { ...s, trail, flows };
          });
          break;
        }
        case 'missing':
          setMissing(m.flowId);
          break;
        case 'snippet':
          setSnippets((s) => ({
            ...s,
            [m.nodeId]: { status: 'done', value: m.snippet, error: m.error },
          }));
          break;
        case 'diff':
          setDiffs((s) => ({
            ...s,
            [m.nodeId]: { status: 'done', value: m.diff, error: m.error },
          }));
          break;
      }
    });
    host.post({ type: 'ready' });
    return off;
  }, [host]);

  const flowId = payload?.flow.meta.id;
  const tree = useMemo(() => payload && buildGroups(payload.flow.nodes, payload.groups), [payload]);
  const saved: FlowViewState = (flowId && persist.flows[flowId]) || {};
  const view: View = saved.view ?? 'flow';
  const defaultLevel: Level = (payload?.flow.nodes.length ?? 0) > 16 ? 'modules' : 'all';
  const level: Level = saved.level ?? defaultLevel;

  const savedCollapsed = saved.collapsed;
  const collapsed = useMemo<ReadonlySet<string>>(() => {
    if (!tree) return new Set();
    if (savedCollapsed) return new Set(savedCollapsed.filter((g) => tree.groups.has(g)));
    return levelCollapsed(tree, level);
  }, [tree, savedCollapsed, level]);

  // Several levels can collapse the same groups in shallow trees; prefer the one last chosen.
  const activeLevel = useMemo(() => {
    if (!tree) return undefined;
    const matches = LEVELS.filter((l) => sameSet(levelCollapsed(tree, l.level), collapsed));
    return matches.find((l) => l.level === level)?.level ?? matches[matches.length - 1]?.level;
  }, [tree, collapsed, level]);

  const updateFlow = useCallback(
    (patch: FlowViewState) => {
      if (!flowId) return;
      setPersist((s) => ({
        ...s,
        flows: { ...s.flows, [flowId]: { ...s.flows[flowId], ...patch } },
      }));
    },
    [flowId],
  );

  const onToggle = useCallback(
    (groupId: string) => {
      const next = new Set(collapsed);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      updateFlow({ collapsed: [...next] });
    },
    [collapsed, updateFlow],
  );

  const navigate = useCallback(
    (target: string, focus?: string) => {
      if (!payload) return;
      const here = { id: payload.flow.meta.id, title: payload.flow.meta.title };
      setPersist((s) => ({ ...s, trail: [...s.trail, here] }));
      pendingNav.current = target;
      host.post({ type: 'openFlow', flowId: target, focus });
    },
    [host, payload],
  );

  const goToCrumb = (i: number) => {
    const crumb = persist.trail[i]!;
    pendingNav.current = crumb.id;
    host.post({ type: 'openFlow', flowId: crumb.id });
  };

  // Ask the host for code and diffs of the selected node.
  useEffect(() => {
    if (!payload || selection?.kind !== 'node') return;
    const id = selection.id;
    const info = payload.anchors[id];
    if (!info || info.line === undefined) return;
    if (!snippets[id]) {
      setSnippets((s) => ({ ...s, [id]: { status: 'loading' } }));
      host.post({ type: 'requestSnippet', nodeId: id });
    }
    if (info.state === 'stale' && !diffs[id]) {
      setDiffs((s) => ({ ...s, [id]: { status: 'loading' } }));
      host.post({ type: 'requestDiff', nodeId: id });
    }
  }, [host, payload, selection, snippets, diffs]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setSelection(undefined);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = persist.panelWidth;
    const move = (ev: PointerEvent) => {
      const w = Math.min(Math.max(260, startW + startX - ev.clientX), window.innerWidth - 240);
      setPersist((s) => ({ ...s, panelWidth: Math.round(w) }));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  if (!payload || !tree) {
    return (
      <div className="fb-empty">
        {missing ? (
          <>
            <h2>Flow not found</h2>
            <p>
              <code>.flowbook/flows/{missing}.jsonl</code> does not exist or could not be parsed.
            </p>
          </>
        ) : (
          <p>Loading flow…</p>
        )}
      </div>
    );
  }

  const { flow } = payload;
  const errors = payload.diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = payload.diagnostics.length - errors;

  return (
    <div className="fb-app">
      <header className="fb-toolbar">
        <nav className="fb-crumbs" aria-label="Flow trail">
          {persist.trail.map((c, i) => (
            <span key={`${c.id}-${i}`} className="fb-crumb">
              <button className="fb-link" onClick={() => goToCrumb(i)} title={`Back to ${c.title}`}>
                {c.title}
              </button>
              <span className="fb-crumb__sep">›</span>
            </span>
          ))}
          <h1 className="fb-title" title={flow.meta.id}>
            {flow.meta.title}
          </h1>
        </nav>
        {missing && <span className="fb-chip fb-chip--error">Flow “{missing}” not found</span>}
        <div className="fb-toolbar__spacer" />
        <div className="fb-segmented" role="group" aria-label="Grouping level">
          {LEVELS.map((l) => (
            <button
              key={l.level}
              className={activeLevel === l.level ? 'is-active' : ''}
              title={l.title}
              onClick={() => updateFlow({ level: l.level, collapsed: undefined })}
            >
              {l.label}
            </button>
          ))}
        </div>
        <div className="fb-segmented" role="group" aria-label="View">
          <button
            className={view === 'flow' ? 'is-active' : ''}
            onClick={() => updateFlow({ view: 'flow' })}
          >
            Flowchart
          </button>
          <button
            className={view === 'sequence' ? 'is-active' : ''}
            onClick={() => updateFlow({ view: 'sequence' })}
          >
            Sequence
          </button>
        </div>
        {payload.diagnostics.length > 0 && (
          <button
            className={`fb-chip ${errors ? 'fb-chip--error' : 'fb-chip--warning'}`}
            title="Problems in this flow file — click to list"
            onClick={() => {
              setSelection(undefined);
              setPersist((s) => ({ ...s, panelOpen: true }));
            }}
          >
            {errors ? `${errors} error${errors > 1 ? 's' : ''}` : ''}
            {errors && warnings ? ' · ' : ''}
            {warnings ? `${warnings} warning${warnings > 1 ? 's' : ''}` : ''}
          </button>
        )}
        <button
          className="fb-button"
          title="Open the flow's JSONL file"
          onClick={() => host.post({ type: 'openFlowFile' })}
        >
          Open JSONL
        </button>
        <button
          className={`fb-icon-button${persist.panelOpen ? ' is-active' : ''}`}
          title={persist.panelOpen ? 'Hide details panel' : 'Show details panel'}
          aria-pressed={persist.panelOpen}
          onClick={() => setPersist((s) => ({ ...s, panelOpen: !s.panelOpen }))}
        >
          ◫
        </button>
      </header>
      <div className="fb-main">
        <div className="fb-canvas">
          <ErrorBoundary resetKey={`${flowId}:${view}`}>
            {view === 'flow' ? (
              <Flowchart
                payload={payload}
                tree={tree}
                collapsed={collapsed}
                selection={selection}
                onToggle={onToggle}
                onSelect={setSelection}
                onDrill={(id) => navigate(id)}
              />
            ) : (
              <SequenceView
                payload={payload}
                tree={tree}
                collapsed={collapsed}
                selection={selection}
                onToggle={onToggle}
                onSelect={setSelection}
              />
            )}
          </ErrorBoundary>
        </div>
        {persist.panelOpen && (
          <>
            <div className="fb-resizer" onPointerDown={startResize} title="Drag to resize" />
            <SidePanel
              width={persist.panelWidth}
              payload={payload}
              tree={tree}
              collapsed={collapsed}
              selection={selection}
              snippets={snippets}
              diffs={diffs}
              onSelect={setSelection}
              onNavigate={navigate}
              post={host.post}
            />
          </>
        )}
      </div>
    </div>
  );
}
