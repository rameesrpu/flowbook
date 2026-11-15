import { join } from 'node:path';
import type { Target } from '@flowbook/resolver';
import * as vscode from 'vscode';
import { directTarget, documentLenses, targetsAt, type ConnLens } from './connections-model.js';
import type { Flowbook } from './host.js';

const enabled = () =>
  vscode.workspace.getConfiguration('flowbook').get<boolean>('connections.codeLens.enabled', true);

/** The document's root state and scan, when its root has rules and a landed scan. */
function scanned(flowbook: Flowbook, doc: vscode.TextDocument) {
  const hit = flowbook.locate(doc.uri.fsPath);
  if (!hit || !flowbook.isScanned(hit.state.root)) return undefined;
  const { connections } = hit.state.ws;
  if (connections.rules.length === 0) return undefined;
  const docScan = flowbook.resolver.scan(hit.rel, doc.getText(), connections.rules);
  return { ...hit, connections, docScan };
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

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!enabled()) return [];
    const at = scanned(this.flowbook, doc);
    if (!at) return [];
    return documentLenses(at.connections, at.state.scans, at.rel, at.docScan).map(
      (l: ConnLens) =>
        new vscode.CodeLens(new vscode.Range(l.line, 0, l.line, 0), {
          title: l.title,
          command: l.command,
          arguments: [doc.uri, l.line, l.targets, l.prompt],
        }),
    );
  }
}

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
    const ctx = scanned(flowbook, doc);
    if (!ctx) {
      const msg = flowbook.isScanned(hit.state.root)
        ? 'Flowbook: this root has no connection rules.'
        : 'Flowbook: connections are still being scanned.';
      void vscode.window.showInformationMessage(msg);
      return;
    }
    targets = targetsAt(ctx.connections, ctx.state.scans, ctx.rel, ctx.docScan, at, direction);
    if (targets.length === 0 && direction === 'reactor') {
      prompt = documentLenses(ctx.connections, ctx.state.scans, ctx.rel, ctx.docScan).find(
        (l) => l.line === at && l.prompt !== undefined,
      )?.prompt;
    }
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
