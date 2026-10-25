import type {
  AnchorStateName,
  FlowPayload,
  GroupTree,
  Snippet,
  StepRecord,
  WebviewMessage,
} from '@flowbook/core';
import type { ReactNode } from 'react';
import type { Loadable } from './App';
import { useTokens } from './highlight';
import { Markdown, MarkdownInline } from './markdown';
import {
  agentPrompt,
  BLOCK_ICON,
  blocksOfStep,
  flowAgentPrompt,
  sortedSteps,
  STATE_INFO,
  STEP_TYPES,
  stepById,
} from './model';
import type { Selection } from './selection';

interface Props {
  width: number;
  payload: FlowPayload;
  tree: GroupTree;
  collapsed: ReadonlySet<string>;
  selection?: Selection;
  snippets: Record<string, Loadable<Snippet>>;
  diffs: Record<string, Loadable<string>>;
  onSelect: (s: Selection | undefined) => void;
  onNavigate: (flowId: string, focus?: string) => void;
  post: (m: WebviewMessage) => void;
}

type Ctx = Omit<Props, 'width' | 'selection'>;

export function SidePanel(props: Props) {
  const { selection, width, ...ctx } = props;
  let body: ReactNode;
  if (!selection) body = <Overview {...ctx} />;
  else if (selection.kind === 'node') body = <NodeDetails {...ctx} id={selection.id} />;
  else if (selection.kind === 'block') body = <BlockDetails {...ctx} id={selection.id} />;
  else if (selection.kind === 'step') body = <StepsDetails {...ctx} stepIds={[selection.id]} />;
  else body = <StepsDetails {...ctx} stepIds={selection.steps} />;
  return (
    <aside className="fb-panel" style={{ width }}>
      {selection && (
        <button className="fb-panel__back fb-link" onClick={() => props.onSelect(undefined)}>
          ‹ Flow overview
        </button>
      )}
      {body}
    </aside>
  );
}

function Section({
  title,
  children,
  extra,
}: {
  title: string;
  children: ReactNode;
  extra?: ReactNode;
}) {
  return (
    <section className="fb-section">
      <h3 className="fb-section__title">
        <span>{title}</span>
        {extra}
      </h3>
      {children}
    </section>
  );
}

function StatusDot({ state }: { state: AnchorStateName | 'external' }) {
  return <span className={`fb-status fb-status--${state}`} aria-hidden />;
}

function NodeLink({ ctx, id }: { ctx: Ctx; id: string }) {
  const n = ctx.payload.flow.nodes.find((x) => x.id === id);
  return (
    <button className="fb-link" onClick={() => ctx.onSelect({ kind: 'node', id })} title={id}>
      {n?.title ?? id}
    </button>
  );
}

function CopyButton({ ctx, text, label }: { ctx: Ctx; text: string; label: string }) {
  return (
    <button
      className="fb-button fb-button--primary"
      title={text}
      onClick={() => ctx.post({ type: 'copy', text })}
    >
      {label}
    </button>
  );
}

// --- Flow overview ----------------------------------------------------------------------------

function Overview(ctx: Ctx) {
  const { flow, diagnostics, anchors } = ctx.payload;
  const steps = sortedSteps(flow);
  const attention = flow.nodes.filter((n) => anchors[n.id] && anchors[n.id]!.state !== 'fresh');
  const prompt = flowAgentPrompt(flow, anchors);
  return (
    <div className="fb-panel__body">
      <div className="fb-panel__head">
        <div className="fb-eyebrow">Flow</div>
        <h2>{flow.meta.title}</h2>
        {flow.meta.tags && flow.meta.tags.length > 0 && (
          <div className="fb-tags">
            {flow.meta.tags.map((t) => (
              <span key={t} className="fb-tag">
                {t}
              </span>
            ))}
          </div>
        )}
      </div>
      {flow.meta.summary && <Markdown text={flow.meta.summary} />}
      <p className="fb-muted fb-small">
        {flow.nodes.length} nodes · {flow.steps.length} steps
        {flow.blocks.length ? ` · ${flow.blocks.length} blocks` : ''}
      </p>

      {attention.length > 0 && (
        <Section title="Needs attention">
          <ul className="fb-list">
            {attention.map((n) => (
              <li key={n.id}>
                <button className="fb-row" onClick={() => ctx.onSelect({ kind: 'node', id: n.id })}>
                  <StatusDot state={anchors[n.id]!.state} />
                  <span className="fb-row__main">{n.title}</span>
                  <span className="fb-muted fb-small">
                    {STATE_INFO[anchors[n.id]!.state].label}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {prompt && <CopyButton ctx={ctx} text={prompt} label="Copy agent prompt" />}
        </Section>
      )}

      {diagnostics.length > 0 && (
        <Section title={`Problems (${diagnostics.length})`}>
          <ul className="fb-list">
            {diagnostics.map((d, i) => (
              <li key={i}>
                <button
                  className="fb-row"
                  onClick={() => ctx.post({ type: 'openFlowFile', line: d.line })}
                  title="Open the flow file at this line"
                >
                  <span className={`fb-sev fb-sev--${d.severity}`}>
                    {d.severity === 'error' ? '✕' : '!'}
                  </span>
                  <span className="fb-row__main">{d.message}</span>
                  {d.line !== undefined && <span className="fb-muted fb-small">line {d.line}</span>}
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {flow.blocks.length > 0 && (
        <Section title="Blocks">
          <ul className="fb-list">
            {flow.blocks.map((b) => (
              <li key={b.id}>
                <button
                  className="fb-row"
                  onClick={() => ctx.onSelect({ kind: 'block', id: b.id })}
                >
                  <span className={`fb-block-icon fb-block-icon--${b.type}`}>
                    {BLOCK_ICON[b.type]}
                  </span>
                  <span className="fb-row__main">{b.label}</span>
                  <span className="fb-muted fb-small">
                    {b.type} · {b.steps.length} steps
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Steps">
        <StepList ctx={ctx} steps={steps} />
      </Section>

      <Section title="Legend">
        <Legend />
      </Section>
    </div>
  );
}

function Legend() {
  return (
    <div className="fb-legend">
      <ul className="fb-legend__edges">
        {STEP_TYPES.map((t) => (
          <li key={t.type} title={t.hint}>
            <svg width="44" height="10" aria-hidden>
              <line x1="2" y1="5" x2="34" y2="5" className={`fb-line fb-line--${t.type}`} />
              <path d="M 33 1 L 41 5 L 33 9" className={`fb-head fb-head--${t.type}`} />
            </svg>
            <span>{t.label}</span>
            <span className="fb-muted fb-small">{t.hint}</span>
          </li>
        ))}
      </ul>
      <ul className="fb-legend__states">
        {(['fresh', 'stale', 'unstamped', 'missing', 'ambiguous'] as const).map((s) => (
          <li key={s}>
            <span>
              <StatusDot state={s} />
            </span>
            <span>{STATE_INFO[s].label}</span>
          </li>
        ))}
        <li>
          <span className="fb-legend__entry">▶</span>
          <span>Entry point</span>
        </li>
        <li>
          <span>↻ ◇ ∥</span>
          <span>Step inside a loop / alt / par block</span>
        </li>
      </ul>
    </div>
  );
}

function StepList({ ctx, steps }: { ctx: Ctx; steps: StepRecord[] }) {
  const title = (id: string) => ctx.payload.flow.nodes.find((n) => n.id === id)?.title ?? id;
  return (
    <ol className="fb-steps">
      {steps.map((s) => (
        <li key={s.id}>
          <button className="fb-step" onClick={() => ctx.onSelect({ kind: 'step', id: s.id })}>
            <span className="fb-step__seq">{s.seq}</span>
            <span className="fb-step__main">
              <span className="fb-step__ends">
                {title(s.from)} <span className={`fb-arrow fb-arrow--${s.type}`}>→</span>{' '}
                {title(s.to)}
              </span>
              <span className="fb-step__label">
                {s.guard && <span className="fb-guard">[{s.guard}]</span>} {s.label}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}

// --- Node -------------------------------------------------------------------------------------

function NodeDetails({ id, ...ctx }: Ctx & { id: string }) {
  const { flow, anchors, usages, flowTitles } = ctx.payload;
  const node = flow.nodes.find((n) => n.id === id);
  if (!node) return <div className="fb-panel__body fb-muted">Node “{id}” is not in this flow.</div>;
  const info = anchors[id];
  const anchor = node.anchor;
  const state: AnchorStateName | 'external' = anchor ? (info?.state ?? 'unstamped') : 'external';
  const prompt =
    state !== 'external' && state !== 'fresh' ? agentPrompt(flow, id, state) : undefined;
  const others = (usages[id] ?? []).filter((u) => !(u.flow === flow.meta.id && u.node === id));
  const touching = sortedSteps(flow).filter((s) => s.from === id || s.to === id);
  const line = info?.line;

  return (
    <div className="fb-panel__body">
      <div className="fb-panel__head">
        <div className="fb-eyebrow">
          {flow.meta.entry === id ? 'Entry node' : anchor ? 'Node' : 'External actor'}
        </div>
        <h2>{node.title}</h2>
        {anchor && (
          <>
            <code className="fb-symbol">
              {anchor.symbol}
              {anchor.sig && <span className="fb-muted">{anchor.sig}</span>}
            </code>
            <button
              className="fb-link fb-file"
              onClick={() => ctx.post({ type: 'openCode', nodeId: id })}
              title="Open in editor"
            >
              {anchor.file}
              {line !== undefined ? `:${line + 1}` : ''}
            </button>
          </>
        )}
      </div>

      <div className={`fb-state fb-state--${state}`}>
        <StatusDot state={state} />
        <div>
          <strong>{state === 'external' ? 'Not anchored to code' : STATE_INFO[state].label}</strong>
          <p>
            {state === 'external' ? (
              'This is an outside actor (kernel, peer, user …), so there is no code to check.'
            ) : (
              <MarkdownInline text={STATE_INFO[state].explain} />
            )}
            {node.verified && state !== 'external' && (
              <span className="fb-muted">
                {' '}
                Verified at <code>{node.verified.slice(0, 8)}</code>.
              </span>
            )}
          </p>
          {prompt && <CopyButton ctx={ctx} text={prompt} label="Copy agent prompt" />}
        </div>
      </div>

      {node.notes && (
        <Section title="Notes">
          <Markdown text={node.notes} />
        </Section>
      )}

      {node.flow && (
        <Section title="Details">
          <button className="fb-row fb-row--accent" onClick={() => ctx.onNavigate(node.flow!)}>
            <span>⤵</span>
            <span className="fb-row__main">{flowTitles[node.flow] ?? node.flow}</span>
            <span className="fb-muted fb-small">open flow</span>
          </button>
        </Section>
      )}

      {anchor && (
        <Section title="Code">
          <SnippetView
            ctx={ctx}
            id={id}
            state={ctx.snippets[id]}
            line={line}
            resolved={line !== undefined}
          />
        </Section>
      )}

      {state === 'stale' && (
        <Section title="Changed since verified">
          <DiffView state={ctx.diffs[id]} />
        </Section>
      )}

      {others.length > 0 && (
        <Section title="Also in other flows">
          <ul className="fb-list">
            {others.map((u) => (
              <li key={`${u.flow}/${u.node}`}>
                <button className="fb-row" onClick={() => ctx.onNavigate(u.flow, u.node)}>
                  <span className="fb-row__main">{u.flowTitle}</span>
                  <span className="fb-muted fb-small">as “{u.nodeTitle}”</span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {touching.length > 0 && (
        <Section title="Steps">
          <StepList ctx={ctx} steps={touching} />
        </Section>
      )}
    </div>
  );
}

function SnippetView({
  ctx,
  id,
  state,
  line,
  resolved,
}: {
  ctx: Ctx;
  id: string;
  state?: Loadable<Snippet>;
  line?: number;
  resolved: boolean;
}) {
  const snippet = state?.status === 'done' ? state.value : undefined;
  const tokens = useTokens(snippet?.code, snippet?.language ?? 'cpp');
  if (!resolved)
    return (
      <p className="fb-muted fb-small">The anchor does not resolve, so there is no code to show.</p>
    );
  if (!state || state.status === 'loading')
    return <p className="fb-muted fb-small">Loading code…</p>;
  if (!snippet) return <p className="fb-muted fb-small">{state.error ?? 'No code available.'}</p>;
  const lines: { content: string; color?: string }[][] =
    tokens ?? snippet.code.split('\n').map((l) => [{ content: l }]);
  return (
    <div
      className="fb-code"
      role="button"
      tabIndex={0}
      title="Open in editor"
      onClick={() => ctx.post({ type: 'openCode', nodeId: id })}
    >
      <pre>
        {lines.map((toks, i) => {
          const n = snippet.startLine + i;
          return (
            <div key={i} className={`fb-code__line${n === line ? ' is-anchor' : ''}`}>
              <span className="fb-code__num">{n + 1}</span>
              <span>
                {toks.map((t, j) => (
                  <span key={j} style={t.color ? { color: t.color } : undefined}>
                    {t.content}
                  </span>
                ))}
                {toks.length === 0 && ' '}
              </span>
            </div>
          );
        })}
      </pre>
    </div>
  );
}

function DiffView({ state }: { state?: Loadable<string> }) {
  if (!state || state.status === 'loading')
    return <p className="fb-muted fb-small">Loading diff…</p>;
  if (!state.value)
    return <p className="fb-muted fb-small">{state.error ?? 'No diff available.'}</p>;
  const lines = state.value.replace(/\n$/, '').split('\n');
  return (
    <div className="fb-code fb-diff">
      <pre>
        {lines.map((l, i) => {
          const cls = /^(diff |index |--- |\+\+\+ )/.test(l)
            ? 'meta'
            : l.startsWith('@@')
              ? 'hunk'
              : l.startsWith('+')
                ? 'add'
                : l.startsWith('-')
                  ? 'del'
                  : 'ctx';
          return (
            <div key={i} className={`fb-diff__line fb-diff__line--${cls}`}>
              {l || ' '}
            </div>
          );
        })}
      </pre>
    </div>
  );
}

// --- Steps and blocks -------------------------------------------------------------------------

function StepsDetails({ stepIds, ...ctx }: Ctx & { stepIds: string[] }) {
  const { flow } = ctx.payload;
  const steps = stepIds
    .map((s) => stepById(flow, s))
    .filter((s): s is NonNullable<typeof s> => !!s)
    .sort((a, b) => a.seq - b.seq);
  if (steps.length === 0) return <div className="fb-panel__body fb-muted">Nothing selected.</div>;
  if (steps.length > 1) {
    return (
      <div className="fb-panel__body">
        <div className="fb-panel__head">
          <div className="fb-eyebrow">Combined edge</div>
          <h2>{steps.length} steps</h2>
          <p className="fb-muted fb-small">
            These steps cross a collapsed group, so they are drawn as one edge. Expand the group to
            see them separately.
          </p>
        </div>
        <StepList ctx={ctx} steps={steps} />
      </div>
    );
  }
  const s = steps[0]!;
  const blocks = blocksOfStep(flow, s.id);
  const type = STEP_TYPES.find((t) => t.type === s.type)!;
  return (
    <div className="fb-panel__body">
      <div className="fb-panel__head">
        <div className="fb-eyebrow">Step {s.seq}</div>
        <h2>{s.label}</h2>
      </div>
      <dl className="fb-props">
        <dt>From</dt>
        <dd>
          <NodeLink ctx={ctx} id={s.from} />
        </dd>
        <dt>To</dt>
        <dd>
          <NodeLink ctx={ctx} id={s.to} />
        </dd>
        <dt>Type</dt>
        <dd>
          <span className={`fb-arrow fb-arrow--${s.type}`}>→</span> {type.label}{' '}
          <span className="fb-muted fb-small">— {type.hint}</span>
        </dd>
        {s.guard && (
          <>
            <dt>Only if</dt>
            <dd>
              <span className="fb-guard">[{s.guard}]</span>
            </dd>
          </>
        )}
        {blocks.length > 0 && (
          <>
            <dt>Inside</dt>
            <dd>
              {blocks.map((b) => (
                <div key={b.id}>
                  <button
                    className="fb-link"
                    onClick={() => ctx.onSelect({ kind: 'block', id: b.id })}
                  >
                    {BLOCK_ICON[b.type]} {b.type}: {b.label}
                  </button>
                </div>
              ))}
            </dd>
          </>
        )}
      </dl>
      {s.notes && (
        <Section title="Notes">
          <Markdown text={s.notes} />
        </Section>
      )}
      <div className="fb-nav-steps">
        <PrevNext ctx={ctx} seq={s.seq} />
      </div>
    </div>
  );
}

function PrevNext({ ctx, seq }: { ctx: Ctx; seq: number }) {
  const steps = sortedSteps(ctx.payload.flow);
  const i = steps.findIndex((s) => s.seq === seq);
  const prev = steps[i - 1];
  const next = steps[i + 1];
  return (
    <>
      <button
        className="fb-button"
        disabled={!prev}
        onClick={() => prev && ctx.onSelect({ kind: 'step', id: prev.id })}
      >
        ‹ Step {prev?.seq ?? ''}
      </button>
      <button
        className="fb-button"
        disabled={!next}
        onClick={() => next && ctx.onSelect({ kind: 'step', id: next.id })}
      >
        Step {next?.seq ?? ''} ›
      </button>
    </>
  );
}

function BlockDetails({ id, ...ctx }: Ctx & { id: string }) {
  const { flow } = ctx.payload;
  const block = flow.blocks.find((b) => b.id === id);
  if (!block)
    return <div className="fb-panel__body fb-muted">Block “{id}” is not in this flow.</div>;
  const steps = block.steps
    .map((s) => stepById(flow, s))
    .filter((s): s is NonNullable<typeof s> => !!s)
    .sort((a, b) => a.seq - b.seq);
  const meaning = {
    loop: 'These steps repeat.',
    alt: 'These steps happen only in this case.',
    par: 'These steps run concurrently.',
  }[block.type];
  return (
    <div className="fb-panel__body">
      <div className="fb-panel__head">
        <div className="fb-eyebrow">
          {BLOCK_ICON[block.type]} {block.type} block
        </div>
        <h2>{block.label}</h2>
        <p className="fb-muted fb-small">{meaning}</p>
      </div>
      <StepList ctx={ctx} steps={steps} />
    </div>
  );
}
