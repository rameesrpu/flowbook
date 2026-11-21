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
  /**
   * States the innermost enclosing `if` holding state names compares with `==` (the site in its
   * then branch); empty when that condition also uses one otherwise (`!=`, a call argument).
   */
  fromTests: string[];
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
  let raw = node.text;
  for (const c of node.descendantsOfType('comment')) if (c) raw = raw.replace(c.text, ' ');
  const text = compactText(raw);
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

const NAMES = new Set(['identifier', 'qualified_identifier']);

const unwrapped = (n: Node): Node => {
  let x = n;
  while (x.type === 'parenthesized_expression' || x.type === 'cast_expression') {
    const inner =
      x.type === 'cast_expression'
        ? x.childForFieldName('value')
        : x.namedChildren.find((c) => c !== null && c.type !== 'comment');
    if (!inner) break;
    x = inner;
  }
  return x;
};

const operator = (n: Node) =>
  n.type === 'binary_expression' ? n.childForFieldName('operator')?.text : undefined;

/** `x == STATE` (either side), or a `||` of such tests. */
function isStateTest(n: Node, states: RegExp): boolean {
  const e = unwrapped(n);
  const op = operator(e);
  const left = e.childForFieldName('left');
  const right = e.childForFieldName('right');
  if (!left || !right) return false;
  if (op === '||') return isStateTest(left, states) && isStateTest(right, states);
  if (op !== '==') return false;
  return [left, right].some((side) => {
    const u = unwrapped(side);
    return NAMES.has(u.type) && states.test(compact(u));
  });
}

/**
 * The state names a condition compares with `==`; undefined when it holds none, [] when one of
 * them is used any other way, or sits under a `||` whose other side is not a state test.
 */
function testedStates(cond: Node, states: RegExp): string[] | undefined {
  const found: string[] = [];
  let other = false;
  const visit = (n: Node, underOr: boolean) => {
    if (NAMES.has(n.type)) {
      const name = compact(n);
      if (!states.test(name)) return;
      let p = n.parent;
      while (p && (p.type === 'parenthesized_expression' || p.type === 'cast_expression'))
        p = p.parent;
      if (p && operator(p) === '==' && !underOr) {
        if (!found.includes(name)) found.push(name);
      } else other = true;
      return;
    }
    // A `||` with a side that is not a state test: the state may not hold.
    const or = operator(n) === '||' && !isStateTest(n, states);
    for (const c of n.namedChildren) if (c) visit(c, underOr || or);
  };
  visit(cond, false);
  if (other) return [];
  return found.length ? found : undefined;
}

/**
 * Callees of every call in `stmts`, at any depth (inside `if`s, loops and nested `switch`es:
 * calls under a nested event `case` belong to the enclosing state `case`).
 */
function directCalls(stmts: Node[], out: string[]) {
  for (const s of stmts)
    for (const call of [s, ...s.descendantsOfType('call_expression')]) {
      if (call?.type !== 'call_expression') continue;
      const fn = call.childForFieldName('function');
      if (fn && (fn.type === 'identifier' || fn.type === 'qualified_identifier'))
        out.push(compact(fn));
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

  /** Target names of a key: the key, else both branches of a `?:` when each names a state. */
  const targetsOf = (m: Compiled, site: Site, keyNode: Node | undefined, member: boolean) => {
    if (site.key !== undefined && m.states.test(site.key)) return [site.key];
    const e = keyNode ? strip(keyNode) : undefined;
    if (e?.type !== 'conditional_expression') return [];
    const names: string[] = [];
    for (const field of ['consequence', 'alternative']) {
      const branch = e.childForFieldName(field);
      let b = branch ? strip(branch) : undefined;
      if (member && b?.type === 'field_expression') b = b.childForFieldName('field') ?? undefined;
      const name = b && (NAMES.has(b.type) || b.type === 'field_identifier') ? compact(b) : '';
      if (!m.states.test(name)) return [];
      if (!names.includes(name)) names.push(name);
    }
    return names;
  };

  const onSet = (m: Compiled, member: boolean) => (site: Site, at: Node, keyNode?: Node) => {
    const targets = targetsOf(m, site, keyNode, member);
    if (targets.length === 0) return;
    let region: Node | undefined;
    let regionStart = 0;
    let fromCases: string[] | undefined;
    let fromTests: string[] | undefined;
    /** For a source from a test: the guards and region inside the test's consequence. */
    let test: { guards: string[]; region: Node; start: number } | undefined;
    let events: string[] | undefined;
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
        if (!events && m.events) {
          const found = labels.filter((l) => m.events!.test(l));
          if (found.length) events = found;
        }
      } else if (p.type === 'if_statement') {
        const consequence = p.childForFieldName('consequence');
        const cond = p.childForFieldName('condition');
        if (cond && !fromTests && child.id === consequence?.id)
          if ((fromTests = testedStates(cond, m.states))?.length)
            test = region
              ? { guards: [...guards], region, start: regionStart }
              : { guards: [...guards], region: child, start: child.startPosition.row };
        if (region) continue;
        const alternative = p.childForFieldName('alternative');
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
      to: targets[0]!,
      fromCases: fromCases ?? [],
      fromTests: fromTests ?? [],
      kind: 'set',
      region: { startLine: site.line, endLine: site.line },
    };
    if (site.symbol !== undefined) t.symbol = site.symbol;
    if (site.sig !== undefined) t.sig = site.sig;
    // A source from a test: guard and region come from inside the test's consequence.
    const fromTest = !fromCases && test !== undefined;
    const shown = fromTest ? test!.guards : guards;
    if (shown.length === 1) t.guard = truncate(shown[0]!);
    if (fromTest) t.region = { startLine: test!.start, endLine: test!.region.endPosition.row };
    else if (region) t.region = { startLine: regionStart, endLine: region.endPosition.row };
    else {
      const body = fn?.childForFieldName('body');
      if (body) t.region = { startLine: body.startPosition.row, endLine: body.endPosition.row };
    }
    for (const to of targets)
      // A fall-through group of event labels: one transition per event.
      if (events) for (const event of events) result.transitions.push({ ...t, to, event });
      else result.transitions.push({ ...t, to });
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
          fromTests: [],
          kind: 'row',
          table,
          region: { startLine: row.startPosition.row, endLine: row.endPosition.row },
        };
        if (fn) {
          t.symbol = fn.symbol;
          if (fn.sig !== undefined) t.sig = fn.sig;
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
      return c
        ? (m.set ?? []).map((matcher) => ({
            id: m.id,
            matcher,
            onSite: onSet(c, matcher.keyMember === true),
          }))
        : [];
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
