import { matcherRegex, matchesAny, type Matcher, type RuleRecord } from '@flowbook/core';
import type { Node, Tree } from 'web-tree-sitter';
import type { SymbolInfo } from './symbols.js';

export type MatcherKind = 'call' | 'case' | 'test' | 'assign' | 'invoke';

/** A place where code sends or receives through a rule. Lines and columns are 0-based. */
export interface Site {
  rule: string;
  role: 'send' | 'receive';
  matcher: MatcherKind;
  file: string;
  /** Position of the matched name (callee, case value, identifier, field). */
  line: number;
  column: number;
  /** Enclosing function definition; absent at file scope. */
  symbol?: string;
  sig?: string;
  key?: string;
  /** Identifier only. */
  handler?: string;
  /** The handler argument or right-hand side was not an identifier. */
  unresolvedHandler?: true;
}

export interface FileScan {
  symbols: SymbolInfo[];
  sites: Site[];
}

interface Compiled {
  rule: string;
  role: 'send' | 'receive';
  kind: MatcherKind;
  re: RegExp;
  matcher: Matcher;
}

const CONDITIONS = new Set(['if_statement', 'while_statement', 'conditional_expression']);

const kindOf = (m: Matcher): MatcherKind =>
  'call' in m
    ? 'call'
    : 'case' in m
      ? 'case'
      : 'test' in m
        ? 'test'
        : 'assign' in m
          ? 'assign'
          : 'invoke';

const nameOf = (m: Matcher): string =>
  'call' in m
    ? m.call
    : 'case' in m
      ? m.case
      : 'test' in m
        ? m.test
        : 'assign' in m
          ? m.assign
          : m.invoke;

const compact = (node: Node) => node.text.replace(/\s+/g, '');

/** The matcher's regular expression, or undefined when invalid (core reports that error). */
export function compileName(name: string): RegExp | undefined {
  try {
    return matcherRegex(name);
  } catch {
    return undefined;
  }
}

function compile(rules: RuleRecord[], file: string): Compiled[] {
  const out: Compiled[] = [];
  for (const rule of rules) {
    for (const role of ['send', 'receive'] as const) {
      for (const matcher of rule[role] ?? []) {
        if (!matchesAny(file, matcher.files)) continue;
        const re = compileName(nameOf(matcher));
        if (re) out.push({ rule: rule.id, role, kind: kindOf(matcher), re, matcher });
      }
    }
  }
  return out;
}

/** Finds the send and receive sites of `rules` in a parsed file. */
export function collectSites(
  tree: Tree,
  file: string,
  rules: RuleRecord[],
  symbols: SymbolInfo[],
): Site[] {
  const compiled = compile(rules, file);
  if (compiled.length === 0) return [];
  const byKind = (kind: MatcherKind) => compiled.filter((c) => c.kind === kind);
  const calls = byKind('call');
  const cases = byKind('case');
  const tests = byKind('test');
  const assigns = byKind('assign');
  const invokes = byKind('invoke');
  const functions = symbols.filter((s) => s.kind === 'function');
  const out: Site[] = [];

  const add = (c: Compiled, at: Node, extra: Partial<Site> = {}) => {
    const line = at.startPosition.row;
    let enclosing: SymbolInfo | undefined;
    for (const f of functions) {
      if (f.startLine <= line && line <= f.endLine) {
        if (!enclosing || f.startLine >= enclosing.startLine) enclosing = f;
      }
    }
    const site: Site = {
      rule: c.rule,
      role: c.role,
      matcher: c.kind,
      file,
      line,
      column: at.startPosition.column,
    };
    if (enclosing) {
      site.symbol = enclosing.symbol;
      site.sig = enclosing.sig;
    }
    Object.assign(site, extra);
    out.push(site);
  };

  /** An identifier, possibly wrapped in any number of `&` or parentheses. */
  const unwrap = (node: Node): Node | null => {
    if (node.type === 'identifier') return node;
    if (node.type === 'parenthesized_expression') {
      const inner = node.namedChildren.find((n) => n !== null && n.type !== 'comment');
      return inner ? unwrap(inner) : null;
    }
    if (node.type === 'pointer_expression' && node.child(0)?.text === '&') {
      const arg = node.childForFieldName('argument');
      return arg ? unwrap(arg) : null;
    }
    return null;
  };

  /** `NULL`, `nullptr` or `0`, possibly wrapped in `&` or parentheses: a slot being cleared. */
  const isNull = (node: Node): boolean => {
    if (node.type === 'parenthesized_expression') {
      const inner = node.namedChildren.find((n) => n !== null && n.type !== 'comment');
      return !!inner && isNull(inner);
    }
    if (node.type === 'pointer_expression' && node.child(0)?.text === '&') {
      const arg = node.childForFieldName('argument');
      return !!arg && isNull(arg);
    }
    return node.text === 'NULL' || node.text === 'nullptr' || node.text === '0';
  };

  const handlerOf = (node: Node | null | undefined): Partial<Site> => {
    if (!node) return {};
    const id = unwrap(node);
    return id ? { handler: id.text } : { unresolvedHandler: true };
  };

  const visitCall = (node: Node) => {
    const fn = node.childForFieldName('function');
    if (!fn) return;
    const args = (node.childForFieldName('arguments')?.namedChildren ?? []).filter(
      (n): n is Node => n !== null && n.type !== 'comment',
    );
    if (fn.type === 'field_expression') {
      const field = fn.childForFieldName('field');
      if (!field) return;
      for (const c of invokes) {
        if (c.re.test(field.text)) add(c, field, { key: field.text });
      }
      return;
    }
    if (fn.type !== 'identifier' && fn.type !== 'qualified_identifier') return;
    const name = compact(fn);
    for (const c of calls) {
      if (!c.re.test(name) || !('call' in c.matcher)) continue;
      const extra: Partial<Site> = {};
      const { key, handler } = c.matcher;
      if (key !== undefined && args[key - 1]) extra.key = compact(args[key - 1]!);
      if (handler !== undefined) Object.assign(extra, handlerOf(args[handler - 1]));
      add(c, fn, extra);
    }
  };

  const visitAssign = (field: Node, right: Node | null) => {
    for (const c of assigns) {
      if (!c.re.test(field.text) || !('assign' in c.matcher)) continue;
      if (c.matcher.as === 'handler') {
        // Clearing a slot registers nothing.
        if (right && isNull(right)) continue;
        add(c, field, { key: field.text, ...handlerOf(right) });
      } else if (right) add(c, field, { key: compact(right) });
    }
  };

  const visitIdentifiers = (node: Node) => {
    if (node.type === 'identifier') {
      for (const c of tests) {
        if (c.re.test(node.text)) add(c, node, { key: node.text });
      }
    }
    for (const child of node.namedChildren) if (child) visitIdentifiers(child);
  };

  const visit = (node: Node) => {
    switch (node.type) {
      case 'call_expression':
        visitCall(node);
        break;
      case 'case_statement': {
        const value = node.childForFieldName('value');
        if (value && (value.type === 'identifier' || value.type === 'qualified_identifier')) {
          const name = compact(value);
          for (const c of cases) if (c.re.test(name)) add(c, value, { key: name });
        }
        break;
      }
      case 'assignment_expression': {
        const left = node.childForFieldName('left');
        if (left?.type === 'field_expression') {
          const field = left.childForFieldName('field');
          if (field) visitAssign(field, node.childForFieldName('right'));
        }
        break;
      }
      case 'initializer_pair': {
        const designator = node.childForFieldName('designator');
        const field = designator?.type === 'field_designator' ? designator.namedChildren[0] : null;
        if (field) visitAssign(field, node.childForFieldName('value'));
        break;
      }
    }
    if (CONDITIONS.has(node.type)) {
      const cond = node.childForFieldName('condition');
      if (cond && tests.length > 0) visitIdentifiers(cond);
    }
    for (const child of node.namedChildren) if (child) visit(child);
  };
  visit(tree.rootNode);
  return out;
}
