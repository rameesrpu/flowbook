import type { Diagnostic, Flow, Located, NodeRecord, Workspace } from '@flowbook/core';
import type { Resolver } from './resolver.js';
import type { SymbolInfo } from './symbols.js';

export type AnchorState =
  | { state: 'fresh' | 'stale' | 'unstamped'; symbol: SymbolInfo }
  | { state: 'missing-file' }
  | { state: 'missing'; suggestions: SymbolInfo[] }
  | { state: 'ambiguous'; candidates: SymbolInfo[] };

export type AnchorStatus = AnchorState & { flow: Flow; node: Located<NodeRecord> };

/** Reads a repo-relative source file, or returns undefined if it does not exist. */
export type ReadSource = (path: string) => string | undefined;

/** Resolves every anchored node in the workspace and compares fingerprints. */
export function checkAnchors(
  ws: Workspace,
  readSource: ReadSource,
  resolver: Resolver,
): AnchorStatus[] {
  const symbolsByFile = new Map<string, SymbolInfo[] | undefined>();
  const symbols = (file: string) => {
    if (!symbolsByFile.has(file)) {
      const text = readSource(file);
      symbolsByFile.set(file, text === undefined ? undefined : resolver.listSymbols(file, text));
    }
    return symbolsByFile.get(file);
  };
  const out: AnchorStatus[] = [];
  for (const flow of ws.flows) {
    for (const node of flow.nodes) {
      if (!node.anchor) continue;
      const syms = symbols(node.anchor.file);
      if (!syms) {
        out.push({ flow, node, state: 'missing-file' });
        continue;
      }
      const r = resolver.match(node.anchor, syms);
      if (r.status === 'ok') {
        const state =
          node.fp === undefined ? 'unstamped' : node.fp === r.symbol.fp ? 'fresh' : 'stale';
        out.push({ flow, node, state, symbol: r.symbol });
      } else if (r.status === 'ambiguous') {
        out.push({ flow, node, state: 'ambiguous', candidates: r.candidates });
      } else out.push({ flow, node, state: 'missing', suggestions: r.suggestions });
    }
  }
  return out;
}

const describe = (s: SymbolInfo) => `${s.symbol}${s.sig} (line ${s.nameLine + 1})`;

export function anchorDiagnostics(statuses: AnchorStatus[], strictStale = false): Diagnostic[] {
  const out: Diagnostic[] = [];
  const unstamped = new Map<Flow, string[]>();
  for (const s of statuses) {
    const base = { file: s.flow.file, line: s.node.line, id: s.node.id };
    const anchor = `${s.node.anchor!.file}#${s.node.anchor!.symbol}${s.node.anchor!.sig ?? ''}`;
    switch (s.state) {
      case 'fresh':
        break;
      case 'stale':
        out.push({
          ...base,
          severity: strictStale ? 'error' : 'warning',
          message: `stale: ${anchor} changed since it was verified${s.node.verified ? ` at ${s.node.verified.slice(0, 7)}` : ''}; review the node and steps, then run \`flowbook stamp ${s.flow.meta.id}\``,
        });
        break;
      case 'unstamped':
        unstamped.set(s.flow, [...(unstamped.get(s.flow) ?? []), s.node.id]);
        break;
      case 'missing-file':
        out.push({
          ...base,
          severity: 'error',
          message: `source file not found: ${s.node.anchor!.file}`,
        });
        break;
      case 'missing': {
        const hint = s.suggestions.length
          ? `; did you mean ${s.suggestions.slice(0, 3).map(describe).join(', ')}?`
          : `; run \`flowbook resolve ${s.node.anchor!.file}\` to list symbols`;
        out.push({ ...base, severity: 'error', message: `no definition for ${anchor}${hint}` });
        break;
      }
      case 'ambiguous':
        out.push({
          ...base,
          severity: 'error',
          message: `${anchor} is overloaded; add "sig" with one of: ${s.candidates.map((c) => c.sig).join(' | ')}`,
        });
        break;
    }
  }
  for (const [flow, ids] of unstamped) {
    out.push({
      file: flow.file,
      line: flow.meta.line,
      id: flow.meta.id,
      severity: 'warning',
      message: `${ids.length} node(s) not stamped (${ids.join(', ')}): run \`flowbook stamp ${flow.meta.id}\``,
    });
  }
  return out;
}
