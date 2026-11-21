import * as vscode from 'vscode';
import { viewOf } from './connections-lens.js';
import type { Flowbook } from './host.js';
import { machineLenses } from './machines-model.js';

const enabled = () =>
  vscode.workspace.getConfiguration('flowbook').get<boolean>('connections.codeLens.enabled', true);

/**
 * "↳ <machine>: FROM → TO on EVENT" on every transition site (set call or table row). A lens
 * whose transition sets something off peeks its reactors through `Go to Reactor`; one that does
 * not is a title only.
 */
export class MachineLenses implements vscode.CodeLensProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;

  constructor(private readonly flowbook: Flowbook) {
    flowbook.onDidChange(() => this.changed.fire());
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('flowbook.connections.codeLens')) this.changed.fire();
    });
  }

  provideCodeLenses(doc: vscode.TextDocument, token: vscode.CancellationToken): vscode.CodeLens[] {
    if (!enabled() || token.isCancellationRequested) return [];
    const view = viewOf(this.flowbook, doc);
    if (view.kind !== 'ready' || token.isCancellationRequested) return [];
    return machineLenses(view.machines, view.rel, view.index.sites).map(
      (l) =>
        new vscode.CodeLens(
          new vscode.Range(l.line, 0, l.line, 0),
          l.targets.length > 0
            ? {
                title: l.title,
                command: 'flowbook.goToReactor',
                arguments: [doc.uri, l.line, l.targets],
              }
            : { title: l.title, command: '' },
        ),
    );
  }
}
