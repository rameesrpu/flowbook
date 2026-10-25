import { anchorKey } from './anchor.js';
import type { Diagnostic, Flow } from './parse.js';

/** Checks references and ordering inside a single flow. */
export function validateFlow(flow: Flow): Diagnostic[] {
  const out: Diagnostic[] = [];
  const err = (line: number, id: string | undefined, message: string) =>
    out.push({ severity: 'error', file: flow.file, line, id, message });
  const warn = (line: number, id: string | undefined, message: string) =>
    out.push({ severity: 'warning', file: flow.file, line, id, message });

  const seen = new Map<string, number>();
  for (const r of [...flow.nodes, ...flow.steps, ...flow.blocks]) {
    const prev = seen.get(r.id);
    if (prev !== undefined)
      err(r.line, r.id, `duplicate id "${r.id}" (first used on line ${prev})`);
    else seen.set(r.id, r.line);
  }

  const nodeIds = new Set(flow.nodes.map((n) => n.id));
  const stepById = new Map(flow.steps.map((s) => [s.id, s]));
  const { meta } = flow;

  if (meta.entry !== undefined && !nodeIds.has(meta.entry)) {
    err(meta.line, meta.id, `entry "${meta.entry}" is not a node in this flow`);
  }

  const anchors = new Map<string, string>();
  for (const n of flow.nodes) {
    if (n.flow === meta.id) err(n.line, n.id, 'a node cannot drill down into its own flow');
    if (n.anchor) {
      const key = anchorKey(n.anchor);
      const other = anchors.get(key);
      if (other) warn(n.line, n.id, `same anchor as node "${other}"; reuse that node instead`);
      else anchors.set(key, n.id);
    }
  }

  const used = new Set<string>();
  for (const s of flow.steps) {
    for (const end of [s.from, s.to]) {
      if (!nodeIds.has(end)) err(s.line, s.id, `step refers to unknown node "${end}"`);
      used.add(end);
    }
  }
  for (const n of flow.nodes) {
    if (!used.has(n.id) && flow.steps.length > 0) {
      warn(n.line, n.id, `node "${n.id}" is not used by any step`);
    }
  }

  // Block membership: steps must exist, and blocks must nest or be disjoint.
  const members = new Map<string, Set<string>>();
  for (const b of flow.blocks) {
    const set = new Set<string>();
    for (const id of b.steps) {
      if (!stepById.has(id)) err(b.line, b.id, `block refers to unknown step "${id}"`);
      else if (set.has(id)) err(b.line, b.id, `step "${id}" is listed twice`);
      set.add(id);
    }
    members.set(b.id, set);
  }
  for (let i = 0; i < flow.blocks.length; i++) {
    for (let j = i + 1; j < flow.blocks.length; j++) {
      const a = flow.blocks[i]!;
      const b = flow.blocks[j]!;
      const sa = members.get(a.id)!;
      const sb = members.get(b.id)!;
      const shared = [...sa].filter((x) => sb.has(x)).length;
      if (shared > 0 && shared !== sa.size && shared !== sb.size) {
        err(b.line, b.id, `block partially overlaps block "${a.id}"; blocks must nest`);
      }
    }
  }

  // Sequence numbers: unique, except alternatives inside the same `alt` block.
  const altOf = new Map<string, string>();
  for (const b of flow.blocks) if (b.type === 'alt') for (const id of b.steps) altOf.set(id, b.id);
  const bySeq = new Map<number, typeof flow.steps>();
  for (const s of flow.steps) bySeq.set(s.seq, [...(bySeq.get(s.seq) ?? []), s]);
  for (const [seq, steps] of bySeq) {
    if (steps.length < 2) continue;
    const alt = altOf.get(steps[0]!.id);
    const allAlternatives = alt !== undefined && steps.every((s) => altOf.get(s.id) === alt);
    if (!allAlternatives) {
      for (const s of steps.slice(1)) {
        err(
          s.line,
          s.id,
          `seq ${seq} is already used; only alternatives in one alt block may share it`,
        );
      }
    }
  }
  const seqs = [...bySeq.keys()].sort((a, b) => a - b);
  seqs.forEach((seq, i) => {
    if (seq !== i + 1) {
      const s = bySeq.get(seq)![0]!;
      warn(s.line, s.id, `seq numbers should run 1..${seqs.length} without gaps (found ${seq})`);
    }
  });

  return out;
}

/** Checks consistency between flows: ids, file names, drill-down targets. */
export function validateWorkspace(flows: Flow[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  const byId = new Map<string, Flow>();
  for (const f of flows) {
    const base = f.file
      .split('/')
      .pop()!
      .replace(/\.jsonl$/, '');
    if (base !== f.meta.id) {
      out.push({
        severity: 'error',
        file: f.file,
        line: f.meta.line,
        id: f.meta.id,
        message: `flow id "${f.meta.id}" must match the file name "${base}.jsonl"`,
      });
    }
    const prev = byId.get(f.meta.id);
    if (prev) {
      out.push({
        severity: 'error',
        file: f.file,
        line: f.meta.line,
        id: f.meta.id,
        message: `flow id "${f.meta.id}" is also used by ${prev.file}`,
      });
    } else byId.set(f.meta.id, f);
  }
  for (const f of flows) {
    for (const n of f.nodes) {
      if (n.flow !== undefined && !byId.has(n.flow)) {
        out.push({
          severity: 'error',
          file: f.file,
          line: n.line,
          id: n.id,
          message: `drill-down target flow "${n.flow}" does not exist`,
        });
      }
    }
  }
  return out;
}
