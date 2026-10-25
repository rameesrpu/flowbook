import { describe, expect, it } from 'vitest';
import {
  anchorKey,
  buildGroups,
  collapseBelow,
  jsonSchemas,
  loadWorkspace,
  parseFlow,
  project,
  validateFlow,
  type Diagnostic,
} from './index.js';

const jsonl = (...records: object[]) => records.map((r) => JSON.stringify(r)).join('\n');

const login = jsonl(
  { kind: 'flow', id: 'login', title: 'User login', entry: 'main' },
  { kind: 'node', id: 'main', title: 'main', anchor: { file: 'src/app/main.c', symbol: 'main' } },
  {
    kind: 'node',
    id: 'auth',
    title: 'Authenticate',
    anchor: { file: 'src/auth/session.cpp', symbol: 'auth::Session::login' },
    flow: 'tls',
  },
  {
    kind: 'node',
    id: 'hash',
    title: 'Hash password',
    anchor: { file: 'src/auth/crypto/hash.c', symbol: 'hash_pw' },
  },
  { kind: 'node', id: 'db', title: 'User DB' },
  { kind: 'step', id: 's1', seq: 1, from: 'main', to: 'auth', label: 'start login' },
  { kind: 'step', id: 's2', seq: 2, from: 'auth', to: 'hash', label: 'hash input' },
  { kind: 'step', id: 's3', seq: 3, from: 'auth', to: 'db', label: 'look up user', type: 'async' },
  { kind: 'step', id: 's4', seq: 4, from: 'auth', to: 'main', label: 'ok', guard: 'match' },
  { kind: 'step', id: 's5', seq: 4, from: 'auth', to: 'main', label: 'denied', guard: 'mismatch' },
  { kind: 'block', id: 'b1', type: 'alt', label: 'password matches?', steps: ['s4', 's5'] },
);

const tls = jsonl(
  { kind: 'flow', id: 'tls', title: 'TLS' },
  { kind: 'node', id: 'a', title: 'a', anchor: { file: 'src/net/tls.c', symbol: 'tls_start' } },
);

function parse(text: string, file = '.flowbook/flows/login.jsonl') {
  const diags: Diagnostic[] = [];
  const flow = parseFlow(text, file, diags);
  return { flow, diags };
}

describe('parseFlow', () => {
  it('parses records and defaults step type to call', () => {
    const { flow, diags } = parse(login);
    expect(diags).toEqual([]);
    expect(flow!.nodes).toHaveLength(4);
    expect(flow!.steps[0]).toMatchObject({ id: 's1', type: 'call', line: 6 });
  });

  it('reports bad JSON and schema errors with line numbers and skips the line', () => {
    const { flow, diags } = parse(
      [
        '{"kind":"flow","id":"x","title":"X"}',
        '{oops',
        '{"kind":"node","id":"n","titel":"n"}',
      ].join('\n'),
    );
    expect(flow!.nodes).toHaveLength(0);
    expect(diags.map((d) => d.line)).toEqual([2, 3, 3]);
    expect(diags[0]!.message).toMatch(/invalid JSON/);
  });

  it('requires a flow record', () => {
    const { flow, diags } = parse('');
    expect(flow).toBeUndefined();
    expect(diags[0]!.message).toMatch(/missing/);
  });
});

describe('validateFlow', () => {
  it('accepts a well-formed flow, allowing alternatives to share seq', () => {
    expect(validateFlow(parse(login).flow!)).toEqual([]);
  });

  it('catches dangling references, duplicate seq and overlapping blocks', () => {
    const { flow } = parse(
      jsonl(
        { kind: 'flow', id: 'f', title: 'F', entry: 'nope' },
        { kind: 'node', id: 'a', title: 'a' },
        { kind: 'node', id: 'b', title: 'b' },
        { kind: 'step', id: 's1', seq: 1, from: 'a', to: 'ghost', label: 'x' },
        { kind: 'step', id: 's2', seq: 1, from: 'a', to: 'b', label: 'y' },
        { kind: 'step', id: 's3', seq: 3, from: 'b', to: 'a', label: 'z' },
        { kind: 'block', id: 'l1', type: 'loop', label: 'l', steps: ['s1', 's2'] },
        { kind: 'block', id: 'l2', type: 'loop', label: 'l', steps: ['s2', 's3', 'missing'] },
      ),
    );
    const messages = validateFlow(flow!).map((d) => `${d.severity}:${d.id}:${d.message}`);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^error:f:entry "nope"/),
        expect.stringMatching(/^error:s1:.*unknown node "ghost"/),
        expect.stringMatching(/^error:s2:seq 1 is already used/),
        expect.stringMatching(/^error:l2:block refers to unknown step "missing"/),
        expect.stringMatching(/^error:l2:block partially overlaps/),
        expect.stringMatching(/^warning:s3:seq numbers should run/),
      ]),
    );
  });
});

describe('loadWorkspace', () => {
  it('indexes anchors across flows and checks drill-down targets and file names', () => {
    const ws = loadWorkspace(undefined, [
      { path: '.flowbook/flows/login.jsonl', text: login },
      { path: '.flowbook/flows/tls-handshake.jsonl', text: tls },
    ]);
    expect(ws.diagnostics.map((d) => d.message)).toEqual([
      'flow id "tls" must match the file name "tls-handshake.jsonl"',
    ]);
    expect(ws.usages.get('src/app/main.c#main')).toEqual([{ flow: 'login', node: 'main' }]);
  });

  it('flags missing drill-down flows', () => {
    const ws = loadWorkspace(undefined, [{ path: '.flowbook/flows/login.jsonl', text: login }]);
    expect(ws.diagnostics.map((d) => d.message)).toEqual([
      'drill-down target flow "tls" does not exist',
    ]);
  });
});

describe('anchorKey', () => {
  it('normalizes signature whitespace', () => {
    const a = anchorKey({ file: 'a.cpp', symbol: 'f', sig: '(const char *, int)' });
    const b = anchorKey({ file: 'a.cpp', symbol: 'f', sig: '(const char*,int)' });
    expect(a).toBe(b);
  });
});

describe('buildGroups', () => {
  const { flow } = parse(login);

  it('derives modules from the first directory below the common root and merges folder chains', () => {
    const tree = buildGroups(flow!.nodes);
    const summary = [...tree.groups.values()].map((g) => `${g.depth}:${g.kind}:${g.label}`);
    expect(summary).toEqual([
      '0:module:app',
      '1:file:main.c',
      '0:module:auth',
      '1:file:session.cpp',
      '1:folder:crypto',
      '2:file:hash.c',
    ]);
    expect(tree.groupOf.has('db')).toBe(false);
  });

  it('uses configured groups first', () => {
    const tree = buildGroups(flow!.nodes, [
      { kind: 'group', name: 'Security', paths: ['src/auth/**'] },
    ]);
    expect(tree.roots).toEqual(['m:app', 'm:Security']);
    expect(tree.groups.get('m:Security')!.children).toEqual([
      'f:src/auth/session.cpp',
      'd:Security:src/auth/crypto',
    ]);
  });

  it('merges single-child folder chains', () => {
    const { flow: deep } = parse(
      jsonl(
        { kind: 'flow', id: 'd', title: 'd' },
        { kind: 'node', id: 'x', title: 'x', anchor: { file: 'lib/a/b/c/x.c', symbol: 'x' } },
        { kind: 'node', id: 'y', title: 'y', anchor: { file: 'src/y.c', symbol: 'y' } },
      ),
    );
    const tree = buildGroups(deep!.nodes);
    expect([...tree.groups.values()].map((g) => g.label)).toEqual([
      'lib',
      'a/b/c',
      'x.c',
      'src',
      'y.c',
    ]);
  });
});

describe('project', () => {
  const { flow } = parse(login);
  const tree = buildGroups(flow!.nodes);

  it('keeps one edge per step when nothing is collapsed', () => {
    const p = project(flow!, tree, new Set());
    expect(p.edges.map((e) => e.id)).toEqual(['s1', 's2', 's3', 's4', 's5']);
  });

  it('merges steps into collapsed groups and hides internal ones', () => {
    const p = project(flow!, tree, collapseBelow(tree, 0));
    expect(p.visibleOf.get('hash')).toBe('m:auth');
    expect(p.visibleOf.get('db')).toBe('db');
    expect(p.edges.map((e) => `${e.from}->${e.to}:${e.label}`)).toEqual([
      'm:app->m:auth:start login',
      'm:auth->db:look up user',
      'm:auth->m:app:2 steps',
    ]);
    expect(p.internal.get('m:auth')).toEqual(['s2']);
  });
});

describe('jsonSchemas', () => {
  it('emits a schema for flow lines', () => {
    const s = jsonSchemas() as { $defs: { flowLine: { oneOf?: unknown[]; anyOf?: unknown[] } } };
    expect((s.$defs.flowLine.oneOf ?? s.$defs.flowLine.anyOf)!.length).toBe(4);
  });
});
