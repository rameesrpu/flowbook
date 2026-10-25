import { basename } from 'node:path';
import type { Flow } from '@flowbook/core';
import * as vscode from 'vscode';
import type { Flowbook } from './host.js';
import { problemCount, type RootState } from './model.js';

export type FlowsItem =
  | { kind: 'root'; state: RootState }
  | { kind: 'tag'; state: RootState; tag: string | undefined }
  | { kind: 'flow'; state: RootState; flow: Flow };

const byTitle = (a: Flow, b: Flow) => a.meta.title.localeCompare(b.meta.title);

/** Activity-bar tree: roots (when several) → tags (when any flow is tagged) → flows. */
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
      return item.state.ws.flows
        .filter((f) =>
          item.tag === undefined ? !f.meta.tags?.length : f.meta.tags?.includes(item.tag),
        )
        .sort(byTitle)
        .map((flow) => ({ kind: 'flow', state: item.state, flow }));
    }
    return [];
  }

  private rootChildren(state: RootState): FlowsItem[] {
    const flows = [...state.ws.flows].sort(byTitle);
    const tags = [...new Set(flows.flatMap((f) => f.meta.tags ?? []))].sort();
    if (tags.length === 0) return flows.map((flow) => ({ kind: 'flow', state, flow }));
    const items: FlowsItem[] = tags.map((tag) => ({ kind: 'tag', state, tag }));
    if (flows.some((f) => !f.meta.tags?.length)) items.push({ kind: 'tag', state, tag: undefined });
    return items;
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
      t.iconPath = new vscode.ThemeIcon('tag');
      t.contextValue = 'flowbookTag';
      return t;
    }
    const { flow, state } = item;
    const t = new vscode.TreeItem(flow.meta.title, vscode.TreeItemCollapsibleState.None);
    const problems = problemCount(state, flow);
    t.description = problems ? `${flow.meta.id} · ${problems} ⚠` : flow.meta.id;
    const tooltip = new vscode.MarkdownString(
      `**${flow.meta.title}**\n\n${flow.meta.summary ?? ''}`,
    );
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
