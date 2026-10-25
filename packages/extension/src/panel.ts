import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { HostMessage, WebviewMessage } from '@flowbook/core';
import { fileAtCommit, headCommitFor } from '@flowbook/resolver';
import * as vscode from 'vscode';
import type { Flowbook } from './host.js';
import {
  buildPayload,
  definitionDiff,
  findFlow,
  nameRange,
  snippetOf,
  type RootState,
} from './model.js';

interface FlowPanel {
  panel: vscode.WebviewPanel;
  root: string;
  flowId: string;
  /** Node to select on the next `load`; cleared once sent. */
  focus?: string;
  ready: boolean;
  /** Errors reported by the webview, for the output channel and tests. */
  errors: string[];
}

/** One webview panel per open flow. Navigation inside a panel reuses it. */
export class Panels implements vscode.Disposable {
  private readonly panels = new Set<FlowPanel>();
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly flowbook: Flowbook,
    private readonly extensionUri: vscode.Uri,
    private readonly log: vscode.OutputChannel,
  ) {
    this.subscription = flowbook.onDidChange(() => {
      for (const p of this.panels) this.load(p);
    });
  }

  dispose() {
    this.subscription.dispose();
    for (const p of [...this.panels]) p.panel.dispose();
  }

  /** Panels currently open, for tests. */
  get open(): { root: string; flowId: string; ready: boolean; errors: string[] }[] {
    return [...this.panels].map(({ root, flowId, ready, errors }) => ({
      root,
      flowId,
      ready,
      errors,
    }));
  }

  show(root: string, flowId: string, focus?: string) {
    const existing = [...this.panels].find((p) => p.root === root && p.flowId === flowId);
    if (existing) {
      existing.panel.reveal();
      if (focus !== undefined) {
        existing.focus = focus;
        this.load(existing);
      }
      return;
    }
    const webviewRoot = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
    const panel = vscode.window.createWebviewPanel(
      'flowbook.flow',
      this.title(root, flowId),
      vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [webviewRoot] },
    );
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'flowbook.svg');
    const entry: FlowPanel = { panel, root, flowId, focus, ready: false, errors: [] };
    this.panels.add(entry);
    panel.webview.html = this.html(panel.webview, webviewRoot);
    panel.onDidDispose(() => this.panels.delete(entry));
    panel.webview.onDidReceiveMessage((m: WebviewMessage) =>
      this.handle(entry, m).catch((e: unknown) =>
        vscode.window.showErrorMessage(`Flowbook: ${(e as Error).message ?? e}`),
      ),
    );
  }

  private title(root: string, flowId: string) {
    const state = this.flowbook.roots.get(root);
    const flow = state && findFlow(state, flowId);
    return `Flowbook: ${flow?.meta.title ?? flowId}`;
  }

  private post(p: FlowPanel, message: HostMessage) {
    void p.panel.webview.postMessage(message);
  }

  private load(p: FlowPanel) {
    if (!p.ready) return;
    p.panel.title = this.title(p.root, p.flowId);
    const state = this.flowbook.roots.get(p.root);
    const payload = state && buildPayload(state, p.flowId, p.focus);
    p.focus = undefined;
    this.post(p, payload ? { type: 'load', payload } : { type: 'missing', flowId: p.flowId });
  }

  private async handle(p: FlowPanel, m: WebviewMessage) {
    const state = this.flowbook.roots.get(p.root);
    switch (m.type) {
      case 'ready':
        p.ready = true;
        this.load(p);
        return;
      case 'openFlow':
        p.flowId = m.flowId;
        p.focus = m.focus;
        this.load(p);
        return;
      case 'error':
        p.errors.push(m.message);
        this.log.appendLine(`[webview ${p.flowId}] ${m.message}`);
        if (p.errors.length === 1) {
          void vscode.window
            .showErrorMessage(
              `Flowbook: the diagram view failed: ${m.message.split('\n')[0]}`,
              'Show log',
            )
            .then((pick) => pick && this.log.show());
        }
        return;
      case 'copy':
        await vscode.env.clipboard.writeText(m.text);
        void vscode.window.showInformationMessage('Flowbook: copied to clipboard.');
        return;
      case 'openFlowFile': {
        const flow = state && findFlow(state, p.flowId);
        if (!state || !flow) return;
        const line = Math.max(0, (m.line ?? 1) - 1);
        await vscode.window.showTextDocument(vscode.Uri.file(join(state.root, flow.file)), {
          viewColumn: this.codeColumn(p),
          selection: new vscode.Range(line, 0, line, 0),
        });
        return;
      }
      case 'openCode':
        return this.openCode(p, state, m.nodeId);
      case 'requestSnippet': {
        const r = this.resolveNode(state, p.flowId, m.nodeId);
        this.post(
          p,
          'error' in r
            ? { type: 'snippet', nodeId: m.nodeId, error: r.error }
            : { type: 'snippet', nodeId: m.nodeId, snippet: snippetOf(r.text, r.file, r.symbol) },
        );
        return;
      }
      case 'requestDiff':
        this.post(p, { type: 'diff', nodeId: m.nodeId, ...this.diff(state, p.flowId, m.nodeId) });
        return;
    }
  }

  /** An editor column that is not the panel's. */
  private codeColumn(p: FlowPanel): vscode.ViewColumn {
    const own = p.panel.viewColumn;
    const other = vscode.window.visibleTextEditors.find(
      (e) => e.viewColumn !== undefined && e.viewColumn !== own,
    );
    if (other?.viewColumn) return other.viewColumn;
    return own === vscode.ViewColumn.One ? vscode.ViewColumn.Beside : vscode.ViewColumn.One;
  }

  private node(state: RootState | undefined, flowId: string, nodeId: string) {
    const flow = state && findFlow(state, flowId);
    return flow?.nodes.find((n) => n.id === nodeId);
  }

  private resolveNode(state: RootState | undefined, flowId: string, nodeId: string) {
    const node = this.node(state, flowId, nodeId);
    if (!state || !node) return { error: `unknown node "${nodeId}"` } as const;
    if (!node.anchor) return { error: `"${node.title}" is not anchored to code` } as const;
    const { anchor } = node;
    const text = this.flowbook.readCurrent(state.root, anchor.file);
    if (text === undefined) return { error: `source file not found: ${anchor.file}` } as const;
    const r = this.flowbook.resolver.resolve(anchor, text);
    if (r.status === 'ambiguous') {
      return { error: `${anchor.symbol} is overloaded; the anchor needs a "sig"` } as const;
    }
    if (r.status === 'missing') {
      return { error: `no definition of ${anchor.symbol} in ${anchor.file}` } as const;
    }
    return { text, file: anchor.file, symbol: r.symbol, anchor } as const;
  }

  private async openCode(p: FlowPanel, state: RootState | undefined, nodeId: string) {
    const r = this.resolveNode(state, p.flowId, nodeId);
    if ('error' in r) {
      const node = this.node(state, p.flowId, nodeId);
      // Still open the file when it exists, so the user can look for the symbol.
      const abs = state && node?.anchor && join(state.root, node.anchor.file);
      if (abs && existsSync(abs)) {
        await vscode.window.showTextDocument(vscode.Uri.file(abs), {
          viewColumn: this.codeColumn(p),
        });
      }
      void vscode.window.showWarningMessage(`Flowbook: ${r.error}`);
      return;
    }
    const range = nameRange(r.text, r.symbol);
    const sel = new vscode.Range(range.line, range.start, range.line, range.end);
    const editor = await vscode.window.showTextDocument(
      vscode.Uri.file(join(state!.root, r.file)),
      { viewColumn: this.codeColumn(p), selection: sel },
    );
    editor.revealRange(sel, vscode.TextEditorRevealType.InCenter);
  }

  private diff(
    state: RootState | undefined,
    flowId: string,
    nodeId: string,
  ): { diff: string } | { error: string } {
    const node = this.node(state, flowId, nodeId);
    if (!state || !node) return { error: `unknown node "${nodeId}"` };
    if (!node.anchor) return { error: `"${node.title}" is not anchored to code` };
    if (!node.verified) {
      return { error: 'this node has no verified commit; run `flowbook stamp` to record one' };
    }
    if (!headCommitFor(state.root, node.anchor.file)) {
      return { error: `${node.anchor.file} is not inside a git repository` };
    }
    const old = fileAtCommit(state.root, node.verified, node.anchor.file);
    if (old === undefined) {
      return {
        error: `${node.anchor.file} does not exist at ${node.verified.slice(0, 7)} (or the commit is not available locally)`,
      };
    }
    const current = this.flowbook.readCurrent(state.root, node.anchor.file);
    if (current === undefined) return { error: `source file not found: ${node.anchor.file}` };
    return definitionDiff(this.flowbook.resolver, node.anchor, old, current, node.verified);
  }

  private html(webview: vscode.Webview, root: vscode.Uri): string {
    const nonce = randomBytes(16).toString('base64');
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`,
      // ELK runs its layout in a worker; allow it from the extension or a blob URL.
      `worker-src ${webview.cspSource} blob:`,
    ].join('; ');
    const head = `<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">`;
    if (!existsSync(join(root.fsPath, 'webview.js'))) {
      return `<!DOCTYPE html><html lang="en"><head>${head}</head>
<body style="font-family: var(--vscode-font-family); padding: 1em">
<p>The Flowbook webview is not built. Run <code>pnpm --filter @flowbook/webview build</code>
and then <code>pnpm --filter flowbook build</code>, and reopen this flow.</p></body></html>`;
    }
    const asset = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(root, name));
    const css = existsSync(join(root.fsPath, 'webview.css'))
      ? `<link rel="stylesheet" href="${asset('webview.css')}">`
      : '';
    // A classic script runs before the module bundle: it shows load failures in the page (and
    // reports them) so a broken bundle is never just a blank tab.
    const boot = `(() => {
  const vscode = acquireVsCodeApi();
  window.acquireVsCodeApi = () => vscode;
  const show = (msg) => {
    const el = document.getElementById('fb-boot');
    if (el) el.textContent = 'Flowbook could not start: ' + msg;
    vscode.postMessage({ type: 'error', message: msg });
  };
  window.addEventListener('error', (e) => {
    if (document.getElementById('fb-boot')) show((e.error && e.error.stack) || e.message || 'failed to load ' + (e.target && e.target.src));
  }, true);
  setTimeout(() => document.getElementById('fb-boot') && show('the diagram script did not start within 15 s'), 15000);
})();`;
    return `<!DOCTYPE html><html lang="en"><head>${head}
${css}</head><body><div id="root"><p id="fb-boot" style="padding: 1em; opacity: .7">Loading Flowbook…</p></div>
<script nonce="${nonce}">${boot}</script>
<script type="module" nonce="${nonce}" src="${asset('webview.js')}"></script>
</body></html>`;
  }
}
