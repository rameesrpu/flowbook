import * as vscode from 'vscode';
import type { Flowbook } from './host.js';
import type { UsageLink } from '@flowbook/core';
import { lensTargets } from './model.js';

export const C_CPP_SELECTOR: vscode.DocumentSelector = [
  { scheme: 'file', language: 'c' },
  { scheme: 'file', language: 'cpp' },
];

const enabled = () =>
  vscode.workspace.getConfiguration('flowbook').get<boolean>('codeLens.enabled', true);

/** "Flowbook: in N flows" above every definition some flow anchors. */
export class FlowLenses implements vscode.CodeLensProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;

  constructor(private readonly flowbook: Flowbook) {
    flowbook.onDidChange(() => this.changed.fire());
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('flowbook.codeLens')) this.changed.fire();
    });
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!enabled()) return [];
    const hit = this.flowbook.locate(doc.uri.fsPath);
    if (!hit) return [];
    const symbols = this.flowbook.resolver.listSymbols(hit.rel, doc.getText());
    return lensTargets(hit.state, hit.rel, symbols).map(({ symbol, usages }) => {
      const flows = new Set(usages.map((u) => u.flow)).size;
      return new vscode.CodeLens(new vscode.Range(symbol.nameLine, 0, symbol.nameLine, 0), {
        title: `Flowbook: in ${flows} flow${flows === 1 ? '' : 's'}`,
        tooltip: usages.map((u) => `${u.flowTitle} › ${u.nodeTitle}`).join('\n'),
        command: 'flowbook.showUsages',
        arguments: [hit.state.root, usages],
      });
    });
  }
}

/** Opens the single using flow directly, or lets the user pick one. */
export async function showUsages(
  open: (root: string, flowId: string, focus?: string) => void,
  root: string,
  usages: UsageLink[],
) {
  if (usages.length === 1) {
    open(root, usages[0]!.flow, usages[0]!.node);
    return;
  }
  const pick = await vscode.window.showQuickPick(
    usages.map((u) => ({ label: u.flowTitle, description: u.nodeTitle, detail: u.flow, usage: u })),
    { placeHolder: 'Open flow' },
  );
  if (pick) open(root, pick.usage.flow, pick.usage.node);
}
