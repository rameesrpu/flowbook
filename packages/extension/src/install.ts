/**
 * Installs the CLI bundled in the extension as a `flowbook` command, and copies the agent skill
 * into a repository. Pure with respect to `vscode` so it can be unit-tested.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface CliInstall {
  /** Extension's `dist/cli` (flowbook.js + wasm); changes with every extension update. */
  bundled: string;
  /** Stable copy the shim points at, e.g. the extension's global storage. */
  stable: string;
  /** Directory the shim is written to, e.g. `~/.local/bin`. */
  binDir: string;
  platform: NodeJS.Platform;
  /** VS Code's runtime, used through ELECTRON_RUN_AS_NODE when `node` is not on PATH. */
  execPath: string;
}

export const shimName = (platform: NodeJS.Platform) =>
  platform === 'win32' ? 'flowbook.cmd' : 'flowbook';

const MARKER = 'Written by the Flowbook VS Code extension ("Flowbook: Install CLI").';

export function shimText(platform: NodeJS.Platform, cli: string, execPath: string): string {
  if (platform === 'win32') {
    return [
      '@echo off',
      `rem ${MARKER}`,
      'where node >nul 2>nul',
      `if %errorlevel%==0 (node "${cli}" %*) else (set ELECTRON_RUN_AS_NODE=1& "${execPath}" "${cli}" %*)`,
      '',
    ].join('\r\n');
  }
  return [
    '#!/bin/sh',
    `# ${MARKER}`,
    'if command -v node >/dev/null 2>&1; then',
    `  exec node '${cli}' "$@"`,
    'fi',
    `ELECTRON_RUN_AS_NODE=1 exec '${execPath}' '${cli}' "$@"`,
    '',
  ].join('\n');
}

/** Copies the bundled CLI to the stable location; skipped when it is already identical. */
export function syncCli(o: Pick<CliInstall, 'bundled' | 'stable'>): void {
  const same =
    existsSync(join(o.stable, 'flowbook.js')) &&
    readFileSync(join(o.stable, 'flowbook.js')).equals(
      readFileSync(join(o.bundled, 'flowbook.js')),
    );
  if (same) return;
  rmSync(o.stable, { recursive: true, force: true });
  mkdirSync(o.stable, { recursive: true });
  cpSync(o.bundled, o.stable, { recursive: true });
}

/** Installs or refreshes the shim. Returns its path and whether `binDir` is on PATH. */
export function installCli(o: CliInstall, path = process.env.PATH ?? '') {
  syncCli(o);
  mkdirSync(o.binDir, { recursive: true });
  const shim = join(o.binDir, shimName(o.platform));
  writeFileSync(shim, shimText(o.platform, join(o.stable, 'flowbook.js'), o.execPath), {
    mode: 0o755,
  });
  const norm = (p: string) => (o.platform === 'win32' ? p.toLowerCase() : p).replace(/[\\/]+$/, '');
  const onPath = path
    .split(o.platform === 'win32' ? ';' : ':')
    .some((p) => norm(p) === norm(o.binDir));
  return { shim, onPath };
}

/** Whether this extension wrote the shim (so updates should refresh its target). */
export function hasShim(o: Pick<CliInstall, 'binDir' | 'platform'>): boolean {
  const shim = join(o.binDir, shimName(o.platform));
  return existsSync(shim) && readFileSync(shim, 'utf8').includes(MARKER);
}

export const SKILL_DIR = '.claude/skills/flowbook';

/** Copies the bundled skill into `<repo>/.claude/skills/flowbook`, replacing an older copy. */
export function installSkill(bundled: string, repo: string): string {
  const dest = join(repo, SKILL_DIR);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(bundled, dest, { recursive: true });
  return dest;
}
