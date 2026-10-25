import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  CONFIG_FILE,
  FLOWBOOK_DIR,
  FLOWS_DIR,
  loadWorkspace,
  type Workspace,
} from '@flowbook/core';
import type { ListFiles, ReadSource } from './anchors.js';

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

export function readWorkspace(root: string): Workspace {
  const configPath = join(root, CONFIG_FILE);
  const config = existsSync(configPath)
    ? { path: CONFIG_FILE, text: readFileSync(configPath, 'utf8') }
    : undefined;
  const flows = listFlowFiles(root).map((path) => ({
    path,
    text: readFileSync(join(root, path), 'utf8'),
  }));
  return loadWorkspace(config, flows);
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

const SKIP_DIRS = new Set(['node_modules', 'build', 'out', 'dist', 'target', 'bin', 'obj']);
const MAX_FILES = 50_000;

/**
 * Lists repo-relative file paths under `root` for "did you mean" hints. Skips hidden and build
 * directories and stops after MAX_FILES entries so huge trees stay cheap.
 */
export function fileLister(root: string): ListFiles {
  return () => {
    const out: string[] = [];
    const walk = (rel: string) => {
      let entries;
      try {
        entries = readdirSync(join(root, rel), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (out.length >= MAX_FILES) return;
        if (e.name.startsWith('.')) continue;
        const path = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('cmake-build-')) walk(path);
        } else if (e.isFile()) out.push(path);
      }
    };
    walk('');
    return out.sort();
  };
}
