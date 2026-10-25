/** Line diff and unified-diff formatting. Pure: no `vscode` import. */

export type DiffOp = { kind: ' ' | '-' | '+'; text: string };

/** Above this many cells the LCS table is skipped and the middle is reported as replaced. */
const MAX_CELLS = 16_000_000;

/** Line-level diff of `a` → `b` via longest common subsequence. */
export function diffLines(a: readonly string[], b: readonly string[]): DiffOp[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const ops: DiffOp[] = [];
  for (let i = 0; i < start; i++) ops.push({ kind: ' ', text: a[i]! });

  const n = endA - start;
  const m = endB - start;
  if (n === 0 || m === 0 || n * m > MAX_CELLS) {
    for (let i = start; i < endA; i++) ops.push({ kind: '-', text: a[i]! });
    for (let j = start; j < endB; j++) ops.push({ kind: '+', text: b[j]! });
  } else {
    // lcs[i * (m + 1) + j] = LCS length of a[start+i..endA) and b[start+j..endB).
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] =
          a[start + i] === b[start + j]
            ? lcs[(i + 1) * w + j + 1]! + 1
            : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[start + i] === b[start + j]) {
        ops.push({ kind: ' ', text: a[start + i]! });
        i++;
        j++;
      } else if (lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!) {
        ops.push({ kind: '-', text: a[start + i]! });
        i++;
      } else {
        ops.push({ kind: '+', text: b[start + j]! });
        j++;
      }
    }
    for (; i < n; i++) ops.push({ kind: '-', text: a[start + i]! });
    for (; j < m; j++) ops.push({ kind: '+', text: b[start + j]! });
  }

  for (let i = endA; i < a.length; i++) ops.push({ kind: ' ', text: a[i]! });
  return ops;
}

export interface UnifiedDiffOptions {
  /** 1-based line number of the first line of each side, used in `@@` headers. */
  oldStart?: number;
  newStart?: number;
  /** Unchanged lines shown around each change. */
  context?: number;
}

/** Formats a unified diff (`@@` hunks only, no file headers). Empty string when equal. */
export function unifiedDiff(
  oldLines: readonly string[],
  newLines: readonly string[],
  options: UnifiedDiffOptions = {},
): string {
  const { oldStart = 1, newStart = 1, context = 3 } = options;
  const ops = diffLines(oldLines, newLines);

  // Line numbers (0-based offsets) of each op on both sides.
  const oldAt: number[] = [];
  const newAt: number[] = [];
  let o = 0;
  let nw = 0;
  for (const op of ops) {
    oldAt.push(o);
    newAt.push(nw);
    if (op.kind !== '+') o++;
    if (op.kind !== '-') nw++;
  }

  const changed = ops.flatMap((op, i) => (op.kind === ' ' ? [] : [i]));
  if (changed.length === 0) return '';

  // Group changes whose context windows touch or overlap.
  const ranges: [number, number][] = [];
  for (const i of changed) {
    const from = Math.max(0, i - context);
    const to = Math.min(ops.length - 1, i + context);
    const last = ranges[ranges.length - 1];
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else ranges.push([from, to]);
  }

  const out: string[] = [];
  for (const [from, to] of ranges) {
    const slice = ops.slice(from, to + 1);
    const oldCount = slice.filter((op) => op.kind !== '+').length;
    const newCount = slice.filter((op) => op.kind !== '-').length;
    // As in GNU diff, an empty side is reported as starting at the line before it.
    const oldLine = oldStart + oldAt[from]! - (oldCount === 0 ? 1 : 0);
    const newLine = newStart + newAt[from]! - (newCount === 0 ? 1 : 0);
    out.push(`@@ -${oldLine},${oldCount} +${newLine},${newCount} @@`);
    for (const op of slice) out.push(op.kind + op.text);
  }
  return out.join('\n');
}
