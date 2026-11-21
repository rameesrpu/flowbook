import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/out/**',
      '**/node_modules/**',
      '**/.vscode-test/**',
      'examples/*/src/**',
    ],
  },
  ...tseslint.configs.recommended,
);
