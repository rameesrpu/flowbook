/**
 * Everything the host computes from a Flowbook root that does not need VS Code: workspace
 * loading, anchor states, webview payloads, snippets, definition diffs and CodeLens targets.
 * Pure with respect to `vscode` so it can be unit-tested against the fixture.
 */
import {
  anchorKey,
  type AnchorInfo,
  type Diagnostic,
  type Flow,
  type FlowPayload,
  type Snippet,
  type UsageLink,
  type Workspace,
} from '@flowbook/core';
import {
  anchorDiagnostics,
  checkAnchors,
  readWorkspace,
  sourceReader,
  type AnchorStatus,
  type ReadSource,
  type Resolver,
  type SymbolInfo,
} from '@flowbook/resolver';
import { unifiedDiff } from './diff.js';

export interface RootState {
  /** Absolute path of the directory containing `.flowbook/`. */
  root: string;
  ws: Workspace;
  statuses: AnchorStatus[];
  /** Workspace diagnostics followed by anchor diagnostics. */
  diagnostics: Diagnostic[];
}

export function loadRoot(
  root: string,
  resolver: Resolver,
  read: ReadSource = sourceReader(root),
): RootState {
  const ws = readWorkspace(root);
  const statuses = checkAnchors(ws, read, resolver);
  return { root, ws, statuses, diagnostics: [...ws.diagnostics, ...anchorDiagnostics(statuses)] };
}

export const findFlow = (state: RootState, flowId: string): Flow | undefined =>
  state.ws.flows.find((f) => f.meta.id === flowId);

export function flowDiagnostics(state: RootState, flow: Flow): Diagnostic[] {
  return state.diagnostics.filter((d) => d.file === flow.file);
}

/** Errors plus stale anchors in a flow: what the tree view flags. */
export function problemCount(state: RootState, flow: Flow): number {
  const errors = flowDiagnostics(state, flow).filter((d) => d.severity === 'error').length;
  const stale = state.statuses.filter((s) => s.flow === flow && s.state === 'stale').length;
  return errors + stale;
}

function anchorInfo(s: AnchorStatus): AnchorInfo {
  if (s.state === 'fresh' || s.state === 'stale' || s.state === 'unstamped') {
    return { state: s.state, line: s.symbol.nameLine, symbol: s.symbol.symbol, sig: s.symbol.sig };
  }
  return { state: s.state };
}

export function buildPayload(
  state: RootState,
  flowId: string,
  focus?: string,
): FlowPayload | undefined {
  const flow = findFlow(state, flowId);
  if (!flow) return undefined;
  const { ws } = state;

  const anchors: Record<string, AnchorInfo> = {};
  for (const s of state.statuses) if (s.flow === flow) anchors[s.node.id] = anchorInfo(s);

  const flowTitles: Record<string, string> = {};
  for (const f of ws.flows) flowTitles[f.meta.id] = f.meta.title;

  const usages: Record<string, UsageLink[]> = {};
  for (const node of flow.nodes) {
    if (!node.anchor) continue;
    const list = (ws.usages.get(anchorKey(node.anchor)) ?? [])
      .filter((u) => u.flow !== flow.meta.id)
      .map((u) => {
        const other = findFlow(state, u.flow);
        return {
          flow: u.flow,
          flowTitle: other?.meta.title ?? u.flow,
          node: u.node,
          nodeTitle: other?.nodes.find((n) => n.id === u.node)?.title ?? u.node,
        };
      });
    if (list.length) usages[node.id] = list;
  }

  return {
    flow,
    groups: ws.config.groups,
    anchors,
    usages,
    flowTitles,
    diagnostics: flowDiagnostics(state, flow),
    ...(focus === undefined ? {} : { focus }),
  };
}

export const languageOf = (file: string): Snippet['language'] => (/\.c$/i.test(file) ? 'c' : 'cpp');

export const MAX_SNIPPET_LINES = 120;

/** The definition's source lines, capped at `maxLines` with a trailing truncation note. */
export function snippetOf(
  text: string,
  file: string,
  sym: SymbolInfo,
  maxLines = MAX_SNIPPET_LINES,
): Snippet {
  const lines = text.split(/\r?\n/).slice(sym.startLine, sym.endLine + 1);
  const shown = lines.slice(0, maxLines);
  if (lines.length > maxLines) {
    shown.push(`/* … ${lines.length - maxLines} more lines (open the file to see all) */`);
  }
  return { code: shown.join('\n'), startLine: sym.startLine, language: languageOf(file) };
}

/** The leaf of a qualified name: `net::EventLoop::run` → `run`. */
export const leafName = (symbol: string) => symbol.slice(symbol.lastIndexOf(':') + 1);

/** Column range of the symbol's leaf name on its name line, for selecting it in an editor. */
export function nameRange(
  text: string,
  sym: SymbolInfo,
): { line: number; start: number; end: number } {
  const lineText = text.split(/\r?\n/)[sym.nameLine] ?? '';
  const leaf = leafName(sym.symbol);
  const at = lineText.indexOf(leaf, sym.nameColumn);
  const start = at >= 0 ? at : sym.nameColumn;
  return { line: sym.nameLine, start, end: start + leaf.length };
}

export type DiffResult = { diff: string } | { error: string };

/**
 * Unified diff of an anchored definition between `oldText` (the file at the verified commit) and
 * `newText` (the current file). Line numbers in hunk headers are file line numbers.
 */
export function definitionDiff(
  resolver: Resolver,
  anchor: NonNullable<Flow['nodes'][number]['anchor']>,
  oldText: string,
  newText: string,
  commit: string,
): DiffResult {
  const short = commit.slice(0, 7);
  const before = resolver.resolve(anchor, oldText);
  if (before.status !== 'ok') {
    return {
      error:
        before.status === 'ambiguous'
          ? `${anchor.symbol} is ambiguous at ${short}`
          : `${anchor.symbol} does not exist in ${anchor.file} at ${short}`,
    };
  }
  const after = resolver.resolve(anchor, newText);
  if (after.status !== 'ok') {
    return {
      error:
        after.status === 'ambiguous'
          ? `${anchor.symbol} is ambiguous in the current ${anchor.file}`
          : `${anchor.symbol} no longer exists in ${anchor.file}`,
    };
  }
  const slice = (text: string, s: SymbolInfo) =>
    text.split(/\r?\n/).slice(s.startLine, s.endLine + 1);
  return {
    diff: unifiedDiff(slice(oldText, before.symbol), slice(newText, after.symbol), {
      oldStart: before.symbol.startLine + 1,
      newStart: after.symbol.startLine + 1,
    }),
  };
}

export interface LensTarget {
  symbol: SymbolInfo;
  usages: UsageLink[];
}

/** Definitions in `relFile` that some flow anchors, with the flows that use them. */
export function lensTargets(
  state: RootState,
  relFile: string,
  symbols: SymbolInfo[],
): LensTarget[] {
  const out: LensTarget[] = [];
  for (const sym of symbols) {
    const keys = new Set([
      anchorKey({ file: relFile, symbol: sym.symbol }),
      anchorKey({ file: relFile, symbol: sym.symbol, sig: sym.sig }),
    ]);
    const seen = new Set<string>();
    const usages: UsageLink[] = [];
    for (const key of keys) {
      for (const u of state.ws.usages.get(key) ?? []) {
        const id = `${u.flow}\0${u.node}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const flow = findFlow(state, u.flow);
        usages.push({
          flow: u.flow,
          flowTitle: flow?.meta.title ?? u.flow,
          node: u.node,
          nodeTitle: flow?.nodes.find((n) => n.id === u.node)?.title ?? u.node,
        });
      }
    }
    if (usages.length) out.push({ symbol: sym, usages });
  }
  return out;
}

/** Root directory for a `.flowbook/config.jsonl` or `.flowbook/flows/<id>.jsonl` path. */
export function rootOfFlowbookFile(path: string): string | undefined {
  const p = path.split('\\').join('/');
  const m = /^(.*)\/\.flowbook\/(?:config\.jsonl|flows\/[^/]+\.jsonl)$/.exec(p);
  return m ? m[1] || '/' : undefined;
}

/** The innermost root containing `file`, and the file's POSIX path relative to it. */
export function locate(
  roots: Iterable<string>,
  file: string,
): { root: string; rel: string } | undefined {
  const f = file.split('\\').join('/');
  let best: string | undefined;
  for (const r of roots) {
    const prefix = r.split('\\').join('/').replace(/\/$/, '') + '/';
    if (f.startsWith(prefix) && (!best || r.length > best.length)) best = r;
  }
  if (!best) return undefined;
  const prefix = best.split('\\').join('/').replace(/\/$/, '') + '/';
  return { root: best, rel: f.slice(prefix.length) };
}
