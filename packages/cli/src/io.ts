import { join, relative } from 'node:path';
import type { Diagnostic } from '@flowbook/core';

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

export const consoleIo: Io = {
  out: (line) => process.stdout.write(line + '\n'),
  err: (line) => process.stderr.write(line + '\n'),
};

/** Shows a root-relative path relative to the current directory, so terminals can link it. */
export function displayPath(root: string, file: string): string {
  return relative(process.cwd(), join(root, file)) || file;
}

/** `file:line: severity: message` — clickable in VS Code terminals. */
export function formatDiagnostic(d: Diagnostic, root = process.cwd()): string {
  const where = d.file ? `${displayPath(root, d.file)}${d.line ? `:${d.line}` : ''}: ` : '';
  return `${where}${d.severity}: ${d.message}`;
}

export function sortDiagnostics(ds: Diagnostic[]): Diagnostic[] {
  return [...ds].sort(
    (a, b) => (a.file ?? '').localeCompare(b.file ?? '') || (a.line ?? 0) - (b.line ?? 0),
  );
}
