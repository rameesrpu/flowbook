import type { Diagnostic, Flow } from './parse.js';
import type { GroupRecord } from './schema.js';

/** Messages between the extension host and the flow webview. Types only; no runtime code. */

export type AnchorStateName =
  'fresh' | 'stale' | 'unstamped' | 'missing-file' | 'missing' | 'ambiguous';

export interface AnchorInfo {
  state: AnchorStateName;
  /** 0-based line of the symbol's name, when it resolved. */
  line?: number;
  /** Resolved qualified symbol and signature, when it resolved. */
  symbol?: string;
  sig?: string;
}

export interface UsageLink {
  flow: string;
  flowTitle: string;
  node: string;
  nodeTitle: string;
}

export interface FlowPayload {
  flow: Flow;
  groups: GroupRecord[];
  /** Per node id. Unanchored nodes are absent. */
  anchors: Record<string, AnchorInfo>;
  /** Per node id: the same symbol in other flows. */
  usages: Record<string, UsageLink[]>;
  /** Titles of every flow in the workspace, for drill-down links and breadcrumbs. */
  flowTitles: Record<string, string>;
  diagnostics: Diagnostic[];
  /** Node to select after loading, e.g. when arriving from "used in other flows". */
  focus?: string;
}

export interface Snippet {
  code: string;
  /** 0-based line of the first line of `code`. */
  startLine: number;
  language: 'c' | 'cpp';
}

export type HostMessage =
  | { type: 'load'; payload: FlowPayload }
  | { type: 'missing'; flowId: string }
  | { type: 'snippet'; nodeId: string; snippet?: Snippet; error?: string }
  | { type: 'diff'; nodeId: string; diff?: string; error?: string };

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'openFlow'; flowId: string; focus?: string }
  | { type: 'openCode'; nodeId: string }
  /** `line` is 1-based, like record and diagnostic lines. */
  | { type: 'openFlowFile'; line?: number }
  | { type: 'requestSnippet'; nodeId: string }
  | { type: 'requestDiff'; nodeId: string }
  | { type: 'copy'; text: string }
  /** An uncaught error in the webview, reported so the host can log it. */
  | { type: 'error'; message: string };
