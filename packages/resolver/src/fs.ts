import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  CONFIG_FILE,
  CONNECTIONS_FILE,
  FLOWBOOK_DIR,
  FLOWS_DIR,
  loadWorkspace,
  type Workspace,
} from '@flowbook/core';
import type { ReadSource } from './anchors.js';
import { SOURCE_EXTENSIONS } from './resolver.js';

/** Walks up from `start` to the nearest directory containing `.flowbook/`. */
export function findRoot(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, FLOWBOOK_DIR))) return dir;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

export function listFlowFiles(root: string): string[] {
  const dir = join(root, FLOWS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .map((f) => `${FLOWS_DIR}/${f}`);
}

const SKIPPED_DIRS = new Set(['node_modules', 'build', 'dist', 'out']);

/**
 * Root-relative POSIX paths of source files; skips dot-directories, node_modules, build, dist, out
 * and symbolic links. Sorted. Synchronous, also under `scanRootSliced`: on 2026-11-15 a walk of
 * 2,416 source files (`/usr/include`, warm disk cache, Core i3-8145U) took 5 ms.
 */
export function listSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    let entries;
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!e.name.startsWith('.') && !SKIPPED_DIRS.has(e.name)) walk(path);
      } else if (e.isFile() && SOURCE_EXTENSIONS.test(e.name)) out.push(path);
    }
  };
  walk('');
  return out.sort();
}

export function readWorkspace(root: string): Workspace {
  const configPath = join(root, CONFIG_FILE);
  const config = existsSync(configPath)
    ? { path: CONFIG_FILE, text: readFileSync(configPath, 'utf8') }
    : undefined;
  const flows = listFlowFiles(root).map((path) => ({
    path,
    text: readFileSync(join(root, path), 'utf8'),
  }));
  const connectionsPath = join(root, CONNECTIONS_FILE);
  const connections = existsSync(connectionsPath)
    ? { path: CONNECTIONS_FILE, text: readFileSync(connectionsPath, 'utf8') }
    : undefined;
  return loadWorkspace(config, flows, connections);
}

export function sourceReader(root: string): ReadSource {
  return (path) => {
    try {
      return readFileSync(join(root, path), 'utf8');
    } catch {
      return undefined;
    }
  };
}
