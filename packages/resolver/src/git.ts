import { execFileSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';

function git(root: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
}

/** Full SHA of HEAD, or undefined outside a git repository. */
export function headCommit(root: string): string | undefined {
  return git(root, ['rev-parse', 'HEAD'])?.trim();
}

/**
 * HEAD of the git repository containing a root-relative file. This is the repository that
 * versions the code, which differs from the Flowbook root's when sources are a nested checkout.
 */
export function headCommitFor(root: string, path: string): string | undefined {
  return headCommit(dirname(join(root, path)));
}

/** Contents of a root-relative file at a commit of the repository containing it. */
export function fileAtCommit(root: string, sha: string, path: string): string | undefined {
  const full = join(root, path);
  // `./` resolves against the working directory, so this works below the repository top level.
  return git(dirname(full), ['show', `${sha}:./${basename(full)}`]);
}
