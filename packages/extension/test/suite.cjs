// Runs inside the VS Code extension host (see run.mjs).
/* eslint-disable @typescript-eslint/no-require-imports -- VS Code loads test suites as CommonJS. */
const assert = require('node:assert/strict');
const vscode = require('vscode');

async function waitFor(fn, what, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function flowsIn(tree, item) {
  return tree
    .getChildren(item)
    .flatMap((child) => (child.kind === 'flow' ? [child] : flowsIn(tree, child)));
}

exports.run = async function run() {
  const ext = vscode.extensions.getExtension('rameesrpu.flowbook');
  assert.ok(ext, 'extension is installed');
  const api = await waitFor(async () => (ext.isActive ? ext.exports : undefined), 'activation');
  console.log('activated');

  const ids = [...new Set(flowsIn(api.tree).map((i) => i.flow.meta.id))].sort();
  assert.deepEqual(ids, ['packet-handling', 'startup']);
  console.log('tree flows:', ids.join(', '));

  const [root] = api.flowbook.roots.keys();
  await vscode.commands.executeCommand('flowbook.openFlow', root, 'startup');
  assert.deepEqual(
    api.panels.open.map((p) => p.flowId),
    ['startup'],
  );
  console.log('panel open');
  if (require('node:fs').existsSync(`${ext.extensionPath}/dist/webview/webview.js`)) {
    // The webview script ran under the CSP and asked for its payload.
    await waitFor(() => api.panels.open[0].ready, 'webview ready message', 20000);
    console.log('webview ready');
    // Give the diagram time to render; the webview reports any uncaught error to the host.
    await new Promise((r) => setTimeout(r, 3000));
    assert.deepEqual(api.panels.open[0].errors, [], 'webview errors');
    console.log('webview rendered without errors');
  } else console.log('webview not built; skipped ready check');

  const summary = await vscode.commands.executeCommand('flowbook.check');
  assert.equal(summary.errors, 0);
  const errors = [];
  api.flowbook.problemCollection.forEach((uri, diags) => {
    for (const d of diags) {
      if (d.severity === vscode.DiagnosticSeverity.Error)
        errors.push(`${uri.fsPath}: ${d.message}`);
    }
  });
  assert.deepEqual(errors, []);
  console.log('check: no errors,', summary.warnings, 'warnings');

  // CodeLens on an anchored C++ definition.
  const doc = await vscode.workspace.openTextDocument(
    vscode.Uri.file(`${root}/src/net/event_loop.cpp`),
  );
  const lenses = await waitFor(async () => {
    const l = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', doc.uri, 10);
    return l && l.length ? l : undefined;
  }, 'code lenses');
  const titles = lenses.map((l) => l.command && l.command.title).filter(Boolean);
  assert.ok(titles.includes('Flowbook: in 2 flows'), titles.join(' | '));
  console.log('code lenses:', titles.join(' | '));

  // Connection lenses on a C file, and Go to Reactor from a send line.
  const jobs = await vscode.workspace.openTextDocument(vscode.Uri.file(`${root}/src/rt/jobs.c`));
  await vscode.window.showTextDocument(jobs);
  const connTitles = await waitFor(
    async () => {
      const l = await vscode.commands.executeCommand(
        'vscode.executeCodeLensProvider',
        jobs.uri,
        50,
      );
      const t = (l || []).map((x) => x.command && x.command.title).filter(Boolean);
      return t.some((x) => x.startsWith('↳ Read confirmation:')) ? t : undefined;
    },
    'connection lenses',
    20000,
  );
  assert.ok(connTitles.includes('↳ 2 keys · posted from 2 places'), connTitles.join(' | '));
  console.log('connection lenses:', connTitles.join(' | '));
  const sendLine = jobs
    .getText()
    .split('\n')
    .findIndex((s) => s.includes('JOB_READ_CNF, read_done'));
  await vscode.commands.executeCommand('flowbook.goToReactor', jobs.uri, sendLine);
  const here = vscode.window.activeTextEditor;
  assert.ok(here.document.lineAt(here.selection.active.line).text.includes('case JOB_READ_CNF'));
  console.log(
    'go to reactor: landed on',
    here.document.lineAt(here.selection.active.line).text.trim(),
  );
};
