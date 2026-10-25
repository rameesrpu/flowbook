import { execFileSync } from 'node:child_process';

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

/** Contents of a repo-relative file at a commit, or undefined if unavailable. */
export function fileAtCommit(root: string, sha: string, path: string): string | undefined {
  // `./` makes the path relative to `root` even when it is not the top of the git repository.
  return git(root, ['show', `${sha}:./${path}`]);
}
