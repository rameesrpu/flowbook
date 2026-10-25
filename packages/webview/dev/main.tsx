/**
 * Standalone harness: renders the webview against the fixture workspace with a fake host.
 * URL params: ?flow=<id>&view=flow|sequence&level=modules|folders|files|all&select=<nodeId>
 *             &theme=light|dark&diag=1
 */
import { createRoot } from 'react-dom/client';
import {
  anchorKey,
  loadWorkspace,
  type AnchorInfo,
  type Flow,
  type FlowPayload,
  type HostMessage,
  type NodeRecord,
  type Snippet,
  type WebviewMessage,
} from '@flowbook/core';
import { App, type Level, type PersistedState, type View } from '../src/App';
import type { Host } from '../src/host';
import { applyTheme } from './theme';

const flowbookFiles = import.meta.glob('../../../fixtures/cpp-sample/.flowbook/**/*.jsonl', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const sourceFiles = import.meta.glob('../../../fixtures/cpp-sample/src/**/*.{c,cpp,h,hpp}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const rel = (key: string) => key.replace(/^.*fixtures\/cpp-sample\//, '');
const files = Object.entries(flowbookFiles).map(([k, text]) => ({ path: rel(k), text }));
const sources = new Map(Object.entries(sourceFiles).map(([k, text]) => [rel(k), text]));

const ws = loadWorkspace(
  files.find((f) => f.path.endsWith('config.jsonl')),
  files.filter((f) => f.path.includes('/flows/')),
);

const params = new URLSearchParams(location.search);
applyTheme(params.get('theme') === 'dark' ? 'dark' : 'light');

// --- Fake anchor resolution: find the symbol by regex instead of tree-sitter. ---------------

function findSymbol(node: NodeRecord): { line: number; start: number; end: number } | undefined {
  const a = node.anchor;
  if (!a) return undefined;
  const text = sources.get(a.file);
  if (!text) return undefined;
  const lines = text.split('\n');
  const parts = a.symbol.split('::');
  const name = parts[parts.length - 1]!;
  const owner = parts.length > 1 ? parts[parts.length - 2] : undefined;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const firstParam = a.sig?.match(/\(\s*([A-Za-z_]+)/)?.[1];
  const patterns = [
    new RegExp(`#define\\s+${esc(name)}\\b`),
    owner ? new RegExp(`\\b${esc(owner)}::${esc(name)}\\s*\\(`) : undefined,
    new RegExp(`\\b${esc(name)}\\s*(<[^>]*>)?\\s*\\([^;]*$`),
    new RegExp(`\\b${esc(name)}\\s*\\(.*\\{`),
  ].filter((r): r is RegExp => !!r);
  let line = -1;
  for (const re of patterns) {
    line = lines.findIndex((l) => re.test(l) && (!firstParam || l.includes(firstParam)));
    if (line >= 0) break;
  }
  if (line < 0) return undefined;
  // Extend to the end of the body (or macro).
  let start = line;
  if (start > 0 && /^\s*template\b/.test(lines[start - 1]!)) start--;
  let end = line;
  if (lines[line]!.startsWith('#define')) {
    while (end < lines.length - 1 && lines[end]!.trimEnd().endsWith('\\')) end++;
  } else {
    let depth = 0;
    let opened = false;
    for (let i = line; i < lines.length; i++) {
      for (const ch of lines[i]!) {
        if (ch === '{') {
          depth++;
          opened = true;
        }
        if (ch === '}') depth--;
      }
      end = i;
      if (opened && depth <= 0) break;
      if (!opened && lines[i]!.includes(';')) break;
    }
  }
  return { line, start, end };
}

const STALE = 'packet-handling/valid-type';
const UNSTAMPED = 'startup/add-timer';

function anchorsOf(flow: Flow): Record<string, AnchorInfo> {
  const out: Record<string, AnchorInfo> = {};
  for (const n of flow.nodes) {
    if (!n.anchor) continue;
    const found = findSymbol(n);
    const key = `${flow.meta.id}/${n.id}`;
    out[n.id] = found
      ? {
          state: key === STALE ? 'stale' : key === UNSTAMPED ? 'unstamped' : 'fresh',
          line: found.line,
          symbol: n.anchor.symbol,
          sig: n.anchor.sig,
        }
      : { state: 'missing' };
  }
  return out;
}

function payloadFor(flowId: string, focus?: string): FlowPayload | undefined {
  const flow = ws.flows.find((f) => f.meta.id === flowId);
  if (!flow) return undefined;
  const usages: FlowPayload['usages'] = {};
  for (const n of flow.nodes) {
    if (!n.anchor) continue;
    const others = (ws.usages.get(anchorKey(n.anchor)) ?? []).filter((u) => u.flow !== flowId);
    if (others.length === 0) continue;
    usages[n.id] = others.map((u) => {
      const f = ws.flows.find((x) => x.meta.id === u.flow)!;
      return {
        flow: u.flow,
        flowTitle: f.meta.title,
        node: u.node,
        nodeTitle: f.nodes.find((x) => x.id === u.node)?.title ?? u.node,
      };
    });
  }
  const diagnostics = ws.diagnostics.filter((d) => d.file === flow.file);
  if (params.get('diag') === '1') {
    diagnostics.push(
      {
        severity: 'warning',
        file: flow.file,
        line: 3,
        message: 'Step seq 4 is missing (gap after 3)',
      },
      {
        severity: 'error',
        file: flow.file,
        line: 7,
        id: 'x',
        message: 'Step "s9" refers to unknown node "halt"',
      },
    );
  }
  return {
    flow,
    groups: ws.config.groups,
    anchors: anchorsOf(flow),
    usages,
    flowTitles: Object.fromEntries(ws.flows.map((f) => [f.meta.id, f.meta.title])),
    diagnostics,
    focus,
  };
}

function snippetFor(flowId: string, nodeId: string): Snippet | undefined {
  const flow = ws.flows.find((f) => f.meta.id === flowId);
  const node = flow?.nodes.find((n) => n.id === nodeId);
  if (!node?.anchor) return undefined;
  const found = findSymbol(node);
  if (!found) return undefined;
  const lines = sources.get(node.anchor.file)!.split('\n');
  const from = Math.max(0, found.start - 2);
  const to = Math.min(lines.length - 1, found.end + 2);
  return {
    code: lines.slice(from, to + 1).join('\n'),
    startLine: from,
    language: /\.(c|h)$/.test(node.anchor.file) ? 'c' : 'cpp',
  };
}

const CANNED_DIFF = `diff --git a/src/proto/parser.cpp b/src/proto/parser.cpp
--- a/src/proto/parser.cpp
+++ b/src/proto/parser.cpp
@@ -8,3 +8,6 @@ namespace {
-bool valid_type(uint16_t type) { return type < 16; }
+bool valid_type(uint16_t type) {
+  // Types 16..31 are reserved for extensions since protocol v2.
+  return type < 16 || (type >= 16 && type < 32 && g_extensions_enabled);
+}
 } // namespace
`;

// --- Mock host --------------------------------------------------------------------------------

function toast(text: string) {
  const el = document.createElement('div');
  el.textContent = text;
  el.style.cssText =
    'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:99;padding:6px 12px;border-radius:4px;' +
    'background:var(--vscode-notifications-background,#333);color:var(--vscode-notifications-foreground,#fff);' +
    'font:12px var(--vscode-font-family,sans-serif);box-shadow:0 2px 8px rgba(0,0,0,.3);max-width:80vw';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

function mockHost(): Host {
  const listeners = new Set<(m: HostMessage) => void>();
  const send = (m: HostMessage, delay = 30) =>
    setTimeout(() => listeners.forEach((l) => l(m)), delay);
  let current = params.get('flow') ?? 'startup';
  const initialFocus = params.get('select') ?? undefined;

  const view = params.get('view') === 'sequence' ? 'sequence' : 'flow';
  const level = params.get('level') as Level | null;
  let state: PersistedState | undefined = {
    flows: { [current]: { view: view as View, ...(level ? { level } : {}) } },
    trail: [],
    panelWidth: 360,
    panelOpen: params.get('panel') !== '0',
  };

  const load = (flowId: string, focus?: string) => {
    const payload = payloadFor(flowId, focus);
    if (payload) {
      current = flowId;
      send({ type: 'load', payload });
    } else send({ type: 'missing', flowId });
  };

  const handle = (m: WebviewMessage) => {
    switch (m.type) {
      case 'ready':
        return load(current, initialFocus);
      case 'openFlow':
        return load(m.flowId, m.focus);
      case 'requestSnippet': {
        const snippet = snippetFor(current, m.nodeId);
        return send(
          snippet
            ? { type: 'snippet', nodeId: m.nodeId, snippet }
            : { type: 'snippet', nodeId: m.nodeId, error: 'Could not read the source file.' },
          120,
        );
      }
      case 'requestDiff':
        return send({ type: 'diff', nodeId: m.nodeId, diff: CANNED_DIFF }, 160);
      case 'openCode': {
        const flow = ws.flows.find((f) => f.meta.id === current)!;
        const n = flow.nodes.find((x) => x.id === m.nodeId);
        const line = n ? findSymbol(n)?.line : undefined;
        return toast(`openCode → ${n?.anchor?.file}:${(line ?? 0) + 1}`);
      }
      case 'openFlowFile':
        return toast(
          `openFlowFile → .flowbook/flows/${current}.jsonl${m.line ? `:${m.line}` : ''}`,
        );
      case 'copy':
        void navigator.clipboard?.writeText(m.text).catch(() => undefined);
        return toast('Copied agent prompt to clipboard');
    }
  };

  return {
    post: (m) => {
      console.debug('[webview → host]', m);
      handle(m);
    },
    onMessage(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getState: <T,>() => state as T | undefined,
    setState: (s) => {
      state = s as PersistedState;
    },
  };
}

createRoot(document.getElementById('root')!).render(<App host={mockHost()} />);
