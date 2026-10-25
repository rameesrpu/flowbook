// Smoke test: launches VS Code on fixtures/cpp-sample with this extension and runs test/suite.cjs.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

// When launched from a VS Code terminal this is set and would make Electron run as plain Node.
delete process.env.ELECTRON_RUN_AS_NODE;

const here = dirname(fileURLToPath(import.meta.url));
const extension = join(here, '..');
try {
  await runTests({
    extensionDevelopmentPath: extension,
    extensionTestsPath: join(here, 'suite.cjs'),
    // Under node_modules so linters and git ignore the downloaded VS Code.
    cachePath: join(extension, 'node_modules', '.vscode-test'),
    launchArgs: [
      join(extension, '..', '..', 'fixtures', 'cpp-sample'),
      '--disable-extensions',
      '--disable-workspace-trust',
      '--skip-welcome',
    ],
  });
} catch (e) {
  console.error('smoke test failed:', e);
  process.exit(1);
}
