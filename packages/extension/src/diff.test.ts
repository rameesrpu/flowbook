import { describe, expect, it } from 'vitest';
import { diffLines, unifiedDiff } from './diff.js';

const lines = (s: string) => s.split('\n');

describe('diffLines', () => {
  it('keeps equal input unchanged', () => {
    expect(diffLines(['a', 'b'], ['a', 'b'])).toEqual([
      { kind: ' ', text: 'a' },
      { kind: ' ', text: 'b' },
    ]);
  });

  it('finds a minimal edit', () => {
    const ops = diffLines(lines('a\nb\nc\nd'), lines('a\nx\nc\nd\ne'));
    expect(ops.map((o) => o.kind + o.text)).toEqual([' a', '-b', '+x', ' c', ' d', '+e']);
  });

  it('handles empty sides', () => {
    expect(diffLines([], ['a']).map((o) => o.kind)).toEqual(['+']);
    expect(diffLines(['a'], []).map((o) => o.kind)).toEqual(['-']);
  });

  it('applying the ops reproduces both sides', () => {
    const a = lines('1\n2\n3\n4\n5\n6\n7\n8');
    const b = lines('0\n1\n3\n4\nfour\n5\n7\n8\n9');
    const ops = diffLines(a, b);
    expect(ops.filter((o) => o.kind !== '+').map((o) => o.text)).toEqual(a);
    expect(ops.filter((o) => o.kind !== '-').map((o) => o.text)).toEqual(b);
    expect(ops.filter((o) => o.kind === ' ')).toHaveLength(6);
  });
});

describe('unifiedDiff', () => {
  it('is empty when nothing changed', () => {
    expect(unifiedDiff(['a'], ['a'])).toBe('');
  });

  it('emits one hunk with context and file line numbers', () => {
    const a = lines('l1\nl2\nl3\nl4\nl5\nl6\nl7');
    const b = lines('l1\nl2\nl3\nL4\nl5\nl6\nl7');
    expect(unifiedDiff(a, b, { oldStart: 10, newStart: 12 })).toBe(
      ['@@ -10,7 +12,7 @@', ' l1', ' l2', ' l3', '-l4', '+L4', ' l5', ' l6', ' l7'].join('\n'),
    );
  });

  it('splits distant changes into separate hunks', () => {
    const a = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const b = [...a];
    b[1] = 'changed 2';
    b[17] = 'changed 18';
    const out = unifiedDiff(a, b, { context: 2 });
    expect(out.split('\n').filter((l) => l.startsWith('@@'))).toEqual([
      '@@ -1,4 +1,4 @@',
      '@@ -16,5 +16,5 @@',
    ]);
  });

  it('merges nearby changes and reports pure insertions', () => {
    const out = unifiedDiff(['a', 'b'], ['a', 'b', 'c'], { context: 0 });
    expect(out).toBe('@@ -2,0 +3,1 @@\n+c');
  });
});
