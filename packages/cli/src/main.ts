import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { findRoot, Resolver } from '@flowbook/resolver';
import { check, resolve, stale, stamp } from './commands.js';
import { consoleIo } from './io.js';

const HELP = `flowbook — validate and maintain .flowbook flow diagrams

Usage:
  flowbook check [--strict] [--json]     validate schema, references and code anchors
  flowbook resolve <file> [symbol] [--sig "(int)"]
                                         list definitions in a file, or resolve one to an anchor
  flowbook stamp <flow-id...> | --all    record current fingerprints and HEAD commit
  flowbook stale [--json]                list nodes whose code changed or disappeared

Options:
  --root <dir>   repository root (default: nearest parent containing .flowbook/)
  --strict       treat stale nodes as errors (for CI)
  -h, --help     show this help`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      root: { type: 'string' },
      sig: { type: 'string' },
      strict: { type: 'boolean' },
      json: { type: 'boolean' },
      all: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, ...args] = positionals;
  if (values.help || !command) {
    consoleIo.out(HELP);
    return command || values.help ? 0 : 1;
  }
  // `resolve` is used before any flow exists, so it falls back to the current directory.
  // It looks next to the file too, then treats the current directory as the repo root.
  const root =
    values.root ??
    findRoot(process.cwd()) ??
    (command === 'resolve' && args[0]
      ? (findRoot(dirname(resolvePath(args[0]))) ?? process.cwd())
      : undefined);
  if (!root) {
    consoleIo.err(
      'error: no .flowbook/ directory found here or in any parent; create .flowbook/flows/',
    );
    return 1;
  }
  const resolver = await Resolver.create({ wasmDir: dirname(fileURLToPath(import.meta.url)) });
  const ctx = { root, resolver, io: consoleIo };
  switch (command) {
    case 'check':
      return check(ctx, values);
    case 'resolve':
      if (!args[0]) break;
      return resolve(ctx, args[0], args[1], values.sig);
    case 'stamp':
      return stamp(ctx, args, values.all);
    case 'stale':
      return stale(ctx, values);
  }
  consoleIo.err(HELP);
  return 1;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    consoleIo.err(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  },
);
