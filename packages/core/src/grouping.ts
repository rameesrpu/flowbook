import picomatch from 'picomatch';
import type { GroupRecord, NodeRecord } from './schema.js';

export type GroupKind = 'module' | 'folder' | 'file';

export interface Group {
  id: string;
  kind: GroupKind;
  label: string;
  /** Repo-relative directory or file path for folder and file groups. */
  path?: string;
  parent?: string;
  depth: number;
  children: string[];
  /** Ids of flow nodes placed directly in this group. */
  nodes: string[];
}

export interface GroupTree {
  groups: Map<string, Group>;
  /** Top-level group ids, in first-seen order. */
  roots: string[];
  /** Innermost group of each node; external (unanchored) nodes are absent. */
  groupOf: Map<string, string>;
}

const dirname = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf('/')));

function commonDir(files: string[]): string {
  if (files.length === 0) return '';
  let parts = dirname(files[0]!).split('/').filter(Boolean);
  for (const f of files.slice(1)) {
    const other = dirname(f).split('/');
    let i = 0;
    while (i < parts.length && parts[i] === other[i]) i++;
    parts = parts.slice(0, i);
  }
  return parts.join('/');
}

const strip = (path: string, base: string) =>
  base === '' ? path : path.startsWith(base + '/') ? path.slice(base.length + 1) : path;

/**
 * Places nodes into nested groups. Files matched by a configured group land under a module
 * with that group's name; other files are grouped by their first directory below the common
 * root of all anchored files. Folder chains with a single child are merged ("net/tls").
 */
export function buildGroups(nodes: NodeRecord[], configGroups: GroupRecord[] = []): GroupTree {
  const matchers = configGroups.map((g) => ({
    name: g.name,
    globs: g.paths.map((p) => ({ test: picomatch(p), base: picomatch.scan(p).base })),
  }));

  const placement = new Map<string, { module?: string; rel: string; base: string }>();
  const unmatched: string[] = [];
  for (const n of nodes) {
    if (!n.anchor) continue;
    const file = n.anchor.file;
    let placed = false;
    for (const m of matchers) {
      const glob = m.globs.find((g) => g.test(file));
      if (glob) {
        placement.set(n.id, { module: m.name, rel: strip(file, glob.base), base: glob.base });
        placed = true;
        break;
      }
    }
    if (!placed) unmatched.push(n.id);
  }
  const unmatchedFiles = unmatched.map((id) => nodes.find((n) => n.id === id)!.anchor!.file);
  const allFiles = nodes.flatMap((n) => (n.anchor ? [n.anchor.file] : []));
  const root = commonDir([...new Set(allFiles)]);
  unmatched.forEach((id, i) => {
    const rel = strip(unmatchedFiles[i]!, root);
    const slash = rel.indexOf('/');
    if (slash < 0) placement.set(id, { rel, base: root });
    else {
      const module = rel.slice(0, slash);
      placement.set(id, {
        module,
        rel: rel.slice(slash + 1),
        base: root ? `${root}/${module}` : module,
      });
    }
  });

  const tree: GroupTree = { groups: new Map(), roots: [], groupOf: new Map() };
  const ensure = (id: string, make: () => Omit<Group, 'id' | 'children' | 'nodes' | 'depth'>) => {
    let g = tree.groups.get(id);
    if (!g) {
      const init = make();
      const parent = init.parent ? tree.groups.get(init.parent) : undefined;
      g = { id, ...init, depth: parent ? parent.depth + 1 : 0, children: [], nodes: [] };
      tree.groups.set(id, g);
      if (parent) parent.children.push(id);
      else tree.roots.push(id);
    }
    return g;
  };

  for (const n of nodes) {
    const p = placement.get(n.id);
    if (!p) continue;
    let parent: string | undefined;
    if (p.module !== undefined) {
      const name = p.module;
      parent = ensure(`m:${name}`, () => ({ kind: 'module', label: name })).id;
    }
    const segments = p.rel.split('/');
    const fileName = segments.pop()!;
    let dir = p.base;
    for (const seg of segments) {
      dir = dir ? `${dir}/${seg}` : seg;
      const path = dir;
      const up = parent;
      parent = ensure(`d:${p.module ?? ''}:${path}`, () => ({
        kind: 'folder',
        label: seg,
        path,
        parent: up,
      })).id;
    }
    const file = n.anchor!.file;
    const up = parent;
    const fileGroup = ensure(`f:${file}`, () => ({
      kind: 'file',
      label: fileName,
      path: file,
      parent: up,
    }));
    fileGroup.nodes.push(n.id);
    tree.groupOf.set(n.id, fileGroup.id);
  }

  mergeFolderChains(tree);
  return tree;
}

function mergeFolderChains(tree: GroupTree) {
  for (const g of [...tree.groups.values()]) {
    if (!tree.groups.has(g.id) || g.kind !== 'folder') continue;
    while (g.nodes.length === 0 && g.children.length === 1) {
      const child = tree.groups.get(g.children[0]!)!;
      if (child.kind !== 'folder') break;
      g.label = `${g.label}/${child.label}`;
      g.path = child.path;
      g.children = child.children;
      g.nodes = child.nodes;
      for (const c of g.children) tree.groups.get(c)!.parent = g.id;
      for (const n of g.nodes) tree.groupOf.set(n, g.id);
      tree.groups.delete(child.id);
    }
  }
  const fixDepth = (id: string, depth: number) => {
    const g = tree.groups.get(id)!;
    g.depth = depth;
    for (const c of g.children) fixDepth(c, depth + 1);
  };
  for (const r of tree.roots) fixDepth(r, 0);
}

/** Group ids from outermost to innermost containing `nodeId`. */
export function ancestorsOf(tree: GroupTree, nodeId: string): string[] {
  const chain: string[] = [];
  let id = tree.groupOf.get(nodeId);
  while (id !== undefined) {
    chain.unshift(id);
    id = tree.groups.get(id)!.parent;
  }
  return chain;
}

/** Groups to collapse so that only `depth` levels of nesting stay open (0 = modules only). */
export function collapseBelow(tree: GroupTree, depth: number): Set<string> {
  const out = new Set<string>();
  for (const g of tree.groups.values()) if (g.depth === depth) out.add(g.id);
  return out;
}
