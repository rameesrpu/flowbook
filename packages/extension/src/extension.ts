import { homedir } from 'node:os';
import { join } from 'node:path';
import type { UsageLink } from '@flowbook/core';
import { Resolver, type Target } from '@flowbook/resolver';
import * as vscode from 'vscode';
import { C_CPP_SELECTOR, FlowLenses, showUsages } from './codelens.js';
import { ConnectionLenses, goTo } from './connections-lens.js';
import { Flowbook } from './host.js';
import { hasShim, installCli, installSkill, SKILL_DIR, type CliInstall } from './install.js';
import { MachineLenses } from './machines-lens.js';
import { Panels } from './panel.js';
import { FlowsTree } from './tree.js';

const SOURCE_GLOB = '**/*.{c,cc,cpp,cxx,h,hh,hpp,hxx,inl,ipp}';
/** Watched for reloads; covers config.jsonl, connections.jsonl, machines.jsonl and flows/*.jsonl. */
const FLOWBOOK_GLOB = '**/.flowbook/**/*.jsonl';

/** What `activate` returns; used by the integration tests. */
export interface FlowbookApi {
  flowbook: Flowbook;
  tree: FlowsTree;
  panels: Panels;
}

export async function activate(context: vscode.ExtensionContext): Promise<FlowbookApi> {
  const log = vscode.window.createOutputChannel('Flowbook');
  context.subscriptions.push(log);

  const resolver = await Resolver.create({ wasmDir: join(context.extensionPath, 'dist') });
  const flowbook = new Flowbook(resolver, log);
  const tree = new FlowsTree(flowbook);
  const panels = new Panels(flowbook, context.extensionUri, log);
  context.subscriptions.push(flowbook, panels);

  const open = (root: string, flowId: string, focus?: string) => panels.show(root, flowId, focus);

  const cli: CliInstall = {
    bundled: join(context.extensionPath, 'dist', 'cli'),
    stable: join(context.globalStorageUri.fsPath, 'cli'),
    binDir: join(homedir(), '.local', 'bin'),
    platform: process.platform,
    execPath: process.execPath,
  };
  // The shim points at a stable copy; refresh it so extension updates reach the CLI too.
  if (hasShim(cli)) {
    try {
      installCli(cli);
    } catch (e) {
      log.appendLine(`CLI refresh failed: ${String(e)}`);
    }
  }

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('flowbook.flows', tree),
    vscode.languages.registerCodeLensProvider(C_CPP_SELECTOR, new FlowLenses(flowbook)),
    vscode.languages.registerCodeLensProvider(C_CPP_SELECTOR, new ConnectionLenses(flowbook)),
    vscode.languages.registerCodeLensProvider(C_CPP_SELECTOR, new MachineLenses(flowbook)),
    vscode.commands.registerCommand(
      'flowbook.goToReactor',
      (uri?: vscode.Uri, line?: number, targets?: Target[], prompt?: string) =>
        goTo(flowbook, 'reactor', uri, line, targets, prompt),
    ),
    vscode.commands.registerCommand(
      'flowbook.goToSender',
      (uri?: vscode.Uri, line?: number, targets?: Target[], prompt?: string) =>
        goTo(flowbook, 'sender', uri, line, targets, prompt),
    ),
    vscode.commands.registerCommand('flowbook.refresh', () => flowbook.reload()),
    vscode.commands.registerCommand('flowbook.check', async () => {
      await flowbook.reload();
      await flowbook.scanned();
      const all = [...flowbook.roots.values()];
      const diags = all.flatMap((s) => s.diagnostics);
      const errors = diags.filter((d) => d.severity === 'error').length;
      const flows = all.reduce((n, s) => n + s.ws.flows.length, 0);
      const summary = `Flowbook: ${flows} flow(s), ${errors} error(s), ${diags.length - errors} warning(s).`;
      if (diags.length === 0) void vscode.window.showInformationMessage(summary);
      else {
        void vscode.window.showWarningMessage(summary, 'Show Problems').then((choice) => {
          if (choice) void vscode.commands.executeCommand('workbench.actions.view.problems');
        });
      }
      return { flows, errors, warnings: diags.length - errors };
    }),
    vscode.commands.registerCommand(
      'flowbook.openFlow',
      async (root?: string, flowId?: string, focus?: string) => {
        if (root && flowId) return open(root, flowId, focus);
        const items = [...flowbook.roots.values()].flatMap((state) =>
          state.ws.flows.map((f) => ({
            label: f.meta.title,
            description: [f.meta.id, ...(f.meta.tags ?? []).map((t) => `#${t}`)].join('  '),
            detail:
              [
                flowbook.roots.size > 1 ? vscode.workspace.asRelativePath(state.root) : '',
                f.meta.summary?.split('\n')[0] ?? '',
              ]
                .filter(Boolean)
                .join(' — ') || undefined,
            root: state.root,
            id: f.meta.id,
          })),
        );
        if (items.length === 0) {
          void vscode.window.showInformationMessage('Flowbook: no flows found in this workspace.');
          return;
        }
        const pick = await vscode.window.showQuickPick(items, {
          placeHolder: 'Open flow — search by title, id, #tag or summary',
          matchOnDescription: true,
          matchOnDetail: true,
        });
        if (pick) open(pick.root, pick.id);
      },
    ),
    vscode.commands.registerCommand('flowbook.installCli', async () => {
      try {
        const { shim, onPath } = installCli(cli);
        const msg = onPath
          ? `Flowbook: installed the \`flowbook\` command at ${shim}.`
          : `Flowbook: installed ${shim}. Add ${cli.binDir} to your PATH to run \`flowbook\` from any shell.`;
        void vscode.window.showInformationMessage(msg);
        return shim;
      } catch (e) {
        void vscode.window.showErrorMessage(`Flowbook: could not install the CLI: ${String(e)}`);
      }
    }),
    vscode.commands.registerCommand('flowbook.installSkill', async (target?: string) => {
      const folders = vscode.workspace.workspaceFolders ?? [];
      const repo =
        target ??
        (folders.length === 1
          ? folders[0]!.uri.fsPath
          : (
              await vscode.window.showWorkspaceFolderPick({
                placeHolder: `Copy the Flowbook skill to <folder>/${SKILL_DIR}`,
              })
            )?.uri.fsPath);
      if (!repo) return;
      const dest = installSkill(join(context.extensionPath, 'dist', 'skill'), repo);
      void vscode.window.showInformationMessage(
        `Flowbook: copied the agent skill to ${vscode.workspace.asRelativePath(dest)}. ` +
          'Claude Code picks it up from there; point other agents at its SKILL.md.',
      );
      return dest;
    }),
    vscode.commands.registerCommand('flowbook.showUsages', (root: string, usages: UsageLink[]) =>
      showUsages(open, root, usages),
    ),
  );

  // Live reload: any flow, config or connections file or C/C++ source saved, created or deleted.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      flowbook.reload().catch((e: unknown) => log.appendLine(`reload failed: ${String(e)}`));
    }, 300);
  };
  context.subscriptions.push({ dispose: () => timer && clearTimeout(timer) });
  for (const glob of [FLOWBOOK_GLOB, SOURCE_GLOB]) {
    const w = vscode.workspace.createFileSystemWatcher(glob);
    w.onDidCreate(schedule);
    w.onDidChange(schedule);
    w.onDidDelete(schedule);
    context.subscriptions.push(w);
  }
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(schedule));

  await flowbook.reload();
  void vscode.commands.executeCommand('setContext', 'flowbook.hasFlows', flowbook.roots.size > 0);
  flowbook.onDidChange(() =>
    vscode.commands.executeCommand('setContext', 'flowbook.hasFlows', flowbook.roots.size > 0),
  );
  return { flowbook, tree, panels };
}

export function deactivate() {}
