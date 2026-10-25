import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Diagnostic } from '@flowbook/core';
import type { Resolver } from '@flowbook/resolver';
import * as vscode from 'vscode';
import { loadRoot, locate, rootOfFlowbookFile, type RootState } from './model.js';

const FLOWBOOK_GLOB = '**/.flowbook/{config.jsonl,flows/*.jsonl}';

/** Owns the loaded Flowbook roots and keeps the Problems panel in sync with them. */
export class Flowbook implements vscode.Disposable {
  readonly roots = new Map<string, RootState>();
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires after every reload. */
  readonly onDidChange = this.changed.event;
  private readonly problems = vscode.languages.createDiagnosticCollection('flowbook');

  constructor(
    readonly resolver: Resolver,
    private readonly log: vscode.OutputChannel,
  ) {}

  dispose() {
    this.changed.dispose();
    this.problems.dispose();
  }

  /** Finds every Flowbook root in the workspace and (re)loads all of them. */
  async reload(): Promise<void> {
    const files = await vscode.workspace.findFiles(FLOWBOOK_GLOB, '**/node_modules/**');
    const found = new Set<string>();
    for (const uri of files) {
      if (uri.scheme !== 'file') continue;
      const root = rootOfFlowbookFile(uri.fsPath);
      if (root) found.add(root);
    }
    this.roots.clear();
    for (const root of [...found].sort()) {
      try {
        this.roots.set(root, loadRoot(root, this.resolver));
      } catch (e) {
        this.log.appendLine(`failed to load ${root}: ${(e as Error).stack ?? e}`);
      }
    }
    this.updateProblems();
    this.changed.fire();
  }

  private updateProblems() {
    this.problems.clear();
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const state of this.roots.values()) {
      for (const d of state.diagnostics) {
        const file = join(state.root, d.file ?? '.flowbook/config.jsonl');
        byFile.set(file, [...(byFile.get(file) ?? []), toVscode(d)]);
      }
    }
    for (const [file, list] of byFile) this.problems.set(vscode.Uri.file(file), list);
  }

  get problemCollection(): vscode.DiagnosticCollection {
    return this.problems;
  }

  /** Root state and root-relative path for an absolute file path. */
  locate(fsPath: string): { state: RootState; rel: string } | undefined {
    const hit = locate(this.roots.keys(), fsPath);
    const state = hit && this.roots.get(hit.root);
    return state && hit ? { state, rel: hit.rel } : undefined;
  }

  /** Current text of a root-relative file: the open document if any, else the file on disk. */
  readCurrent(root: string, rel: string): string | undefined {
    const abs = join(root, rel);
    const doc = vscode.workspace.textDocuments.find(
      (d) => d.uri.scheme === 'file' && d.uri.fsPath === abs,
    );
    if (doc) return doc.getText();
    try {
      return readFileSync(abs, 'utf8');
    } catch {
      return undefined;
    }
  }
}

function toVscode(d: Diagnostic): vscode.Diagnostic {
  const line = Math.max(0, (d.line ?? 1) - 1);
  const range = new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER);
  const out = new vscode.Diagnostic(
    range,
    d.message,
    d.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
  );
  out.source = 'flowbook';
  if (d.id) out.code = d.id;
  return out;
}
