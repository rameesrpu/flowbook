import { anchorKey } from './anchor.js';
import { parseConfig, parseFlow, type Config, type Diagnostic, type Flow } from './parse.js';
import { validateFlow, validateWorkspace } from './validate.js';

export const FLOWBOOK_DIR = '.flowbook';
export const CONFIG_FILE = `${FLOWBOOK_DIR}/config.jsonl`;
export const FLOWS_DIR = `${FLOWBOOK_DIR}/flows`;

export interface SourceFile {
  /** Repo-relative path, e.g. ".flowbook/flows/login.jsonl". */
  path: string;
  text: string;
}

export interface Usage {
  flow: string;
  node: string;
}

export interface Workspace {
  config: Config;
  flows: Flow[];
  /** anchorKey → every node (across flows) anchored at that symbol. */
  usages: Map<string, Usage[]>;
  diagnostics: Diagnostic[];
}

/** Parses and validates a whole `.flowbook` directory given its file contents. */
export function loadWorkspace(config: SourceFile | undefined, flowFiles: SourceFile[]): Workspace {
  const diagnostics: Diagnostic[] = [];
  const cfg = config ? parseConfig(config.text, config.path, diagnostics) : { groups: [] };
  const flows: Flow[] = [];
  for (const f of flowFiles) {
    const flow = parseFlow(f.text, f.path, diagnostics);
    if (!flow) continue;
    flows.push(flow);
    diagnostics.push(...validateFlow(flow));
  }
  diagnostics.push(...validateWorkspace(flows));

  const usages = new Map<string, Usage[]>();
  for (const flow of flows) {
    for (const n of flow.nodes) {
      if (!n.anchor) continue;
      const key = anchorKey(n.anchor);
      usages.set(key, [...(usages.get(key) ?? []), { flow: flow.meta.id, node: n.id }]);
    }
  }
  return { config: cfg, flows, usages, diagnostics };
}
