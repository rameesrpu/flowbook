// Bundles the CLI into dist/flowbook.js and copies the tree-sitter WASM files next to it.
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.resolve('@flowbook/resolver'));
mkdirSync('dist', { recursive: true });
for (const wasm of [
  'web-tree-sitter/web-tree-sitter.wasm',
  'tree-sitter-c/tree-sitter-c.wasm',
  'tree-sitter-cpp/tree-sitter-cpp.wasm',
]) {
  copyFileSync(require.resolve(wasm), `dist/${wasm.split('/')[1]}`);
}
await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/flowbook.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});
