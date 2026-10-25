import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasShim, installCli, installSkill, shimText } from './install.js';

const repo = resolve(fileURLToPath(import.meta.url), '../../../..');
const cliDist = join(repo, 'packages/cli/dist');

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'flowbook-install-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('installCli', () => {
  it('writes a working shim that runs the stable copy', () => {
    const o = {
      bundled: cliDist,
      stable: join(tmp, 'storage/cli'),
      binDir: join(tmp, 'bin'),
      platform: process.platform,
      execPath: process.execPath,
    };
    const { shim, onPath } = installCli(o, `/usr/bin:${o.binDir}/`);
    expect(onPath).toBe(true);
    expect(hasShim(o)).toBe(true);
    expect(readFileSync(shim, 'utf8')).toContain(join(o.stable, 'flowbook.js'));
    const out = execFileSync(shim, ['check', '--root', join(repo, 'fixtures/cpp-sample')], {
      encoding: 'utf8',
    });
    expect(out).toMatch(/2 flows, 17 nodes: 0 errors/);
  });

  it('refreshes the stable copy when the bundled CLI changes', () => {
    const bundled = join(tmp, 'bundled');
    cpSync(cliDist, bundled, { recursive: true });
    const o = {
      bundled,
      stable: join(tmp, 'stable'),
      binDir: join(tmp, 'bin'),
      platform: 'linux' as const,
      execPath: '/opt/code',
    };
    expect(installCli(o, '/usr/bin').onPath).toBe(false);
    writeFileSync(join(bundled, 'flowbook.js'), '// v2');
    installCli(o);
    expect(readFileSync(join(o.stable, 'flowbook.js'), 'utf8')).toBe('// v2');
  });

  it('falls back to VS Code’s runtime on Windows', () => {
    expect(shimText('win32', 'C:\\s\\flowbook.js', 'C:\\Code\\Code.exe')).toContain(
      'set ELECTRON_RUN_AS_NODE=1& "C:\\Code\\Code.exe" "C:\\s\\flowbook.js" %*',
    );
  });
});

describe('installSkill', () => {
  it('copies SKILL.md and references into .claude/skills/flowbook', () => {
    const dest = installSkill(join(repo, 'skill/flowbook'), tmp);
    expect(existsSync(join(dest, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(dest, 'references/schema.md'))).toBe(true);
  });
});
