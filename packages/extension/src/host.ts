import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Diagnostic } from '@flowbook/core';
import {
  createScanCache,
  rulesKeyOf,
  scanRootSliced,
  type FileScan,
  type Resolver,
  type ScanCache,
} from '@flowbook/resolver';
import * as vscode from 'vscode';
import {
  loadRoot,
  locate,
  rootOfFlowbookFile,
  savedScanIsCurrent,
  withScans,
  type RootState,
} from './model.js';

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
  /**
   * The latest finished scan of each root, with the rules key (`rulesKeyOf`) it was made under
   * and the value of `saveCount` when it began.
   */
  private readonly lastScans = new Map<
    string,
    { key: string; scans: Map<string, FileScan>; startedAt: number }
  >();
  /** Counts document saves; `saves` holds its value at each file's latest save, by fsPath. */
  private saveCount = 0;
  private readonly saves = new Map<string, number>();
  private readonly onSave: vscode.Disposable;
  /** Skipped-file messages already written to the log, so a rescan does not repeat them. */
  private readonly skipsLogged = new Set<string>();
  /** Roots whose current state holds a finished scan made under its current rules. */
  private readonly ready = new Set<string>();
  /** Roots whose latest scan threw. */
  private readonly failed = new Set<string>();
  /** Bumped by every reload and by dispose; older reloads and scans stop when they see a newer value. */
  private generation = 0;
  private scanning: Promise<void> = Promise.resolve();

  constructor(
    readonly resolver: Resolver,
    private readonly log: vscode.OutputChannel,
  ) {
    this.onSave = vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.scheme === 'file') this.saves.set(doc.uri.fsPath, ++this.saveCount);
    });
  }

  dispose() {
    this.generation++;
    this.onSave.dispose();
    this.changed.dispose();
    this.problems.dispose();
  }

  /**
   * Finds every Flowbook root in the workspace and (re)loads all of them. Resolves once the roots
   * are loaded; their connection scans continue in the background (see `scanned`). A root keeps
   * its previous scan meanwhile when its rules are unchanged; otherwise (and before the first
   * scan) it is loaded without connections until the new scan lands.
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
    for (const map of [this.lastScans, this.caches])
      for (const root of [...map.keys()]) if (!found.has(root)) map.delete(root);
    this.roots.clear();
    this.ready.clear();
    for (const root of [...found].sort()) {
      try {
        const state = loadRoot(root, this.resolver);
        const last = this.lastScans.get(root);
        if (last && last.key === rulesKeyOf(state.ws.connections)) {
          this.roots.set(root, withScans(state, last.scans));
          this.ready.add(root);
        } else this.roots.set(root, state);
      } catch (e) {
        this.log.appendLine(`failed to load ${root}: ${(e as Error).stack ?? e}`);
      }
    }
    this.updateProblems();
    this.changed.fire();
    this.scanning = this.scanAll(generation).catch((e: unknown) =>
      this.log.appendLine(`connection scan failed: ${(e as Error).stack ?? e}`),
    );
  }

  /** Resolves when the scans started by the latest reload have landed or been superseded. */
  scanned(): Promise<void> {
    return this.scanning;
  }

  /**
   * `ready`: the root's state holds a scan made under its current rules, so its connection lenses
   * can be trusted. `failed`: its latest scan threw (see the output channel). Otherwise `pending`.
   */
  scanStatus(root: string): 'ready' | 'pending' | 'failed' {
    return this.ready.has(root) ? 'ready' : this.failed.has(root) ? 'failed' : 'pending';
  }

  /** Scans every loaded root with rules, one after another, yielding to the event loop. */
  private async scanAll(generation: number): Promise<void> {
    const pause = () =>
      new Promise<void>((r) => setImmediate(r)).then(() => {
        if (generation !== this.generation) throw new Superseded();
      });
    for (const [root, state] of [...this.roots]) {
      const { connections } = state.ws;
      if (connections.rules.length === 0) {
        this.lastScans.delete(root);
        this.failed.delete(root);
        continue;
      }
      let cache = this.caches.get(root);
      if (!cache) this.caches.set(root, (cache = createScanCache()));
      const started = Date.now();
      const startedAt = this.saveCount;
      const onSkip = (path: string, reason: string) => {
        const line = `skipped ${join(root, path)}: ${reason}`;
        if (this.skipsLogged.has(line)) return;
        this.skipsLogged.add(line);
        this.log.appendLine(line);
      };
      let scans: Map<string, FileScan>;
      try {
        scans = await scanRootSliced(root, connections, this.resolver, cache, pause, onSkip);
      } catch (e) {
        if (e instanceof Superseded || generation !== this.generation) return;
        this.log.appendLine(`scan of ${root} failed: ${(e as Error).stack ?? e}`);
        this.failed.add(root);
        this.lastScans.delete(root);
        this.ready.delete(root);
        // Drop the previous scan from the state, so no stale lenses or diagnostics remain.
        this.roots.set(root, loadRoot(root, this.resolver));
        this.updateProblems();
        this.changed.fire();
        continue;
      }
      if (generation !== this.generation) return;
      const ms = Date.now() - started;
      const sites = [...scans.values()].reduce((n, s) => n + s.sites.length, 0);
      this.log.appendLine(`scanned ${root}: ${scans.size} files parsed, ${sites} sites, ${ms} ms`);
      this.failed.delete(root);
      try {
        this.roots.set(root, loadRoot(root, this.resolver, undefined, scans));
        this.lastScans.set(root, { key: rulesKeyOf(connections), scans, startedAt });
        this.ready.add(root);
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

  /**
   * False when the file at `fsPath` was saved after the root's latest finished scan began: that
   * scan may hold its old text, so its lenses must be computed from the document instead.
   */
  scanIsCurrent(root: string, fsPath: string): boolean {
    return savedScanIsCurrent(this.saves.get(fsPath), this.lastScans.get(root)?.startedAt);
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
