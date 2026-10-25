// Bundles the extension host into dist/extension.cjs, copies the tree-sitter WASM files next to
// it, the webview build into dist/webview/, the CLI into dist/cli/ and the skill into dist/skill/.
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, context } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'dist');
const watch = process.argv.includes('--watch');

mkdirSync(dist, { recursive: true });

const require = createRequire(import.meta.resolve('@flowbook/resolver'));
for (const wasm of [
  'web-tree-sitter/web-tree-sitter.wasm',
  'tree-sitter-c/tree-sitter-c.wasm',
  'tree-sitter-cpp/tree-sitter-cpp.wasm',
]) {
  copyFileSync(require.resolve(wasm), join(dist, wasm.split('/')[1]));
}

const webviewSrc = join(here, '..', 'webview', 'dist');
const webviewOut = join(dist, 'webview');
rmSync(webviewOut, { recursive: true, force: true });
if (existsSync(join(webviewSrc, 'webview.js'))) {
  cpSync(webviewSrc, webviewOut, { recursive: true });
} else {
  console.warn(
    `warning: ${webviewSrc}/webview.js not found; build @flowbook/webview first. ` +
      'Flow panels will show a placeholder.',
  );
}

// The CLI (installed as a `flowbook` command by "Flowbook: Install CLI") and the agent skill.
const cliSrc = join(here, '..', 'cli', 'dist');
rmSync(join(dist, 'cli'), { recursive: true, force: true });
if (existsSync(join(cliSrc, 'flowbook.js'))) {
  cpSync(cliSrc, join(dist, 'cli'), { recursive: true });
  // flowbook.js is ESM; without this Node warns when run from outside the CLI package.
  writeFileSync(join(dist, 'cli', 'package.json'), '{ "type": "module" }\n');
} else {
  console.warn(`warning: ${cliSrc}/flowbook.js not found; build @flowbook/cli first.`);
}
rmSync(join(dist, 'skill'), { recursive: true, force: true });
cpSync(join(here, '..', '..', 'skill', 'flowbook'), join(dist, 'skill'), { recursive: true });

const options = {
  entryPoints: [join(here, 'src', 'extension.ts')],
  outfile: join(dist, 'extension.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info',
  // Bundled ESM dependencies read `import.meta.url`; give them the bundle's own URL.
  define: { 'import.meta.url': '__flowbookImportMetaUrl' },
  banner: {
    js: "const __flowbookImportMetaUrl = require('node:url').pathToFileURL(__filename).href;",
  },
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
