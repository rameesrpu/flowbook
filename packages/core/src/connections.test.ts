import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
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
