import { basename } from 'node:path';
import type { Flow } from '@flowbook/core';
import * as vscode from 'vscode';
import type { Flowbook } from './host.js';
import { flowSections, problemCount, type RootState } from './model.js';

export type FlowsItem =
  | { kind: 'root'; state: RootState }
  | { kind: 'tag'; state: RootState; tag: string | undefined; flows: Flow[] }
  | { kind: 'flow'; state: RootState; flow: Flow };

const byTitle = (a: Flow, b: Flow) => a.meta.title.localeCompare(b.meta.title);

/**
 * Activity-bar tree: roots (when several) → sections (when any flow is tagged) → flows.
 * A flow's first tag is its section, so every flow appears exactly once.
 */
export class FlowsTree implements vscode.TreeDataProvider<FlowsItem> {
  private readonly changed = new vscode.EventEmitter<FlowsItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly flowbook: Flowbook) {
    flowbook.onDidChange(() => this.changed.fire(undefined));
  }

  getChildren(item?: FlowsItem): FlowsItem[] {
    if (!item) {
      const roots = [...this.flowbook.roots.values()];
      if (roots.length === 1) return this.rootChildren(roots[0]!);
      return roots.map((state) => ({ kind: 'root', state }));
    }
    if (item.kind === 'root') return this.rootChildren(item.state);
    if (item.kind === 'tag') {
      return item.flows.map((flow) => ({ kind: 'flow', state: item.state, flow }));
    }
    return [];
  }

  private rootChildren(state: RootState): FlowsItem[] {
    const sections = flowSections(state.ws.flows);
    if (sections.every((s) => s.tag === undefined)) {
      return [...state.ws.flows].sort(byTitle).map((flow) => ({ kind: 'flow', state, flow }));
    }
    return sections.map(({ tag, flows }) => ({ kind: 'tag', state, tag, flows }));
  }

  getTreeItem(item: FlowsItem): vscode.TreeItem {
    if (item.kind === 'root') {
      const t = new vscode.TreeItem(
        basename(item.state.root),
        vscode.TreeItemCollapsibleState.Expanded,
      );
      t.description = vscode.workspace.asRelativePath(item.state.root);
      t.tooltip = item.state.root;
      t.iconPath = new vscode.ThemeIcon('root-folder');
      t.contextValue = 'flowbookRoot';
      return t;
    }
    if (item.kind === 'tag') {
      const t = new vscode.TreeItem(
        item.tag ?? 'Untagged',
        vscode.TreeItemCollapsibleState.Expanded,
      );
      t.description = String(item.flows.length);
      t.iconPath = new vscode.ThemeIcon('tag');
      t.contextValue = 'flowbookTag';
      return t;
    }
    const { flow, state } = item;
    const t = new vscode.TreeItem(flow.meta.title, vscode.TreeItemCollapsibleState.None);
    const problems = problemCount(state, flow);
    const extraTags = (flow.meta.tags ?? []).slice(1).map((t) => `#${t}`);
    t.description = [flow.meta.id, ...extraTags, problems ? `· ${problems} ⚠` : '']
      .filter(Boolean)
      .join(' ');
    const tooltip = new vscode.MarkdownString(
      `**${flow.meta.title}**\n\n${flow.meta.summary ?? ''}`,
    );
    if (flow.meta.tags?.length) {
      tooltip.appendMarkdown(`\n\nTags: ${flow.meta.tags.map((t) => `\`${t}\``).join(' ')}`);
    }
    if (problems)
      tooltip.appendMarkdown(`\n\n$(warning) ${problems} problem(s): run *Flowbook: Check*`);
    tooltip.supportThemeIcons = true;
    t.tooltip = tooltip;
    t.iconPath = problems
      ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'))
      : new vscode.ThemeIcon('type-hierarchy-sub');
    t.contextValue = 'flowbookFlow';
    t.command = {
      command: 'flowbook.openFlow',
      title: 'Open Flow',
      arguments: [state.root, flow.meta.id],
    };
    return t;
  }
}
