import { join } from 'node:path';
import type { ConnectionIndex, SymbolInfo, Target } from '@flowbook/resolver';
import * as vscode from 'vscode';
import {
  directTarget,
  documentIndex,
  documentLenses,
  promptAt,
  targetsAt,
  type ConnLens,
} from './connections-model.js';
import type { Flowbook } from './host.js';

const enabled = () =>
  vscode.workspace.getConfiguration('flowbook').get<boolean>('connections.codeLens.enabled', true);

type View =
  | { kind: 'none' | 'pending' | 'failed' }
  | { kind: 'ready'; index: ConnectionIndex; rel: string; symbols: SymbolInfo[] };

/**
 * The connection index covering the document's current text. A saved document uses the root's
 * index; only a document with unsaved edits is re-parsed and gets an index of its own.
 */
function viewOf(flowbook: Flowbook, doc: vscode.TextDocument): View {
  const hit = flowbook.locate(doc.uri.fsPath);
  if (!hit || hit.state.ws.connections.rules.length === 0) return { kind: 'none' };
  const status = flowbook.scanStatus(hit.state.root);
  if (status !== 'ready') return { kind: status };
  const { state, rel } = hit;
  if (!doc.isDirty) {
    const symbols = state.scans.get(rel)?.symbols ?? [];
    return { kind: 'ready', index: state.connectionIndex, rel, symbols };
  }
  const docScan = flowbook.resolver.scan(rel, doc.getText(), state.ws.connections.rules);
  const index = documentIndex(state.ws.connections, state.scans, rel, docScan);
  return { kind: 'ready', index, rel, symbols: docScan.symbols };
}

/** "↳ …" on send sites (where it runs) and on reactors (who posts to them). */
export class ConnectionLenses implements vscode.CodeLensProvider {
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
    return documentLenses(view.index, view.rel, view.symbols).map(
      (l: ConnLens) =>
        new vscode.CodeLens(new vscode.Range(l.line, 0, l.line, 0), {
          title: l.title,
          command: l.command,
          arguments: [doc.uri, l.line, l.targets, l.prompt],
        }),
    );
  }
}

const NOT_READY = {
  none: 'Flowbook: there are no connection rules for this root.',
  pending: 'Flowbook: connections are still being scanned.',
  failed: 'Flowbook: the connection scan of this root failed; see the Flowbook output channel.',
} as const;

/**
 * `flowbook.goToReactor` / `flowbook.goToSender`. Acts on `uri` and `line` when given, else on the
 * active editor's cursor line. A lens passes its own `targets` (a shared lens on consecutive
 * receive lines peeks the senders of all of them) and, on an unpaired send, its `prompt`.
 *
 * One target opens it. A key reactor followed only by its handler also opens the key reactor
 * directly, since the handler runs from there (`directTarget`). Otherwise the targets are peeked.
 */
export async function goTo(
  flowbook: Flowbook,
  direction: 'reactor' | 'sender',
  uri?: vscode.Uri,
  line?: number,
  targets?: Target[],
  prompt?: string,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const docUri = uri ?? editor?.document.uri;
  if (!docUri) return;
  const doc = await vscode.workspace.openTextDocument(docUri);
  const at = line ?? (editor?.document === doc ? editor.selection.active.line : undefined);
  if (at === undefined) return;
  const hit = flowbook.locate(doc.uri.fsPath);
  if (!hit) {
    void vscode.window.showInformationMessage('Flowbook: this file is not inside a Flowbook root.');
    return;
  }
  if (!targets) {
    const view = viewOf(flowbook, doc);
    if (view.kind !== 'ready') {
      void vscode.window.showInformationMessage(NOT_READY[view.kind]);
      return;
    }
    targets = targetsAt(view.index, view.rel, at, direction);
    if (targets.length === 0 && direction === 'reactor')
      prompt = promptAt(view.index, view.rel, at);
  }

  if (targets.length === 0) {
    const what = direction === 'reactor' ? 'reactor' : 'sender';
    if (prompt === undefined) {
      void vscode.window.showInformationMessage(`Flowbook: no ${what} found on line ${at + 1}.`);
      return;
    }
    const choice = await vscode.window.showInformationMessage(
      'Flowbook: no reactor found. An agent can pair this site with a connection record.',
      'Copy agent prompt',
    );
    if (choice) await vscode.env.clipboard.writeText(prompt);
    return;
  }

  const root = hit.state.root;
  const location = (t: Target) =>
    new vscode.Location(vscode.Uri.file(join(root, t.file)), new vscode.Position(t.line, t.column));
  const single = directTarget(targets);
  if (single) {
    const loc = location(single);
    const shown = await vscode.window.showTextDocument(loc.uri);
    shown.selection = new vscode.Selection(loc.range.start, loc.range.start);
    shown.revealRange(loc.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    return;
  }
  await vscode.commands.executeCommand(
    'editor.action.showReferences',
    doc.uri,
    new vscode.Position(at, 0),
    targets.map(location),
  );
}
