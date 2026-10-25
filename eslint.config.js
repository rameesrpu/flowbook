import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/out/**', '**/node_modules/**', '**/.vscode-test/**'] },
  ...tseslint.configs.recommended,
);
