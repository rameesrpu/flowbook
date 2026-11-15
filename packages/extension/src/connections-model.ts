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
  type SymbolInfo,
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

/** The last `::` segment of a handler or symbol name. */
const leaf = (name: string) => name.slice(name.lastIndexOf(':') + 1);

/**
 * The reactors a send lens shows, and its click targets. A key reactor whose receive site
 * registers a handler (the callback-slot case) is replaced by the registered function, which is
 * what runs; every other reactor stays.
 */
function shownReactors(p: Pairing, sites: Site[]): Reactor[] {
  const registered = new Set(
    p.reactors.filter((r) => r.via === 'registered' && r.symbol).map((r) => leaf(r.symbol!)),
  );
  return p.reactors.filter((r) => {
    if (r.via !== 'key') return true;
    const handler = receiveAt(p, r, sites)?.handler;
    return handler === undefined || !registered.has(leaf(handler));
  });
}

/** Distinct shown reactors of several pairings, in order. */
function shownOf(pairings: Pairing[], sites: Site[]): Reactor[] {
  const out: Reactor[] = [];
  for (const p of pairings)
    for (const r of shownReactors(p, sites)) if (!out.some((o) => samePlace(o, r))) out.push(r);
  return out;
}

/** Names for a reactor list, told apart by file base name, then by line, where they collide. */
function names(reactors: Reactor[]): string[] {
  const base = (t: Target) => t.file.slice(t.file.lastIndexOf('/') + 1);
  const plain = reactors.map(spot);
  const withFile = reactors.map((r, i) => `${plain[i]} (${base(r)})`);
  const withLine = reactors.map((r, i) => `${plain[i]} (${base(r)}:${r.line + 1})`);
  const clash = (list: string[], i: number) => list.some((n, j) => j !== i && n === list[i]);
  return reactors.map((_, i) =>
    !clash(plain, i) ? plain[i]! : !clash(withFile, i) ? withFile[i]! : withLine[i]!,
  );
}

/** One value when every pairing has the same one. */
function common(pairings: Pairing[], pick: (p: Pairing) => string | undefined) {
  const values = new Set(pairings.map(pick));
  return values.size === 1 ? [...values][0] : undefined;
}

/**
 * Title of the lens on a line of send sites (usually one). `sites` are the index's sites; the
 * receive site behind a reactor says whether it is a `case` or `test`, which the title names with
 * its key. A connection title or context is shown when every pairing on the line shares it.
 */
export function sendLensTitle(pairings: Pairing | Pairing[], sites: Site[]): string {
  const list = Array.isArray(pairings) ? pairings : [pairings];
  const shown = shownOf(list, sites);
  if (shown.length === 0) return '↳ no reactor found';
  const [first, second] = shown;
  const pair = isReceiveThenHandler(shown);
  let body: string;
  if (shown.length === 1 || pair) {
    const owner = list.find((p) => p.reactors.includes(first!))!;
    const site = receiveAt(owner, first!, sites);
    body = spot(first!);
    if (site && (site.matcher === 'case' || site.matcher === 'test') && site.key !== undefined)
      body += ` · ${site.matcher} ${site.key}`;
    const context = common(list, (p) => p.context);
    if (context !== undefined) body += ` (${context})`;
    if (pair) body += ` → then ${spot(second!)}`;
  } else body = `${shown.length} reactors: ${names(shown).join(', ')}`;
  const title = common(list, (p) => p.title);
  const prefix = title === undefined ? '' : `${title}: `;
  const unconfirmed = shown.some((r) => !r.confirmed) ? ' · unconfirmed' : '';
  return `↳ ${prefix}${body}${unconfirmed}`;
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

/** The index for a document with unsaved edits: `docScan` stands in for the saved scan of `rel`. */
export function documentIndex(
  connections: Connections,
  scans: Map<string, FileScan>,
  rel: string,
  docScan: FileScan,
): ConnectionIndex {
  const copy = new Map(scans);
  copy.set(rel, docScan);
  return buildConnectionIndex(connections, copy);
}

/** Pairings of the send sites on `line` of `rel`. */
const pairingsOn = (index: ConnectionIndex, rel: string, line: number) =>
  index.pairings.filter((p) => p.send.file === rel && p.send.line === line);

const copyTarget = (r: Reactor): Reactor => ({ ...r });

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Lenses for one document. `index` covers the document's current text (the root's index for a
 * saved document, `documentIndex` for one with unsaved edits); `symbols` are its definitions.
 */
export function documentLenses(
  index: ConnectionIndex,
  rel: string,
  symbols: SymbolInfo[],
): ConnLens[] {
  const out: ConnLens[] = [];

  // One send lens per line, covering every send site on it.
  const sendLines = [
    ...new Set(index.pairings.filter((p) => p.send.file === rel).map((p) => p.send.line)),
  ];
  for (const line of sendLines) {
    const pairings = pairingsOn(index, rel, line);
    const lens: ConnLens = {
      line,
      title: sendLensTitle(pairings, index.sites),
      command: 'flowbook.goToReactor',
      targets: shownOf(pairings, index.sites).map(copyTarget),
    };
    const prompt = promptAt(index, rel, line);
    if (prompt !== undefined) lens.prompt = prompt;
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
  for (const s of symbols)
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

/** What `Go to Reactor` / `Go to Sender` jump to from `line`: the same targets the lens there has. */
export function targetsAt(
  index: ConnectionIndex,
  rel: string,
  line: number,
  direction: 'reactor' | 'sender',
): Target[] {
  if (direction === 'reactor')
    return shownOf(pairingsOn(index, rel, line), index.sites).map(copyTarget);
  return sendersOf(index, { file: rel, line }).map(siteTarget);
}

/** The agent prompt for the send sites on `line` when none of them has a reactor. */
export function promptAt(index: ConnectionIndex, rel: string, line: number): string | undefined {
  const pairings = pairingsOn(index, rel, line);
  if (pairings.length === 0 || shownOf(pairings, index.sites).length > 0) return undefined;
  return pairings.map((p) => agentPrompt(p.send)).join('\n\n');
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
