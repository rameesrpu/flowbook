import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Diagnostic } from '@flowbook/core';
import {
  createScanCache,
  scanRootSliced,
  type FileScan,
  type Resolver,
  type ScanCache,
} from '@flowbook/resolver';
import * as vscode from 'vscode';
import { loadRoot, locate, rootOfFlowbookFile, type RootState } from './model.js';

const FLOWBOOK_GLOB = '**/.flowbook/{config.jsonl,connections.jsonl,flows/*.jsonl}';

/** Thrown from a scan's pause once a newer reload has started. */
class Superseded extends Error {}

/** Owns the loaded Flowbook roots and keeps the Problems panel in sync with them. */
export class Flowbook implements vscode.Disposable {
  readonly roots = new Map<string, RootState>();
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires after every reload. */
  readonly onDidChange = this.changed.event;
  private readonly problems = vscode.languages.createDiagnosticCollection('flowbook');
  /** One per root for the session; it invalidates itself when the rules change. */
  private readonly caches = new Map<string, ScanCache>();
  /** The latest landed scan of each root. A root is absent until its first scan lands. */
  private readonly lastScans = new Map<string, Map<string, FileScan>>();
  /** Bumped by every reload; older reloads and their scans stop when they see a newer value. */
  private generation = 0;
  private scanning: Promise<void> = Promise.resolve();

  constructor(
    readonly resolver: Resolver,
    private readonly log: vscode.OutputChannel,
  ) {}

  dispose() {
    this.changed.dispose();
    this.problems.dispose();
  }

  /**
   * Finds every Flowbook root in the workspace and (re)loads all of them. Resolves once the roots
   * are loaded; their connection scans continue in the background (see `scanned`). Until a root's
   * first scan lands it is loaded without connections; later reloads keep the previous scan.
   */
  async reload(): Promise<void> {
    const generation = ++this.generation;
    const files = await vscode.workspace.findFiles(FLOWBOOK_GLOB, '**/node_modules/**');
    if (generation !== this.generation) return;
    const found = new Set<string>();
    for (const uri of files) {
      if (uri.scheme !== 'file') continue;
      const root = rootOfFlowbookFile(uri.fsPath);
      if (root) found.add(root);
    }
    for (const root of [...this.lastScans.keys()])
      if (!found.has(root)) this.lastScans.delete(root);
    for (const root of [...this.caches.keys()]) if (!found.has(root)) this.caches.delete(root);
    this.roots.clear();
    for (const root of [...found].sort()) {
      try {
        this.roots.set(root, loadRoot(root, this.resolver, undefined, this.lastScans.get(root)));
      } catch (e) {
        this.log.appendLine(`failed to load ${root}: ${(e as Error).stack ?? e}`);
      }
    }
    this.updateProblems();
    this.changed.fire();
    this.scanning = this.scanAll(generation);
  }

  /** Resolves when the scans started by the latest reload have landed or been superseded. */
  scanned(): Promise<void> {
    return this.scanning;
  }

  /** True once a scan of the root has landed, so its connection lenses can be trusted. */
  isScanned(root: string): boolean {
    return this.lastScans.has(root);
  }

  /** Scans every loaded root with rules, one after another, yielding to the event loop. */
  private async scanAll(generation: number): Promise<void> {
    const pause = () =>
      new Promise<void>((r) => setImmediate(r)).then(() => {
        if (generation !== this.generation) throw new Superseded();
      });
    for (const [root, state] of [...this.roots]) {
      if (state.ws.connections.rules.length === 0) {
        this.lastScans.delete(root);
        continue;
      }
      let cache = this.caches.get(root);
      if (!cache) this.caches.set(root, (cache = createScanCache()));
      const started = Date.now();
      let scans: Map<string, FileScan>;
      try {
        scans = await scanRootSliced(root, state.ws.connections, this.resolver, cache, pause);
      } catch (e) {
        if (e instanceof Superseded) return;
        this.log.appendLine(`scan of ${root} failed: ${(e as Error).stack ?? e}`);
        continue;
      }
      if (generation !== this.generation) return;
      const ms = Date.now() - started;
      const sites = [...scans.values()].reduce((n, s) => n + s.sites.length, 0);
      this.log.appendLine(`scanned ${root}: ${scans.size} files parsed, ${sites} sites, ${ms} ms`);
      try {
        this.roots.set(root, loadRoot(root, this.resolver, undefined, scans));
        this.lastScans.set(root, scans);
      } catch (e) {
        this.log.appendLine(`failed to load ${root}: ${(e as Error).stack ?? e}`);
        continue;
      }
      this.updateProblems();
      this.changed.fire();
    }
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
