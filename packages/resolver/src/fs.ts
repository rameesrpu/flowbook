import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  CONFIG_FILE,
  FLOWBOOK_DIR,
  FLOWS_DIR,
  loadWorkspace,
  type Workspace,
} from '@flowbook/core';
import type { ReadSource } from './anchors.js';

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
