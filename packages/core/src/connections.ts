import picomatch from 'picomatch';
import { z } from 'zod';
import type { Diagnostic, Located } from './parse.js';
import { Anchor, Id } from './schema.js';

export const CONNECTIONS_FILE = '.flowbook/connections.jsonl';

const Markdown = z.string().describe('Markdown text');
const Name = z.string().min(1).describe('Regular expression that must match the whole name');
const Position = z.number().int().min(1).describe('1-based argument position');
const Files = z.array(z.string().min(1)).optional().describe('Globs limiting where it applies');

export const Matcher = z.union([
  z
    .object({ call: Name, key: Position.optional(), handler: Position.optional(), files: Files })
    .strict(),
  z.object({ case: Name, files: Files }).strict(),
  z.object({ test: Name, files: Files }).strict(),
  z.object({ assign: Name, as: z.enum(['key', 'handler']), files: Files }).strict(),
  z.object({ invoke: Name, files: Files }).strict(),
]);
export type Matcher = z.infer<typeof Matcher>;

export const RuleType = z.enum(['queue', 'event', 'timer', 'callback', 'request']);
export type RuleType = z.infer<typeof RuleType>;

export const RuleRecord = z
  .object({
    kind: z.literal('rule'),
    id: Id,
    title: z.string().min(1),
    type: RuleType.describe('For display only'),
    send: z.array(Matcher).min(1),
    receive: z.array(Matcher).min(1).optional().describe('Omit when every send names a handler'),
    context: z.string().optional().describe('Where reactors run, e.g. "master thread"'),
    notes: Markdown.optional(),
  })
  .strict();
export type RuleRecord = z.infer<typeof RuleRecord>;

export const ConnectionRecord = z
  .object({
    kind: z.literal('connection'),
    id: Id,
    rule: Id.describe('Id of the rule it belongs to'),
    title: z.string().min(1),
    key: z.string().min(1).optional().describe('Keyed form'),
    send: z.array(Anchor).optional().describe('Anchored form: functions containing send sites'),
    receive: z
      .array(Anchor)
      .optional()
      .describe('Anchored form: functions containing receive sites'),
    context: z.string().optional(),
    notes: Markdown.optional(),
  })
  .strict();
export type ConnectionRecord = z.infer<typeof ConnectionRecord>;

export const ConnectionsFileRecord = z.discriminatedUnion('kind', [RuleRecord, ConnectionRecord]);

export interface Connections {
  rules: Located<RuleRecord>[];
  connections: Located<ConnectionRecord>[];
}

/** Compiles a matcher name; it must match the whole name. Throws on an invalid expression. */
export function matcherRegex(name: string): RegExp {
  return new RegExp(`^(?:${name})$`);
}

/** True when `globs` is undefined, otherwise when `path` matches one of them. */
export function matchesAny(path: string, globs: string[] | undefined): boolean {
  if (globs === undefined) return true;
  return globs.some((g) => picomatch(g)(path));
}

function matcherName(m: Matcher): string {
  if ('call' in m) return m.call;
  if ('case' in m) return m.case;
  if ('test' in m) return m.test;
  if ('assign' in m) return m.assign;
  return m.invoke;
}

export function validateConnections(c: Connections, file: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const err = (r: Located<{ id: string }>, message: string) =>
    out.push({ severity: 'error', file, line: r.line, id: r.id, message });

  const seen = new Map<string, number>();
  for (const r of [...c.rules, ...c.connections].sort((a, b) => a.line - b.line)) {
    const first = seen.get(r.id);
    if (first !== undefined) err(r, `duplicate id "${r.id}" (first defined on line ${first})`);
    else seen.set(r.id, r.line);
  }

  const ruleIds = new Set(c.rules.map((r) => r.id));
  for (const r of c.rules) {
    for (const m of [...r.send, ...(r.receive ?? [])]) {
      try {
        matcherRegex(matcherName(m));
      } catch (e) {
        err(r, `invalid regular expression "${matcherName(m)}": ${(e as Error).message}`);
      }
    }
    if (!r.receive && r.send.some((m) => !('call' in m) || m.handler === undefined)) {
      err(r, 'rule needs "receive" matchers unless every send matcher is a call with "handler"');
    }
  }

  for (const k of c.connections) {
    if (!ruleIds.has(k.rule)) err(k, `unknown rule "${k.rule}"`);
    const keyed = k.key !== undefined;
    const anchored = k.send !== undefined || k.receive !== undefined;
    if (keyed && anchored)
      err(k, 'a connection is keyed ("key") or anchored ("send"/"receive"), not both');
    else if (!keyed && !anchored) err(k, 'a connection needs "key", or "send" and "receive"');
    else if (anchored && (!k.send?.length || !k.receive?.length))
      err(k, 'an anchored connection needs non-empty "send" and "receive"');
  }
  return out;
}
