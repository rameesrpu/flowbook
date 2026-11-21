import {
  CONNECTIONS_FILE,
  isDispatcherForm,
  type Anchor,
  type ConnectionRecord,
  type Connections,
  type Diagnostic,
  type Located,
  type RuleRecord,
} from '@flowbook/core';
import { match } from './resolver.js';
import { compileName, type FileScan, type Site } from './sites.js';
import type { SymbolInfo } from './symbols.js';

/** A place in the code. Lines and columns are 0-based. */
export interface Target {
  file: string;
  line: number;
  column: number;
  symbol?: string;
}

export interface Reactor extends Target {
  /** key: a receive site with the same key. handler: named at the send site. registered: handler of a matching receive site. anchored: joined by an anchored connection. */
  via: 'key' | 'handler' | 'registered' | 'anchored';
  key?: string;
  confirmed: boolean;
}

export interface Pairing {
  send: Site;
  /** Order: key, registered, anchored, handler. */
  reactors: Reactor[];
  /** Id of the covering connection. */
  connection?: string;
  /** Its title. */
  title?: string;
  /** Connection context, else rule context. */
  context?: string;
  /** Set when the send site's handler has several candidate definitions and no connection picked one. */
  candidates?: number;
  /**
   * Set when the send site has a key, its rule has receive matchers, and no receive site of the
   * rule has that key or is joined by an anchored connection: whatever the handler is, the
   * dispatcher has nothing that runs it. Its handler reactors are then unconfirmed.
   */
  missingReceive?: true;
  /** Set when the send site forwards a parameter of its function (`send.forwards`). */
  forwarded?: true;
}

export interface ConnectionIndex {
  /** Every site, in file, line and column order. */
  sites: Site[];
  /** One per send site, in file then line order. */
  pairings: Pairing[];
  /** Receive sites no send site reaches by key or anchor, in rule order, then file and line. */
  unpairedReceives: Site[];
  /** File CONNECTIONS_FILE, 1-based line of the record. */
  diagnostics: Diagnostic[];
}

export interface RuleSummary {
  rule: string;
  send: number;
  receive: number;
  paired: number;
  confirmed: number;
  unpaired: number;
  /** Units (keys, or send sites when unkeyed) with reactors but no receive site; not `paired`. */
  missingReceive: number;
  /** Forwarding send sites, with or without reactors; not `unpaired`, not in any unit. */
  forwarding: number;
  keyed: boolean;
}

/** A function definition in a scanned file. */
interface Definition {
  file: string;
  info: SymbolInfo;
}

/** An anchored connection with its anchors resolved; unresolved anchors are dropped. */
interface Anchored {
  record: Located<ConnectionRecord>;
  send: Definition[];
  receive: Definition[];
}

/** Everything pairing a send site needs, computed once per index. */
interface Context {
  rules: Map<string, Located<RuleRecord>>;
  definitions: Map<string, Definition[]>;
  /** Receive sites by rule, then key. */
  receivesByKey: Map<string, Map<string, Site[]>>;
  receivesByRule: Map<string, Site[]>;
  /** Keyed connections by rule, then key. */
  keyed: Map<string, Map<string, Located<ConnectionRecord>>>;
  anchored: Anchored[];
  /** Dispatcher connections with their anchors resolved; unresolved anchors are dropped. */
  dispatchers: { record: Located<ConnectionRecord>; functions: Definition[] }[];
}

const leaf = (symbol: string) => symbol.slice(symbol.lastIndexOf(':') + 1);
const anchorText = (a: Anchor) => `${a.file}#${a.symbol}${a.sig ?? ''}`;

const definitionTarget = (d: Definition): Target => ({
  file: d.file,
  line: d.info.nameLine,
  column: d.info.nameColumn,
  symbol: d.info.symbol,
});

const siteTarget = (s: Site): Target => {
  const t: Target = { file: s.file, line: s.line, column: s.column };
  if (s.symbol !== undefined) t.symbol = s.symbol;
  return t;
};

const sameDefinition = (a: Definition, b: Definition) =>
  a.file === b.file && a.info.symbol === b.info.symbol && a.info.sig === b.info.sig;

/** True when the site's enclosing function is `d`. */
const inside = (s: Site, d: Definition) =>
  s.file === d.file && s.symbol === d.info.symbol && s.sig === d.info.sig;

const compareSites = (a: Site, b: Site) =>
  a.file !== b.file ? (a.file < b.file ? -1 : 1) : a.line - b.line || a.column - b.column;

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Function definitions of all scans, by the last `::` segment of their symbol. */
function collectDefinitions(scans: Map<string, FileScan>): Map<string, Definition[]> {
  const out = new Map<string, Definition[]>();
  for (const [file, scan] of scans)
    for (const info of scan.symbols)
      if (info.kind === 'function') push(out, leaf(info.symbol), { file, info });
  return out;
}

/**
 * Definitions a handler name named at a site in `file` refers to. One is a resolved handler;
 * among several, a single `static` one in the same file wins; otherwise all are candidates.
 */
function resolveHandler(ctx: Context, name: string, file: string): Definition[] {
  const all = ctx.definitions.get(leaf(name)) ?? [];
  if (all.length <= 1) return all;
  const local = all.filter((d) => d.file === file && d.info.isStatic);
  return local.length === 1 ? local : all;
}

const isKeyedForm = (c: ConnectionRecord) =>
  c.key !== undefined && c.send === undefined && c.receive === undefined;
const isAnchoredForm = (c: ConnectionRecord) =>
  c.key === undefined && !!c.send?.length && !!c.receive?.length;

/** Resolves one anchor to a definition, or reports why it does not resolve. */
function resolveAnchor(
  anchor: Anchor,
  scans: Map<string, FileScan>,
  report: (message: string) => void,
): Definition | undefined {
  const scan = scans.get(anchor.file);
  const r = scan ? match(anchor, scan.symbols) : undefined;
  if (r?.status === 'ok') return { file: anchor.file, info: r.symbol };
  if (r?.status === 'ambiguous') {
    report(
      `${anchorText(anchor)} is overloaded; add "sig" with one of: ${r.candidates.map((c) => c.sig).join(' | ')}`,
    );
  } else report(`no definition for ${anchorText(anchor)}`);
  return undefined;
}

function buildContext(
  connections: Connections,
  scans: Map<string, FileScan>,
  sites: Site[],
  report: Report,
): Context {
  const rules = new Map(connections.rules.map((r) => [r.id, r]));
  const receivesByKey = new Map<string, Map<string, Site[]>>();
  const receivesByRule = new Map<string, Site[]>();
  for (const s of sites) {
    if (s.role !== 'receive') continue;
    push(receivesByRule, s.rule, s);
    if (s.key === undefined) continue;
    if (!receivesByKey.has(s.rule)) receivesByKey.set(s.rule, new Map());
    push(receivesByKey.get(s.rule)!, s.key, s);
  }
  const keyed = new Map<string, Map<string, Located<ConnectionRecord>>>();
  const anchored: Anchored[] = [];
  const dispatchers: Context['dispatchers'] = [];
  // Records with an unknown rule or a malformed form are reported by validateConnections.
  // Record-line order: the first keyed connection per key and the first covering anchored one win.
  for (const c of [...connections.connections].sort((a, b) => a.line - b.line)) {
    const rule = rules.get(c.rule);
    if (!rule) continue;
    const resolve = (anchors: Anchor[]) =>
      anchors.flatMap((a) => resolveAnchor(a, scans, (m) => report(c, m)) ?? []);
    if (isKeyedForm(c)) {
      if (!keyed.has(c.rule)) keyed.set(c.rule, new Map());
      const byKey = keyed.get(c.rule)!;
      const first = byKey.get(c.key!);
      if (!first) byKey.set(c.key!, c);
      else
        report(
          c,
          `connection "${c.id}" repeats key "${c.key}" of rule "${c.rule}" (first on line ${first.line}) and is ignored`,
          'warning',
        );
    } else if (isAnchoredForm(c)) {
      anchored.push({ record: c, send: resolve(c.send!), receive: resolve(c.receive!) });
    } else if (isDispatcherForm(c) && rule.receive?.length) {
      dispatchers.push({ record: c, functions: resolve(c.receive!) });
    }
  }
  return {
    rules,
    definitions: collectDefinitions(scans),
    receivesByKey,
    receivesByRule,
    keyed,
    anchored,
    dispatchers,
  };
}

/** The keyed connection covering a site's rule and key, if any. */
const keyedConnection = (ctx: Context, s: Site) =>
  s.key === undefined ? undefined : ctx.keyed.get(s.rule)?.get(s.key);

/** True when the connection's rule has receive matchers but no receive site has the key. */
const lacksReceive = (ctx: Context, c: Located<ConnectionRecord>) =>
  !!ctx.rules.get(c.rule)?.receive?.length && !ctx.receivesByKey.get(c.rule)?.has(c.key!);

/** Pairing step 1: receive sites of the rule with the same key. */
function keyReceives(ctx: Context, send: Site): Site[] {
  if (send.key === undefined) return [];
  return ctx.receivesByKey.get(send.rule)?.get(send.key) ?? [];
}

/** The first dispatcher connection (by line) of the site's rule whose functions hold the site. */
const dispatcherHolding = (ctx: Context, r: Site | undefined) =>
  r &&
  ctx.dispatchers.find((d) => d.record.rule === r.rule && d.functions.some((f) => inside(r, f)));

/** A receive site is confirmed by a keyed connection that confirms, or by a dispatcher holding it. */
const confirmedReceive = (ctx: Context, r: Site, confirms: boolean) =>
  confirms || dispatcherHolding(ctx, r) !== undefined;

function keyReactors(ctx: Context, receives: Site[], confirms: boolean): Reactor[] {
  return receives.map((r) => ({
    ...siteTarget(r),
    via: 'key',
    key: r.key,
    confirmed: confirmedReceive(ctx, r, confirms),
  }));
}

/**
 * Pairing step 2: definitions of the handler named at the send site. Confirmed only when there is
 * exactly one and the send is not missing its receive site.
 */
function handlerReactors(candidates: Definition[], missingReceive: boolean): Reactor[] {
  const confirmed = candidates.length === 1 && !missingReceive;
  return candidates.map((d) => ({ ...definitionTarget(d), via: 'handler', confirmed }));
}

/** Pairing step 3: definitions of the handlers registered at the receive sites of step 1. */
function registeredReactors(ctx: Context, receives: Site[], confirms: boolean): Reactor[] {
  return receives.flatMap((r) => {
    if (r.handler === undefined) return [];
    const defs = resolveHandler(ctx, r.handler, r.file);
    const confirmed = confirmedReceive(ctx, r, confirms) && defs.length === 1;
    return defs.map((d): Reactor => ({ ...definitionTarget(d), via: 'registered', confirmed }));
  });
}

/** Anchored connections of the send site's rule whose `send` functions contain it. */
const anchoredCovering = (ctx: Context, send: Site) =>
  ctx.anchored.filter((a) => a.record.rule === send.rule && a.send.some((d) => inside(send, d)));

/**
 * Pairing step 4: receive sites inside the `receive` functions of covering anchored connections,
 * and handler candidates those functions pick (`picked`: the handler reactors are replaced).
 */
function anchoredReactors(
  ctx: Context,
  send: Site,
  covering: Anchored[],
  candidates: Definition[],
): { reactors: Reactor[]; receives: Site[]; picked: boolean } {
  const reactors: Reactor[] = [];
  const receives: Site[] = [];
  let picked = false;
  const rule = ctx.receivesByRule.get(send.rule) ?? [];
  for (const a of covering) {
    for (const d of a.receive) {
      for (const r of rule.filter((s) => inside(s, d))) {
        receives.push(r);
        const reactor: Reactor = { ...siteTarget(r), via: 'anchored', confirmed: true };
        if (r.key !== undefined) reactor.key = r.key;
        reactors.push(reactor);
      }
      if (candidates.length > 1 && candidates.some((c) => sameDefinition(c, d))) {
        picked = true;
        reactors.push({ ...definitionTarget(d), via: 'anchored', confirmed: true });
      }
    }
  }
  return { reactors, receives, picked };
}

/**
 * Keeps one reactor per target (file, line, column): the first confirmed one, else the first.
 * Survivors keep their position in the given order.
 */
function mergeReactors(reactors: Reactor[]): Reactor[] {
  const at = (r: Reactor) => `${r.file}:${r.line}:${r.column}`;
  const best = new Map<string, Reactor>();
  for (const r of reactors) {
    const kept = best.get(at(r));
    if (!kept || (r.confirmed && !kept.confirmed)) best.set(at(r), r);
  }
  return reactors.filter((r) => best.get(at(r)) === r);
}

/** Pairs one send site; also returns the receive sites it reaches by key or anchor. */
function pairSend(ctx: Context, send: Site): { pairing: Pairing; reached: Site[] } {
  const rule = ctx.rules.get(send.rule);
  const keyedBy = keyedConnection(ctx, send);
  // A keyed connection confirms only while its rule's receive sites include the key.
  const confirms = keyedBy !== undefined && !lacksReceive(ctx, keyedBy);
  const covering = anchoredCovering(ctx, send);
  const candidates = send.handler === undefined ? [] : resolveHandler(ctx, send.handler, send.file);

  const byKey = keyReceives(ctx, send);
  const anchored = anchoredReactors(ctx, send, covering, candidates);
  // A forwarding site's key comes from its callers, so there is no receive site to miss.
  const missingReceive =
    send.forwards === undefined &&
    send.key !== undefined &&
    !!rule?.receive?.length &&
    byKey.length === 0 &&
    anchored.receives.length === 0;
  const reactors = mergeReactors([
    ...keyReactors(ctx, byKey, confirms),
    ...registeredReactors(ctx, byKey, confirms),
    ...anchored.reactors,
    ...(anchored.picked ? [] : handlerReactors(candidates, missingReceive)),
  ]);

  const pairing: Pairing = { send, reactors };
  // A keyed connection for the send's key, else the covering anchored one with the lowest line,
  // else the dispatcher holding the first key receive site.
  const connection = keyedBy ?? covering[0]?.record ?? dispatcherHolding(ctx, byKey[0])?.record;
  if (connection) {
    pairing.connection = connection.id;
    pairing.title = connection.title;
  }
  const context = connection?.context ?? rule?.context;
  if (context !== undefined) pairing.context = context;
  if (candidates.length > 1 && !anchored.picked) pairing.candidates = candidates.length;
  if (missingReceive) pairing.missingReceive = true;
  if (send.forwards) pairing.forwarded = true;
  return { pairing, reached: [...byKey, ...anchored.receives] };
}

/** Warning: a rule with no site at all. */
function checkRules(ctx: Context, sites: Site[], report: Report) {
  const used = new Set(sites.map((s) => s.rule));
  for (const r of ctx.rules.values())
    if (!used.has(r.id)) report(r, `rule "${r.id}" matches no site`, 'warning');
}

/** Errors: a keyed connection whose key has no send site, or whose send sites have no reactor. */
function checkKeyed(ctx: Context, pairings: Pairing[], report: Report) {
  for (const [rule, byKey] of ctx.keyed) {
    for (const [key, record] of byKey) {
      const sends = pairings.filter((p) => p.send.rule === rule && p.send.key === key);
      if (sends.length === 0) report(record, `no send site of rule "${rule}" has key "${key}"`);
      else if (lacksReceive(ctx, record))
        report(
          record,
          `connection "${record.id}": key "${key}" has no receive site for rule "${rule}"`,
        );
      else if (sends.every((p) => p.reactors.length === 0))
        report(record, `key "${key}" of rule "${rule}" has no reactor`);
    }
  }
}

/**
 * Errors: an anchored `send` function with no send site of the rule, and a `receive` function that
 * holds no receive site of the rule and is no handler candidate of those send sites.
 */
function checkAnchored(ctx: Context, sites: Site[], report: Report) {
  for (const a of ctx.anchored) {
    const { rule } = a.record;
    const sends = sites.filter((s) => s.rule === rule && s.role === 'send');
    const covered = sends.filter((s) => a.send.some((d) => inside(s, d)));
    for (const d of a.send) {
      if (!sends.some((s) => inside(s, d)))
        report(a.record, `${d.file}#${d.info.symbol} has no send site of rule "${rule}"`);
    }
    const receives = ctx.receivesByRule.get(rule) ?? [];
    const candidates = covered.flatMap((s) =>
      s.handler === undefined ? [] : resolveHandler(ctx, s.handler, s.file),
    );
    for (const d of a.receive) {
      if (receives.some((s) => inside(s, d))) continue;
      if (candidates.some((c) => sameDefinition(c, d))) continue;
      report(
        a.record,
        `${d.file}#${d.info.symbol} has no receive site of rule "${rule}" and is not a handler candidate of its send sites`,
      );
    }
  }
}

/** Errors: a dispatcher function that holds no receive site of the rule. */
function checkDispatchers(ctx: Context, report: Report) {
  for (const { record, functions } of ctx.dispatchers) {
    const receives = ctx.receivesByRule.get(record.rule) ?? [];
    for (const d of functions) {
      if (!receives.some((s) => inside(s, d)))
        report(record, `${d.file}#${d.info.symbol} has no receive site of rule "${record.rule}"`);
    }
  }
}

/**
 * Warnings, on the rule record: a function holding a forwarding send site whose callers no `call`
 * send matcher of the rule matches (by leaf symbol; `files` is ignored). One per function.
 */
function checkForwarding(ctx: Context, sites: Site[], report: Report) {
  const seen = new Set<string>();
  for (const s of sites) {
    if (s.role !== 'send' || !s.forwards || s.symbol === undefined) continue;
    const at = `${s.rule}\0${s.file}\0${s.symbol}\0${s.sig ?? ''}`;
    if (seen.has(at)) continue;
    seen.add(at);
    const rule = ctx.rules.get(s.rule)!;
    const name = leaf(s.symbol);
    const covered = (rule.send ?? []).some((m) => 'call' in m && compileName(m.call)?.test(name));
    if (covered) continue;
    const arg = s.key !== undefined ? 'key' : 'handler';
    report(
      rule,
      `send site in ${s.symbol} (${s.file}) forwards parameter "${s.forwards.param}"; no send matcher of rule "${rule.id}" matches calls to ${s.symbol}; add {"call":"${s.symbol}","${arg}":${s.forwards.position}}`,
      'warning',
    );
  }
}

type Report = (
  record: Located<{ id: string }>,
  message: string,
  severity?: Diagnostic['severity'],
) => void;

/** Joins send sites to their reactors (spec: Pairing) and checks the connection records. */
export function buildConnectionIndex(
  connections: Connections,
  scans: Map<string, FileScan>,
): ConnectionIndex {
  const diagnostics: Diagnostic[] = [];
  const report: Report = (record, message, severity = 'error') =>
    diagnostics.push({
      severity,
      file: CONNECTIONS_FILE,
      line: record.line,
      id: record.id,
      message,
    });

  const sites = [...scans.values()].flatMap((s) => s.sites).sort(compareSites);
  const ctx = buildContext(connections, scans, sites, report);

  const pairings: Pairing[] = [];
  const reached = new Set<Site>();
  for (const send of sites) {
    if (send.role !== 'send') continue;
    const r = pairSend(ctx, send);
    pairings.push(r.pairing);
    for (const s of r.reached) reached.add(s);
  }
  const ruleOrder = new Map(connections.rules.map((r, i) => [r.id, i]));
  const unpairedReceives = sites
    .filter((s) => s.role === 'receive' && !reached.has(s))
    .sort((a, b) => ruleOrder.get(a.rule)! - ruleOrder.get(b.rule)! || compareSites(a, b));

  checkRules(ctx, sites, report);
  checkKeyed(ctx, pairings, report);
  checkAnchored(ctx, sites, report);
  checkDispatchers(ctx, report);
  checkForwarding(ctx, sites, report);
  // Stable: diagnostics of one record keep the order they were found in.
  diagnostics.sort((a, b) => a.line! - b.line!);
  return { sites, pairings, unpairedReceives, diagnostics };
}

/** Send sites whose reactors include this file and line. */
export function sendersOf(index: ConnectionIndex, target: { file: string; line: number }): Site[] {
  return index.pairings
    .filter((p) => p.reactors.some((r) => r.file === target.file && r.line === target.line))
    .map((p) => p.send);
}

/**
 * Counts per rule. A pairing unit is a key when the send site has one, otherwise the send site
 * itself. A unit with reactors counts as `missingReceive` when every send of it is missing its
 * receive site, otherwise as `paired`; `confirmed` counts paired units whose reactors are all
 * confirmed. Send sites that forward a parameter of their function count as `forwarding` and form
 * no unit; other send sites without reactors count as `unpaired`.
 */
export function ruleSummaries(index: ConnectionIndex, connections: Connections): RuleSummary[] {
  return connections.rules.map((rule) => {
    const pairings = index.pairings.filter((p) => p.send.rule === rule.id);
    const units = new Map<string | Site, Pairing[]>();
    for (const p of pairings) if (!p.forwarded) push(units, p.send.key ?? p.send, p);
    let paired = 0;
    let confirmed = 0;
    let missingReceive = 0;
    for (const unit of units.values()) {
      const reactors = unit.flatMap((p) => p.reactors);
      if (reactors.length === 0) continue;
      if (unit.every((p) => p.missingReceive)) {
        missingReceive++;
        continue;
      }
      paired++;
      if (reactors.every((r) => r.confirmed)) confirmed++;
    }
    const forwarding = pairings.filter((p) => p.forwarded).length;
    const silentSends = pairings.filter((p) => !p.forwarded && p.reactors.length === 0).length;
    const silentReceives = index.unpairedReceives.filter((s) => s.rule === rule.id).length;
    return {
      rule: rule.id,
      send: pairings.length,
      receive: index.sites.filter((s) => s.rule === rule.id && s.role === 'receive').length,
      paired,
      confirmed,
      unpaired: silentSends + silentReceives,
      missingReceive,
      forwarding,
      keyed: pairings.some((p) => p.send.key !== undefined),
    };
  });
}
