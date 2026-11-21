import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  isDispatcherForm,
  jsonSchemas,
  loadWorkspace,
  matcherRegex,
  matchesAny,
  parseConnections,
  validateConnections,
} from './index.js';

const FIXTURE = fileURLToPath(
  new URL('../../../fixtures/cpp-sample/.flowbook/connections.jsonl', import.meta.url),
);
const fixture = readFileSync(FIXTURE, 'utf8');
const F = '.flowbook/connections.jsonl';

function all(text: string) {
  const diagnostics: import('./index.js').Diagnostic[] = [];
  const c = parseConnections(text, F, diagnostics);
  return [...diagnostics, ...validateConnections(c, F)];
}
const diag = (text: string) => all(text).map((d) => d.message);

const rule = (extra: string, id = 'r') =>
  `{"kind":"rule","id":"${id}","title":"T","type":"queue",${extra}}`;

const ANCHOR = '{"file":"a.c","symbol":"main"}';
const withConn = (ruleExtra: string, connExtra: string, id = 'd') =>
  `${rule(ruleExtra, 'job')}\n{"kind":"connection","id":"${id}","rule":"job","title":"T"${connExtra}}`;
const R = '"send":[{"call":"a"}],"receive":[{"case":"x"}]';

describe('1b rule fields', () => {
  it('accepts keyMember and keys on call and assign', () => {
    expect(
      diag(
        rule(
          '"send":[{"call":"post","key":1,"keyMember":true,"keys":"BOX_.*"}],"receive":[{"assign":"type","as":"key","keyMember":true,"keys":"JOB_(A|B)"}]',
        ),
      ),
    ).toEqual([]);
  });

  it('rejects keyMember without a key', () => {
    expect(
      diag(rule('"send":[{"call":"post","keyMember":true}],"receive":[{"case":"x"}]')),
    ).toEqual(['"keyMember" needs "key"']);
    expect(
      diag(
        rule('"send":[{"call":"a"}],"receive":[{"assign":"h","as":"handler","keyMember":true}]'),
      ),
    ).toEqual(['"keyMember" needs "as": "key"']);
  });

  it('reports an invalid keys expression', () => {
    const m = diag(rule('"send":[{"call":"post","key":1,"keys":"("}],"receive":[{"case":"x"}]'));
    expect(m.length).toBe(1);
    expect(m[0]!.startsWith('invalid regular expression "("')).toBe(true);
  });

  it('accepts a dispatcher connection', () => {
    expect(diag(withConn(R, `,"receive":[${ANCHOR}]`))).toEqual([]);
  });

  it('rejects send without receive', () => {
    expect(diag(withConn(R, `,"send":[${ANCHOR}]`))).toEqual([
      'an anchored connection needs non-empty "send" and "receive"',
    ]);
  });

  it('rejects a dispatcher on a rule without receive matchers', () => {
    const text = `{"kind":"rule","id":"timer","title":"T","type":"timer","send":[{"call":"f","handler":2}]}\n{"kind":"connection","id":"d","rule":"timer","title":"T","receive":[${ANCHOR}]}`;
    expect(diag(text)).toEqual([
      'dispatcher connection "d": rule "timer" has no "receive" matchers',
    ]);
  });

  it('keeps only the unknown-rule error for a dispatcher on an unknown rule', () => {
    const text = `{"kind":"connection","id":"d","rule":"nope","title":"T","receive":[${ANCHOR}]}`;
    expect(diag(text)).toEqual(['unknown rule "nope"']);
  });

  it('requires some form', () => {
    expect(diag(withConn(R, ''))).toEqual([
      'a connection needs "key", "receive", or "send" and "receive"',
    ]);
  });

  it('exports isDispatcherForm', () => {
    const c = parseConnections(withConn(R, `,"receive":[${ANCHOR}]`), F);
    expect(isDispatcherForm(c.connections[0]!)).toBe(true);
  });
});

describe('connections', () => {
  it('parses the fixture: 5 rules, 2 connections, no diagnostics', () => {
    const c = parseConnections(fixture, F);
    expect(c.rules.length).toBe(5);
    expect(c.connections.length).toBe(2);
    expect(diag(fixture)).toEqual([]);
  });

  it('keeps the line of each record', () => {
    const c = parseConnections(fixture, F);
    expect(c.rules[0]!.line).toBe(1);
    expect(c.connections[1]!.line).toBe(7);
  });

  it('rejects unknown fields and a matcher with two kinds', () => {
    const two = all(rule('"send":[{"call":"a","case":"b"}],"receive":[{"case":"x"}]'));
    expect(two.some((d) => d.severity === 'error' && d.line === 1)).toBe(true);
    const extra = all(rule('"send":[{"call":"a"}],"receive":[{"case":"x"}],"bogus":1'));
    expect(extra.some((d) => d.severity === 'error' && d.line === 1)).toBe(true);
  });

  it('rejects a call matcher position below 1', () => {
    const d = all(rule('"send":[{"call":"a","key":0}],"receive":[{"case":"x"}]'));
    expect(d.some((x) => x.severity === 'error')).toBe(true);
  });

  it('reports an invalid regular expression once, on its line', () => {
    const d = all(rule('"send":[{"call":"foo("}],"receive":[{"case":"x"}]'));
    expect(d.length).toBe(1);
    expect(d[0]!.severity).toBe('error');
    expect(d[0]!.line).toBe(1);
    expect(d[0]!.message).toContain('invalid regular expression');
  });

  it('reports a duplicate id', () => {
    const line = rule('"send":[{"call":"a"}],"receive":[{"case":"x"}]', 'job');
    const d = all(`${line}\n${line}`);
    expect(d.length).toBe(1);
    expect(d[0]!.severity).toBe('error');
    expect(d[0]!.line).toBe(2);
    expect(d[0]!.message).toContain('line 1');
  });

  it('reports a connection naming an unknown rule', () => {
    const text = `${rule('"send":[{"call":"a"}],"receive":[{"case":"x"}]')}\n{"kind":"connection","id":"c","rule":"nope","title":"C","key":"K"}`;
    expect(diag(text).some((m) => m.includes('unknown rule "nope"'))).toBe(true);
  });

  it('requires exactly one form', () => {
    const base = rule('"send":[{"call":"a"}],"receive":[{"case":"x"}]');
    const anchor = '{"file":"a.c","symbol":"f"}';
    const conn = (extra: string) =>
      `${base}\n{"kind":"connection","id":"c","rule":"r","title":"C"${extra}}`;
    expect(diag(conn(`,"key":"K","send":[${anchor}]`)).length).toBeGreaterThan(0);
    expect(diag(conn('')).length).toBeGreaterThan(0);
    expect(diag(conn(`,"send":[${anchor}]`)).length).toBeGreaterThan(0);
    expect(diag(conn(',"key":"K"'))).toEqual([]);
    expect(diag(conn(`,"send":[${anchor}],"receive":[${anchor}]`))).toEqual([]);
  });

  it('requires receive matchers unless every send matcher names a handler', () => {
    expect(diag(rule('"send":[{"call":"f"}]')).length).toBeGreaterThan(0);
    expect(diag(rule('"send":[{"call":"f","handler":2}]'))).toEqual([]);
  });

  it('matcherRegex matches the whole name', () => {
    expect(matcherRegex('JOB_.*').test('JOB_X')).toBe(true);
    expect(matcherRegex('job').test('job_post')).toBe(false);
    expect(() => matcherRegex('foo(')).toThrow();
  });

  it('matchesAny is true without globs', () => {
    expect(matchesAny('a/b.c', undefined)).toBe(true);
    expect(matchesAny('a/b.c', ['src/**'])).toBe(false);
    expect(matchesAny('src/b.c', ['src/**'])).toBe(true);
  });

  it('loadWorkspace without a connections file yields empty connections and no diagnostics', () => {
    const ws = loadWorkspace(undefined, []);
    expect(ws.connections).toEqual({ rules: [], connections: [] });
    expect(ws.diagnostics).toEqual([]);
  });

  it('loadWorkspace reports connection diagnostics', () => {
    const ws = loadWorkspace(undefined, [], { path: F, text: fixture });
    expect(ws.connections.rules.length).toBe(5);
    expect(ws.diagnostics).toEqual([]);
    const bad = loadWorkspace(undefined, [], { path: F, text: 'nope' });
    expect(bad.diagnostics.length).toBe(1);
  });

  it('jsonSchemas has a connectionsLine definition', () => {
    expect(jsonSchemas().$defs.connectionsLine).toBeDefined();
  });
});
