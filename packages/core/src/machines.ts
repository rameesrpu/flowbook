import { z } from 'zod';
import { Matcher, matcherRegex } from './connections.js';
import { parseLines, type Diagnostic, type Located } from './parse.js';
import { Anchor, Id } from './schema.js';

export const MACHINES_FILE = '.flowbook/machines.jsonl';

const Name = z.string().min(1).describe('Regular expression that must match the whole name');
const Slot = z
  .union([z.number().int().min(1), z.string().min(1)])
  .describe('1-based position, or the name of a designator field');

/** Set-site matcher: a call or an assign matcher (it must yield a key; checked in validation). */
export const SetMatcher = z.union([Matcher.options[0], Matcher.options[3]]);
export type SetMatcher = z.infer<typeof SetMatcher>;

export const TableSpec = z
  .object({
    rows: Name.describe('Regular expression for the array names that hold transition rows'),
    event: Slot,
    to: Slot,
    action: Slot.optional(),
    from: z
      .record(z.string(), z.string())
      .describe('Array name (row group) to the source state of its rows'),
  })
  .strict();
export type TableSpec = z.infer<typeof TableSpec>;

export const MachineRecord = z
  .object({
    kind: z.literal('machine'),
    id: Id,
    title: z.string().min(1),
    states: Name.describe('Regular expression for state names'),
    events: Name.optional().describe('Regular expression for event names'),
    set: z.array(SetMatcher).optional().describe('Sites that set the state; each must yield a key'),
    tables: z.array(TableSpec).optional(),
    files: z.array(z.string().min(1)).optional().describe('Globs limiting where it applies'),
    context: z.string().optional(),
    notes: z.string().optional().describe('Markdown text'),
  })
  .strict();
export type MachineRecord = z.infer<typeof MachineRecord>;

export const ScopeRecord = z
  .object({
    kind: z.literal('scope'),
    id: Id,
    machine: Id.describe('Id of the machine it belongs to'),
    state: z.string().min(1).describe('Source state of every set site inside `in`'),
    in: z.array(Anchor).min(1),
  })
  .strict();
export type ScopeRecord = z.infer<typeof ScopeRecord>;

export const MachinesFileRecord = z.discriminatedUnion('kind', [MachineRecord, ScopeRecord]);

export interface Machines {
  machines: Located<MachineRecord>[];
  scopes: Located<ScopeRecord>[];
}

export function parseMachines(
  text: string,
  file: string,
  diagnostics: Diagnostic[] = [],
): Machines {
  const records = parseLines(text, file, MachinesFileRecord, diagnostics);
  return {
    machines: records.filter((r) => r.kind === 'machine'),
    scopes: records.filter((r) => r.kind === 'scope'),
  };
}

export function validateMachines(m: Machines, file: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const err = (r: Located<{ id: string }>, message: string) =>
    out.push({ severity: 'error', file, line: r.line, id: r.id, message });
  const regex = (r: Located<{ id: string }>, what: string, name: string): RegExp | undefined => {
    try {
      return matcherRegex(name);
    } catch (e) {
      err(r, `invalid regular expression "${name}" in ${what}: ${(e as Error).message}`);
      return undefined;
    }
  };

  const seen = new Map<string, number>();
  for (const r of [...m.machines, ...m.scopes].sort((a, b) => a.line - b.line)) {
    const first = seen.get(r.id);
    if (first !== undefined) err(r, `duplicate id "${r.id}" (first defined on line ${first})`);
    else seen.set(r.id, r.line);
  }

  const states = new Map<string, RegExp | undefined>();
  for (const r of m.machines) {
    states.set(r.id, regex(r, '"states"', r.states));
    if (r.events !== undefined) regex(r, '"events"', r.events);
    if (!r.set?.length && !r.tables?.length) err(r, 'a machine needs "set" or "tables"');
    for (const s of r.set ?? []) {
      if ('call' in s) {
        regex(r, '"set"', s.call);
        if (s.key === undefined) err(r, `"set" matcher "${s.call}" needs "key"`);
        if (s.handler !== undefined) err(r, `"set" matcher "${s.call}" cannot have "handler"`);
        if (s.keyMember && s.key === undefined) err(r, '"keyMember" needs "key"');
      } else {
        regex(r, '"set"', s.assign);
        if (s.as !== 'key') err(r, `"set" matcher "${s.assign}" needs "as": "key"`);
      }
      if (s.keys !== undefined) regex(r, '"keys"', s.keys);
    }
    const stateRe = states.get(r.id);
    for (const t of r.tables ?? []) {
      regex(r, '"rows"', t.rows);
      for (const [array, state] of Object.entries(t.from)) {
        if (stateRe && !stateRe.test(state))
          err(r, `"from" state "${state}" (for ${array}) does not match "states"`);
      }
    }
  }

  for (const s of m.scopes) {
    if (!states.has(s.machine)) {
      err(s, `unknown machine "${s.machine}"`);
      continue;
    }
    const stateRe = states.get(s.machine);
    if (stateRe && !stateRe.test(s.state))
      err(s, `scope state "${s.state}" does not match "states" of machine "${s.machine}"`);
  }
  return out;
}
