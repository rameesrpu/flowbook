import { createHash } from 'node:crypto';
import { normalizeSig } from '@flowbook/core';
import type { Node, Tree } from 'web-tree-sitter';

export type SymbolKind = 'function' | 'macro' | 'type';

/** A definition found in a source file. Lines and columns are 0-based. */
export interface SymbolInfo {
  /** Qualified name without template arguments, e.g. "net::EventLoop::add". */
  symbol: string;
  /** Normalized parameter types, e.g. "(int,Callback)"; empty for types. */
  sig: string;
  kind: SymbolKind;
  /** `static` (file-local) function. */
  isStatic: boolean;
  startLine: number;
  endLine: number;
  nameLine: number;
  nameColumn: number;
  /** Short hash of the definition with comments and whitespace removed. */
  fp: string;
  /** Number of preprocessor alternatives merged into this entry, when more than one. */
  variants?: number;
}

const SCOPES = new Set(['class_specifier', 'struct_specifier', 'union_specifier']);
const WRAPPED = new Set([
  'pointer_declarator',
  'reference_declarator',
  'parenthesized_declarator',
  'attributed_declarator',
]);

/** Removes template argument lists (`S<T>::f` → `S::f`) but keeps `operator<` and friends. */
export function stripTemplateArgs(name: string): string {
  let out = '';
  let depth = 0;
  for (let i = 0; i < name.length; i++) {
    const c = name[i]!;
    if (depth === 0 && /operator\s*$/.test(out) && /[<>=!]/.test(c)) {
      out += c;
      continue;
    }
    if (c === '<') depth++;
    else if (c === '>' && depth > 0) depth--;
    else if (depth === 0) out += c;
  }
  return out;
}

/** Drops whitespace except between two word characters (`operator new`, `unsigned int`). */
const compact = (s: string) =>
  s
    .replace(/\s+/g, ' ')
    .replace(/ (?=\W)|(?<=\W) /g, '')
    .trim();

/** Names of enclosing namespaces and classes, outermost first. */
function scopeOf(node: Node): string[] {
  const scope: string[] = [];
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === 'namespace_definition') {
      const name = p.childForFieldName('name');
      if (name) scope.unshift(compact(name.text));
    } else if (SCOPES.has(p.type)) {
      const name = p.childForFieldName('name');
      if (name) scope.unshift(compact(name.text));
    }
  }
  return scope;
}

function functionDeclarator(def: Node): Node | undefined {
  let d = def.childForFieldName('declarator');
  while (d && d.type !== 'function_declarator') {
    d = WRAPPED.has(d.type) ? (d.childForFieldName('declarator') ?? d.namedChild(0)) : null;
  }
  return d ?? undefined;
}

/**
 * Conversion operators (`operator bool() const`, `P::operator int()`) have no
 * function_declarator; their parameters hang off an abstract_function_declarator.
 */
function conversionOperator(def: Node): { name: string; nameNode: Node; fd: Node } | undefined {
  const decl = def.childForFieldName('declarator');
  let cast = decl;
  let prefix = '';
  while (cast && cast.type === 'qualified_identifier') {
    prefix += compact(cast.childForFieldName('scope')?.text ?? '') + '::';
    cast = cast.childForFieldName('name');
  }
  if (!cast || cast.type !== 'operator_cast') return undefined;
  const fd = cast.childForFieldName('declarator');
  const type = cast.childForFieldName('type');
  if (!fd || !type) return undefined;
  return { name: `${prefix}operator ${compact(type.text)}`, nameNode: decl!, fd };
}

/** The identifier a parameter declarator introduces, if any. */
function declaredName(param: Node): Node | undefined {
  let d = param.childForFieldName('declarator');
  while (d) {
    if (d.type === 'identifier') return d;
    if (d.type === 'function_declarator' || d.type === 'array_declarator' || WRAPPED.has(d.type)) {
      d =
        d.childForFieldName('declarator') ??
        d.namedChildren.find((c) => c?.type !== 'type_qualifier') ??
        null;
    } else return undefined;
  }
  return undefined;
}

function paramType(param: Node): string {
  if (param.type === 'variadic_parameter') return '...';
  let text = param.text;
  const base = param.startIndex;
  const def = param.childForFieldName('default_value');
  if (def) {
    // Cut "= value" from the end.
    const eq = text.lastIndexOf('=', def.startIndex - base);
    text = text.slice(0, eq >= 0 ? eq : def.startIndex - base);
  }
  const name = declaredName(param);
  if (name) {
    const s = name.startIndex - base;
    text = text.slice(0, s) + text.slice(name.endIndex - base);
  }
  return text;
}

function signature(fd: Node): string {
  const params = fd.childForFieldName('parameters');
  const types = (params?.namedChildren ?? [])
    .filter((p): p is Node => !!p && p.type !== 'comment')
    .map(paramType);
  if (types.length === 1 && types[0]!.trim() === 'void') types.length = 0;
  const quals = fd.children
    .filter((c): c is Node => !!c && (c.type === 'type_qualifier' || c.type === 'ref_qualifier'))
    .map((c) => c.text);
  return normalizeSig(`(${types.join(',')})${quals.join('')}`);
}

/** Hash of the node's text with comments removed and whitespace collapsed. */
export function fingerprint(node: Node): string {
  const cuts: [number, number][] = [];
  const walk = (n: Node) => {
    if (n.type === 'comment') cuts.push([n.startIndex, n.endIndex]);
    else for (const c of n.children) if (c) walk(c);
  };
  walk(node);
  let text = '';
  let pos = node.startIndex;
  const src = node.text;
  for (const [s, e] of cuts) {
    text += src.slice(pos - node.startIndex, s - node.startIndex) + ' ';
    pos = e;
  }
  text += src.slice(pos - node.startIndex);
  const normalized = text.replace(/\s+/g, ' ').trim();
  return createHash('sha1').update(normalized).digest('hex').slice(0, 12);
}

function info(
  outer: Node,
  nameNode: Node,
  symbol: string,
  sig: string,
  kind: SymbolKind,
  isStatic: boolean,
): SymbolInfo {
  return {
    symbol,
    sig,
    kind,
    isStatic,
    startLine: outer.startPosition.row,
    endLine: outer.endPosition.row,
    nameLine: nameNode.startPosition.row,
    nameColumn: nameNode.startPosition.column,
    fp: fingerprint(outer),
  };
}

/** Every function, function-like macro and class/struct definition in the tree. */
export function collectSymbols(tree: Tree): SymbolInfo[] {
  const out: SymbolInfo[] = [];
  const visit = (node: Node) => {
    // Templates are reported at the outer template_declaration so the fingerprint covers them.
    const outer = node.parent?.type === 'template_declaration' ? node.parent : node;
    if (node.type === 'function_definition') {
      const fd = functionDeclarator(node);
      const nameNode = fd?.childForFieldName('declarator');
      const conv = fd ? undefined : conversionOperator(node);
      const isStatic = node.children.some(
        (c) => c?.type === 'storage_class_specifier' && c.text === 'static',
      );
      if (fd && nameNode) {
        const local = stripTemplateArgs(compact(nameNode.text));
        const symbol = [...scopeOf(node), local].join('::');
        out.push(info(outer, nameNode, symbol, signature(fd), 'function', isStatic));
      } else if (conv) {
        const symbol = [...scopeOf(node), stripTemplateArgs(conv.name)].join('::');
        out.push(info(outer, conv.nameNode, symbol, signature(conv.fd), 'function', isStatic));
      }
    } else if (node.type === 'preproc_function_def') {
      const nameNode = node.childForFieldName('name')!;
      const params = node.childForFieldName('parameters')?.text ?? '()';
      out.push(info(node, nameNode, nameNode.text, normalizeSig(params), 'macro', false));
    } else if (SCOPES.has(node.type) && node.childForFieldName('body')) {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const symbol = [...scopeOf(node), stripTemplateArgs(compact(nameNode.text))].join('::');
        out.push(info(outer, nameNode, symbol, '', 'type', false));
      }
    }
    for (const c of node.namedChildren) if (c) visit(c);
  };
  visit(tree.rootNode);
  return mergeVariants(out);
}

/**
 * Definitions with the same name and signature in one file are alternatives selected by the
 * preprocessor (`#if _WIN32 … #else …`). They are reported once, at the first definition, with a
 * fingerprint covering every variant so a change in any branch makes the anchor stale.
 */
function mergeVariants(symbols: SymbolInfo[]): SymbolInfo[] {
  const byKey = new Map<string, SymbolInfo[]>();
  for (const s of symbols) {
    const key = `${s.kind}\u0000${s.symbol}\u0000${s.sig}`;
    byKey.set(key, [...(byKey.get(key) ?? []), s]);
  }
  return [...byKey.values()].map((variants) => {
    const first = variants[0]!;
    if (variants.length === 1) return first;
    const fp = createHash('sha1')
      .update(variants.map((v) => v.fp).join(','))
      .digest('hex')
      .slice(0, 12);
    return {
      ...first,
      fp,
      endLine: Math.max(...variants.map((v) => v.endLine)),
      variants: variants.length,
    };
  });
}
