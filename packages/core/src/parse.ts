import type { z } from 'zod';
import {
  ConfigFileRecord,
  FlowFileRecord,
  type BlockRecord,
  type FlowRecord,
  type GroupRecord,
  type NodeRecord,
  type StepRecord,
} from './schema.js';

export interface Diagnostic {
  severity: 'error' | 'warning';
  message: string;
  /** Path of the file the diagnostic belongs to, as given to the parser. */
  file?: string;
  /** 1-based line number. */
  line?: number;
  /** Id of the record the diagnostic is about. */
  id?: string;
}

/** A record together with the line it was read from. */
export type Located<T> = T & { line: number };

export interface Flow {
  file: string;
  meta: Located<FlowRecord>;
  nodes: Located<NodeRecord>[];
  steps: Located<StepRecord>[];
  blocks: Located<BlockRecord>[];
}

export interface Config {
  groups: Located<GroupRecord>[];
}

function parseLines<S extends z.ZodType>(
  text: string,
  file: string,
  schema: S,
  diagnostics: Diagnostic[],
): Located<z.infer<S>>[] {
  const records: Located<z.infer<S>>[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    if (raw.trim() === '') return;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (e) {
      diagnostics.push({
        severity: 'error',
        file,
        line,
        message: `invalid JSON: ${(e as Error).message}`,
      });
      return;
    }
    const result = schema.safeParse(json);
    if (!result.success) {
      const id = (json as { id?: unknown })?.id;
      for (const issue of result.error.issues) {
        const where = issue.path.length ? `${issue.path.join('.')}: ` : '';
        diagnostics.push({
          severity: 'error',
          file,
          line,
          id: typeof id === 'string' ? id : undefined,
          message: where + issue.message,
        });
      }
      return;
    }
    records.push({ ...(result.data as object), line } as Located<z.infer<S>>);
  });
  return records;
}

/**
 * Parses a flow file. Returns `undefined` when the file has no valid `flow` record;
 * schema problems are reported in `diagnostics` and the offending lines are skipped.
 */
export function parseFlow(
  text: string,
  file: string,
  diagnostics: Diagnostic[] = [],
): Flow | undefined {
  const records = parseLines(text, file, FlowFileRecord, diagnostics);
  const metas = records.filter((r) => r.kind === 'flow');
  if (metas.length === 0) {
    diagnostics.push({ severity: 'error', file, message: 'missing {"kind":"flow"} record' });
    return undefined;
  }
  for (const extra of metas.slice(1)) {
    diagnostics.push({
      severity: 'error',
      file,
      line: extra.line,
      message: 'only one flow record is allowed per file',
    });
  }
  return {
    file,
    meta: metas[0]!,
    nodes: records.filter((r) => r.kind === 'node'),
    steps: records.filter((r) => r.kind === 'step'),
    blocks: records.filter((r) => r.kind === 'block'),
  };
}

export function parseConfig(text: string, file: string, diagnostics: Diagnostic[] = []): Config {
  const records = parseLines(text, file, ConfigFileRecord, diagnostics);
  return { groups: records.filter((r) => r.kind === 'group') };
}
