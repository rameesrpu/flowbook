import type {
  AnchorStateName,
  BlockRecord,
  Flow,
  GroupTree,
  StepRecord,
  StepType,
} from '@flowbook/core';

export const BLOCK_ICON: Record<BlockRecord['type'], string> = { loop: '↻', alt: '◇', par: '∥' };

export const STEP_TYPES: { type: StepType; label: string; hint: string }[] = [
  { type: 'call', label: 'call', hint: 'synchronous call' },
  { type: 'return', label: 'return', hint: 'result flowing back' },
  { type: 'async', label: 'async', hint: 'queued / runs later or on another thread' },
  { type: 'callback', label: 'callback', hint: 'invoked through a registered pointer' },
  { type: 'signal', label: 'signal', hint: 'event, signal or notification' },
];

export const STATE_INFO: Record<AnchorStateName, { label: string; explain: string }> = {
  fresh: {
    label: 'Up to date',
    explain: 'The function body matches the fingerprint taken when this node was last verified.',
  },
  stale: {
    label: 'Changed since verified',
    explain:
      'The function body changed after this node was verified, so its notes and steps may no longer describe the code.',
  },
  unstamped: {
    label: 'Not verified yet',
    explain:
      'The anchor resolves, but nobody has stamped it with a fingerprint, so changes cannot be detected.',
  },
  'missing-file': {
    label: 'File not found',
    explain: 'The anchored source file does not exist any more — it was probably moved or deleted.',
  },
  missing: {
    label: 'Symbol not found',
    explain: 'The file exists but the symbol is gone — it was probably renamed, moved or removed.',
  },
  ambiguous: {
    label: 'Ambiguous anchor',
    explain:
      'Several overloads match this symbol. The anchor needs a `sig` to say which one is meant.',
  },
};

/** Steps sorted by sequence number. */
export const sortedSteps = (flow: Flow) => [...flow.steps].sort((a, b) => a.seq - b.seq);

/** Blocks containing a step, outermost (largest) first. */
export function blocksOfStep(flow: Flow, stepId: string): BlockRecord[] {
  return flow.blocks
    .filter((b) => b.steps.includes(stepId))
    .sort((a, b) => b.steps.length - a.steps.length);
}

export function stepById(flow: Flow, id: string): StepRecord | undefined {
  return flow.steps.find((s) => s.id === id);
}

const CHART_COLORS = [
  'var(--vscode-charts-blue, #3794ff)',
  'var(--vscode-charts-green, #388a34)',
  'var(--vscode-charts-orange, #d18616)',
  'var(--vscode-charts-purple, #b180d7)',
  'var(--vscode-charts-yellow, #bf8803)',
  'var(--vscode-charts-red, #e51400)',
];

/** Colour of each top-level group, stable by position in the tree. */
export function rootColors(tree: GroupTree): Map<string, string> {
  return new Map(tree.roots.map((r, i) => [r, CHART_COLORS[i % CHART_COLORS.length]!]));
}

/** Top-level group of a node or group id. */
export function rootOf(tree: GroupTree, id: string): string | undefined {
  let g = tree.groups.get(id) ?? tree.groups.get(tree.groupOf.get(id) ?? '');
  while (g?.parent) g = tree.groups.get(g.parent);
  return g?.id;
}

/** Ready-to-paste instructions for a coding agent to repair a node. */
export function agentPrompt(
  flow: Flow,
  nodeId: string,
  state: AnchorStateName,
): string | undefined {
  const node = flow.nodes.find((n) => n.id === nodeId);
  if (!node?.anchor) return undefined;
  const id = flow.meta.id;
  const where = `${node.anchor.file} ${node.anchor.symbol}${node.anchor.sig ?? ''}`;
  const file = `.flowbook/flows/${id}.jsonl`;
  const finish = `then run \`flowbook check\` and \`flowbook stamp ${id}\`.`;
  const head = `Flowbook flow \`${id}\` node \`${nodeId}\` (${where})`;
  switch (state) {
    case 'stale':
      return `${head} is stale. Re-read the code, update the node's title/notes and affected steps in ${file}, ${finish}`;
    case 'unstamped':
      return `${head} has not been verified. Check that its title/notes and steps in ${file} match the code, ${finish}`;
    case 'missing':
    case 'missing-file':
      return `${head} no longer resolves (${state === 'missing' ? 'symbol not found' : 'file not found'}). Find where the code moved (\`flowbook resolve <file>\` lists symbols), fix the anchor and any affected steps in ${file}, ${finish}`;
    case 'ambiguous':
      return `${head} matches several overloads. Run \`flowbook resolve ${node.anchor.file} ${node.anchor.symbol}\`, add the right \`sig\` to the anchor in ${file}, ${finish}`;
    default:
      return undefined;
  }
}

/** One prompt covering every node that needs attention in a flow. */
export function flowAgentPrompt(
  flow: Flow,
  anchors: Record<string, { state: AnchorStateName }>,
): string | undefined {
  const bad = flow.nodes.filter((n) => anchors[n.id] && anchors[n.id]!.state !== 'fresh');
  if (bad.length === 0) return undefined;
  const list = bad.map((n) => `- \`${n.id}\` (${anchors[n.id]!.state})`).join('\n');
  return `Flowbook flow \`${flow.meta.id}\` has nodes that need attention:\n${list}\nRe-read the code for each, fix anchors, titles/notes and affected steps in .flowbook/flows/${flow.meta.id}.jsonl, then run \`flowbook check\` and \`flowbook stamp ${flow.meta.id}\`.`;
}
