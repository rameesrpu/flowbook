import { matchesAny, type MachineRecord, type TableSpec } from '@flowbook/core';
import type { Node, Tree } from 'web-tree-sitter';
import { collectSites, compact, compileName, strip, type Site, type SiteHooks } from './sites.js';
import type { SymbolInfo } from './symbols.js';

/** A place that sets a machine's state: a `set` matcher site or a table row. 0-based lines. */
export interface TransitionSite {
  machine: string;
  file: string;
  line: number;
  column: number;
  /** Enclosing function definition; absent at file scope. */
  symbol?: string;
  sig?: string;
  /** Target state. */
  to: string;
  /** State labels of the innermost enclosing `case` group that has any (fall-through included). */
  fromCases: string[];
  /** Innermost enclosing `case` matching `events`; for rows, the `event` column. */
  event?: string;
  /** Condition of the one `if` enclosing the site within its region. */
  guard?: string;
  /** Row comment, such as `T5`. */
  label?: string;
  kind: 'set' | 'row';
  /** Rows: the `action` column. */
  action?: string;
  /** Rows: the array name. */
  table?: string;
  /** The innermost enclosing `case` block, else the function body; for rows, the row. */
  region: { startLine: number; endLine: number };
}

/** A call made directly inside a state `case` block. */
export interface StateCall {
  machine: string;
  state: string;
  callee: string;
}

/** A `case` label matching a machine's `states`. */
export interface StateLabel {
  machine: string;
  state: string;
}

export interface MachineScan {
  transitions: TransitionSite[];
  stateCalls: StateCall[];
  stateLabels: StateLabel[];
}

interface Compiled {
  id: string;
  states: RegExp;
  events?: RegExp;
  tables: { spec: TableSpec; rows: RegExp }[];
}

const GUARD_MAX = 80;
const WORD = /\w/;

const named = (node: Node): Node[] =>
  node.namedChildren.filter((n): n is Node => n !== null && n.type !== 'comment');

/** The label of a `case`; undefined for `default` and non-name values. */
function caseValue(node: Node): string | undefined {
  const value = node.childForFieldName('value');
  if (!value || (value.type !== 'identifier' && value.type !== 'qualified_identifier')) return;
  return compact(value);
}

/** The statements of a `case`, without its label. */
function bodyOf(node: Node): Node[] {
  const value = node.childForFieldName('value');
  return named(node).filter((n) => n.id !== value?.id);
}

/** The `case` and the empty labels falling through into it, first label first. */
function groupOf(node: Node): Node[] {
  const group = [node];
  for (let prev = node.previousNamedSibling; prev; prev = prev.previousNamedSibling) {
    if (prev.type === 'comment') continue;
    if (prev.type !== 'case_statement' || bodyOf(prev).length > 0) break;
    group.unshift(prev);
  }
  return group;
}

/** Whitespace removed, except one space between two word characters. */
function compactText(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, (_, at: number, s: string) =>
      WORD.test(s[at - 1] ?? '') && WORD.test(s[at + _.length] ?? '') ? ' ' : '',
    );
}

function conditionText(node: Node): string {
  const text = compactText(node.text);
  // A parenthesized condition or condition clause: drop its own parentheses.
  return text.startsWith('(') && text.endsWith(')') ? text.slice(1, -1) : text;
}

const truncate = (s: string) => (s.length > GUARD_MAX ? s.slice(0, GUARD_MAX - 1) + '…' : s);

function commentText(node: Node): string {
  return node.text
    .replace(/^\/\*+|\*+\/$|^\/\/+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Callees of the calls that are statements of `stmts`, through blocks and `return`. */
function directCalls(stmts: Node[], out: string[]) {
  for (const s of stmts) {
    if (s.type === 'compound_statement') directCalls(named(s), out);
    else if (s.type === 'expression_statement' || s.type === 'return_statement') {
      const e = named(s)[0];
      const fn = e?.type === 'call_expression' ? e.childForFieldName('function') : null;
      if (fn && (fn.type === 'identifier' || fn.type === 'qualified_identifier'))
        out.push(compact(fn));
    }
  }
}

function compileMachines(machines: MachineRecord[], file: string): Compiled[] {
  const out: Compiled[] = [];
  for (const m of machines) {
    if (!matchesAny(file, m.files)) continue;
    const states = compileName(m.states);
    if (!states) continue;
    const c: Compiled = { id: m.id, states, tables: [] };
    if (m.events !== undefined) {
      const events = compileName(m.events);
      if (events) c.events = events;
    }
    for (const spec of m.tables ?? []) {
      const rows = compileName(spec.rows);
      if (rows) c.tables.push({ spec, rows });
    }
    out.push(c);
  }
  return out;
}

/**
 * Hooks for `collectSites` that find the transitions of `machines` in the same walk, and the
 * result they fill. Undefined when no machine applies to `file`.
 */
export function machineHooks(
  file: string,
  machines: MachineRecord[],
  symbols: SymbolInfo[],
): { hooks: SiteHooks; result: MachineScan } | undefined {
  const compiled = compileMachines(machines, file);
  if (compiled.length === 0) return undefined;
  const result: MachineScan = { transitions: [], stateCalls: [], stateLabels: [] };
  const functions = symbols.filter((s) => s.kind === 'function');
  const byId = new Map(compiled.map((c) => [c.id, c]));

  const onSet = (m: Compiled) => (site: Site, at: Node) => {
    const to = site.key;
    if (to === undefined || !m.states.test(to)) return;
    let region: Node | undefined;
    let regionStart = 0;
    let fromCases: string[] | undefined;
    let event: string | undefined;
    const guards: string[] = [];
    let fn: Node | undefined;
    let child = at;
    for (let p = at.parent; p; child = p, p = p.parent) {
      if (p.type === 'function_definition') {
        fn = p;
        break;
      }
      if (p.type === 'case_statement') {
        const group = groupOf(p);
        const labels = group.map(caseValue).filter((l): l is string => l !== undefined);
        if (!region) {
          region = p;
          regionStart = group[0]!.startPosition.row;
        }
        if (!fromCases) {
          const states = labels.filter((l) => m.states.test(l));
          if (states.length) fromCases = states;
        }
        if (event === undefined && m.events) event = labels.find((l) => m.events!.test(l));
      } else if (p.type === 'if_statement' && !region) {
        const consequence = p.childForFieldName('consequence');
        const alternative = p.childForFieldName('alternative');
        const cond = p.childForFieldName('condition');
        if (cond && child.id === consequence?.id) guards.push(conditionText(cond));
        else if (cond && child.id === alternative?.id) {
          // `else if`: the inner `if` already gave the guard.
          const inner = named(child);
          if (!(inner.length === 1 && inner[0]!.type === 'if_statement'))
            guards.push(`!(${conditionText(cond)})`);
        }
      }
    }
    const t: TransitionSite = {
      machine: m.id,
      file,
      line: site.line,
      column: site.column,
      to,
      fromCases: fromCases ?? [],
      kind: 'set',
      region: { startLine: site.line, endLine: site.line },
    };
    if (site.symbol !== undefined) {
      t.symbol = site.symbol;
      t.sig = site.sig;
    }
    if (event !== undefined) t.event = event;
    if (guards.length === 1) t.guard = truncate(guards[0]!);
    if (region) t.region = { startLine: regionStart, endLine: region.endPosition.row };
    else {
      const body = fn?.childForFieldName('body');
      if (body) t.region = { startLine: body.startPosition.row, endLine: body.endPosition.row };
    }
    result.transitions.push(t);
  };

  const onCase = (node: Node) => {
    const label = caseValue(node);
    if (label !== undefined) {
      for (const m of compiled)
        if (m.states.test(label)) result.stateLabels.push({ machine: m.id, state: label });
    }
    const body = bodyOf(node);
    if (body.length === 0) return;
    const callees: string[] = [];
    directCalls(body, callees);
    if (callees.length === 0) return;
    const labels = groupOf(node)
      .map(caseValue)
      .filter((l): l is string => l !== undefined);
    for (const m of compiled) {
      for (const state of labels.filter((l) => m.states.test(l)))
        for (const callee of callees) result.stateCalls.push({ machine: m.id, state, callee });
    }
  };

  const slot = (cols: Node[], at: number | string): Node | undefined => {
    if (typeof at === 'number') {
      const col = cols[at - 1];
      return col?.type === 'initializer_pair' ? (col.childForFieldName('value') ?? undefined) : col;
    }
    for (const col of cols) {
      if (col.type !== 'initializer_pair') continue;
      const d = col.childForFieldName('designator');
      if (d?.type === 'field_designator' && d.namedChildren[0]?.text === at)
        return col.childForFieldName('value') ?? undefined;
    }
    return undefined;
  };

  const enclosing = (line: number) => {
    let found: SymbolInfo | undefined;
    for (const f of functions)
      if (f.startLine <= line && line <= f.endLine && (!found || f.startLine >= found.startLine))
        found = f;
    return found;
  };

  const onDeclarator = (node: Node) => {
    const value = node.childForFieldName('value');
    if (value?.type !== 'initializer_list') return;
    let decl = node.childForFieldName('declarator');
    if (decl?.type !== 'array_declarator') return;
    while (decl && decl.type !== 'identifier') decl = decl.childForFieldName('declarator');
    if (!decl) return;
    const table = decl.text;
    const specs = compiled.flatMap((m) =>
      m.tables.filter((t) => t.rows.test(table)).map((t) => ({ m, spec: t.spec })),
    );
    if (specs.length === 0) return;
    const elements = value.namedChildren.filter((n): n is Node => n !== null);
    elements.forEach((row, i) => {
      if (row.type !== 'initializer_list') return;
      const cols = named(row);
      // A comment on the row's line: after it first, then before it.
      const near = [...elements.slice(i + 1), ...row.namedChildren.filter((n) => n !== null)]
        .filter((n) => n.type === 'comment' && n.startPosition.row === row.endPosition.row)
        .concat(
          elements
            .slice(0, i)
            .filter((n) => n.type === 'comment' && n.endPosition.row === row.startPosition.row),
        );
      const label = near.map(commentText).find((t) => t.length > 0);
      const fn = enclosing(row.startPosition.row);
      for (const { m, spec } of specs) {
        const toNode = slot(cols, spec.to);
        if (!toNode) continue;
        const to = compact(strip(toNode));
        if (!m.states.test(to)) continue;
        const t: TransitionSite = {
          machine: m.id,
          file,
          line: row.startPosition.row,
          column: row.startPosition.column,
          to,
          fromCases: [],
          kind: 'row',
          table,
          region: { startLine: row.startPosition.row, endLine: row.endPosition.row },
        };
        if (fn) {
          t.symbol = fn.symbol;
          t.sig = fn.sig;
        }
        const ev = slot(cols, spec.event);
        if (ev) t.event = compact(ev);
        if (label) t.label = label;
        const action = spec.action !== undefined ? slot(cols, spec.action) : undefined;
        if (action) {
          const name = compact(strip(action));
          if (name !== 'NULL' && name !== 'nullptr' && name !== '0') t.action = name;
        }
        result.transitions.push(t);
      }
    });
  };

  const hooks: SiteHooks = {
    matchers: machines.flatMap((m) => {
      const c = byId.get(m.id);
      return c ? (m.set ?? []).map((matcher) => ({ id: m.id, matcher, onSite: onSet(c) })) : [];
    }),
    onNode(node) {
      if (node.type === 'case_statement') onCase(node);
      else onDeclarator(node);
    },
  };
  return { hooks, result };
}

/** Transition sites, state calls and state labels of `machines` in a parsed file. */
export function collectTransitions(
  tree: Tree,
  file: string,
  machines: MachineRecord[],
  symbols: SymbolInfo[],
): MachineScan {
  const m = machineHooks(file, machines, symbols);
  if (!m) return { transitions: [], stateCalls: [], stateLabels: [] };
  collectSites(tree, file, [], symbols, m.hooks);
  return m.result;
}
