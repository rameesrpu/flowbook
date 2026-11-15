/**
 * Lens text and jump targets for connection sites (spec: Editor). Pure with respect to `vscode`
 * so it can be unit-tested against the fixture.
 */
import { CONNECTIONS_FILE, type Connections } from '@flowbook/core';
import {
  buildConnectionIndex,
  sendersOf,
  type ConnectionIndex,
  type FileScan,
  type Pairing,
  type Reactor,
  type Site,
  type Target,
} from '@flowbook/resolver';

export interface ConnLens {
  line: number; // 0-based
  title: string;
  command: 'flowbook.goToReactor' | 'flowbook.goToSender';
  targets: Target[];
  /** Present on an unpaired send site: text for the clipboard. */
  prompt?: string;
}

const samePlace = (a: Target, b: Target) =>
  a.file === b.file && a.line === b.line && a.column === b.column;

const siteTarget = (s: Site): Target => {
  const t: Target = { file: s.file, line: s.line, column: s.column };
  if (s.symbol !== undefined) t.symbol = s.symbol;
  return t;
};

/** The reactor's enclosing function, or `file.c:line` (1-based) at file scope. */
const spot = (t: Target) =>
  t.symbol ?? `${t.file.slice(t.file.lastIndexOf('/') + 1)}:${t.line + 1}`;

/** The receive site a reactor stands for; undefined for a handler definition. */
const receiveAt = (p: Pairing, r: Reactor, sites: Site[]) =>
  r.via === 'handler' || r.via === 'registered'
    ? undefined
    : sites.find((s) => s.role === 'receive' && s.rule === p.send.rule && samePlace(s, r));

/**
 * A receive site followed only by the send site's handler: the handler runs from the receive site.
 * (An anchored reactor next to a handler reactor is always a receive site: an anchored connection
 * that picks a handler definition replaces the handler reactors.)
 */
const isReceiveThenHandler = (targets: (Target & Partial<Pick<Reactor, 'via'>>)[]) =>
  targets.length === 2 &&
  (targets[0]!.via === 'key' || targets[0]!.via === 'anchored') &&
  targets[1]!.via === 'handler';

/**
 * The reactors a send lens shows. In the callback-slot case (receive sites matched by key that
 * register handlers) the registered functions are what runs, so only they are shown.
 */
function shownReactors(p: Pairing): Reactor[] {
  const registered = p.reactors.filter((r) => r.via === 'registered');
  const slot =
    registered.length > 0 && p.reactors.every((r) => r.via === 'key' || r.via === 'registered');
  return slot ? registered : p.reactors;
}

/**
 * Title of the lens on a send site. `sites` are the index's sites; the receive site behind a
 * reactor says whether it is a `case` or `test`, which the title names with its key.
 */
export function sendLensTitle(p: Pairing, sites: Site[]): string {
  const shown = shownReactors(p);
  if (shown.length === 0) return '↳ no reactor found';
  const [first, second] = shown;
  const site = receiveAt(p, first!, sites);
  let body: string;
  const pair = isReceiveThenHandler(shown);
  if (shown.length === 1 || pair) {
    body = spot(first!);
    if (site && (site.matcher === 'case' || site.matcher === 'test') && site.key !== undefined)
      body += ` · ${site.matcher} ${site.key}`;
    if (p.context !== undefined) body += ` (${p.context})`;
    if (pair) body += ` → then ${spot(second!)}`;
  } else body = `${shown.length} reactors: ${shown.map(spot).join(', ')}`;
  const title = p.title === undefined ? '' : `${p.title}: `;
  const unconfirmed = shown.some((r) => !r.confirmed) ? ' · unconfirmed' : '';
  return `↳ ${title}${body}${unconfirmed}`;
}

/** Ready-to-paste instructions for a coding agent to pair a send site nothing reacts to. */
export function agentPrompt(site: Site): string {
  const where = `${site.file} (${site.symbol ? `in \`${site.symbol}\`` : 'at file scope'}, line ${site.line + 1})`;
  const what = [
    site.key !== undefined ? `key \`${site.key}\`` : '',
    site.handler !== undefined ? `handler \`${site.handler}\`` : '',
    site.unresolvedHandler ? 'a handler that is not a plain identifier' : '',
  ]
    .filter(Boolean)
    .join(', ');
  return (
    `Flowbook: a send site of rule "${site.rule}" in ${where}${what ? ` with ${what}` : ''} has no reactor. ` +
    `Find the code that handles it, then add a \`connection\` record for rule "${site.rule}" to ${CONNECTIONS_FILE} ` +
    `(keyed by its key, or anchored with \`send\` and \`receive\` functions), or fix the rule's matchers. ` +
    `Then run \`flowbook sites --rule ${site.rule} --unpaired\` and \`flowbook check\`.`
  );
}

/** The index with `docScan` standing in for the saved scan of `rel`. */
function indexWith(
  connections: Connections,
  scans: Map<string, FileScan>,
  rel: string,
  docScan: FileScan,
): ConnectionIndex {
  const copy = new Map(scans);
  copy.set(rel, docScan);
  return buildConnectionIndex(connections, copy);
}

/** Distinct reactors of the send sites on `line`, in order. */
function reactorsOn(index: ConnectionIndex, rel: string, line: number): Reactor[] {
  const out: Reactor[] = [];
  for (const p of index.pairings) {
    if (p.send.file !== rel || p.send.line !== line) continue;
    for (const r of p.reactors) if (!out.some((o) => samePlace(o, r))) out.push(r);
  }
  return out;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Lenses for one document, computed from its current text. */
export function documentLenses(
  connections: Connections,
  scans: Map<string, FileScan>,
  rel: string,
  docScan: FileScan,
): ConnLens[] {
  if (connections.rules.length === 0) return [];
  const index = indexWith(connections, scans, rel, docScan);
  const out: ConnLens[] = [];

  for (const p of index.pairings) {
    if (p.send.file !== rel) continue;
    const lens: ConnLens = {
      line: p.send.line,
      title: sendLensTitle(p, index.sites),
      command: 'flowbook.goToReactor',
      targets: p.reactors.map((r) => ({ ...r })),
    };
    if (p.reactors.length === 0) lens.prompt = agentPrompt(p.send);
    out.push(lens);
  }

  // Reactor lenses: receive sites on consecutive lines share one lens; handler name lines get one each.
  const receiveLines = [
    ...new Set(
      index.sites.filter((s) => s.file === rel && s.role === 'receive').map((s) => s.line),
    ),
  ].sort((a, b) => a - b);
  const runs: number[][] = [];
  for (const line of receiveLines) {
    const last = runs[runs.length - 1];
    if (last && last[last.length - 1] === line - 1) last.push(line);
    else runs.push([line]);
  }
  const taken = new Set(receiveLines);
  for (const s of docScan.symbols)
    if (s.kind === 'function' && !taken.has(s.nameLine)) {
      taken.add(s.nameLine);
      runs.push([s.nameLine]);
    }

  for (const run of runs) {
    const senders = new Set<Site>();
    for (const line of run) for (const s of sendersOf(index, { file: rel, line })) senders.add(s);
    if (senders.size === 0) continue;
    const keys = new Set(
      index.sites
        .filter((s) => s.file === rel && s.role === 'receive' && run.includes(s.line))
        .flatMap((s) => s.key ?? []),
    );
    const head = keys.size > 1 ? `${keys.size} keys · ` : '';
    out.push({
      line: run[0]!,
      title: `↳ ${head}posted from ${plural(senders.size, 'place')}`,
      command: 'flowbook.goToSender',
      targets: [...senders].map(siteTarget),
    });
  }
  return out.sort((a, b) => a.line - b.line);
}

export function targetsAt(
  connections: Connections,
  scans: Map<string, FileScan>,
  rel: string,
  docScan: FileScan,
  line: number,
  direction: 'reactor' | 'sender',
): Target[] {
  if (connections.rules.length === 0) return [];
  const index = indexWith(connections, scans, rel, docScan);
  if (direction === 'reactor') return reactorsOn(index, rel, line).map((r) => ({ ...r }));
  return sendersOf(index, { file: rel, line }).map(siteTarget);
}

/**
 * The target a jump opens without asking: the only one, or a key (or anchored) reactor followed
 * only by its handler, since the handler runs from there. Undefined when the targets should be
 * peeked.
 */
export function directTarget(targets: Target[]): Target | undefined {
  if (targets.length === 1 || isReceiveThenHandler(targets)) return targets[0];
  return undefined;
}
