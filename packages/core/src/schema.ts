import { z } from 'zod';

/** Ids are short, human-readable slugs, e.g. `parse-header`, `tls.handshake`. */
export const Id = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'ids may contain letters, digits, ".", "_" and "-"');

const Markdown = z.string().describe('Markdown text');

export const Anchor = z
  .object({
    file: z
      .string()
      .min(1)
      .refine((f) => !f.startsWith('/') && !f.includes('\\'), 'use a repo-relative POSIX path')
      .describe('Repo-relative path to the source file, e.g. "src/net/tls.c"'),
    symbol: z
      .string()
      .min(1)
      .describe('Qualified symbol name, e.g. "parse_header" or "net::TlsSession::handshake"'),
    sig: z
      .string()
      .optional()
      .describe('Parameter types to pick one overload, e.g. "(const char*, size_t)"'),
  })
  .strict();

export const FlowRecord = z
  .object({
    kind: z.literal('flow'),
    id: Id.describe('Must match the file name (flows/<id>.jsonl)'),
    title: z.string().min(1),
    summary: Markdown.optional(),
    entry: Id.optional().describe('Node id where the scenario starts'),
    tags: z.array(z.string()).optional(),
    layout: z
      .object({ direction: z.enum(['LR', 'TB']).optional() })
      .strict()
      .optional(),
  })
  .strict();

export const NodeRecord = z
  .object({
    kind: z.literal('node'),
    id: Id,
    title: z.string().min(1),
    notes: Markdown.optional(),
    anchor: Anchor.optional().describe('Omit for external actors (kernel, database, peer, user)'),
    fp: z
      .string()
      .optional()
      .describe('Body fingerprint written by `flowbook stamp`; do not edit by hand'),
    verified: z
      .string()
      .optional()
      .describe('Commit SHA the fingerprint was taken at; written by `flowbook stamp`'),
    flow: Id.optional().describe('Id of another flow that details this node (drill-down)'),
  })
  .strict();

export const StepType = z.enum(['call', 'return', 'async', 'callback', 'signal']);

export const StepRecord = z
  .object({
    kind: z.literal('step'),
    id: Id,
    seq: z.number().int().positive().describe('Order within the flow, starting at 1'),
    from: Id,
    to: Id,
    label: z.string().min(1).describe('What happens and why, not just the callee name'),
    type: StepType.default('call'),
    guard: z.string().optional().describe('Condition under which this step happens'),
    notes: Markdown.optional(),
  })
  .strict();

export const BlockRecord = z
  .object({
    kind: z.literal('block'),
    id: Id,
    type: z.enum(['loop', 'alt', 'par']),
    label: z.string().min(1).describe('e.g. "for each packet", "auth result", "worker threads"'),
    steps: z.array(Id).min(1),
  })
  .strict();

export const FlowFileRecord = z.discriminatedUnion('kind', [
  FlowRecord,
  NodeRecord,
  StepRecord,
  BlockRecord,
]);

export const ConfigRecord = z.object({ kind: z.literal('config'), version: z.literal(1) }).strict();

export const GroupRecord = z
  .object({
    kind: z.literal('group'),
    name: z.string().min(1).describe('Component name shown in diagrams, e.g. "Networking"'),
    paths: z.array(z.string().min(1)).min(1).describe('Globs, e.g. ["src/net/**"]'),
  })
  .strict();

export const ConfigFileRecord = z.discriminatedUnion('kind', [ConfigRecord, GroupRecord]);

export type Anchor = z.infer<typeof Anchor>;
export type FlowRecord = z.infer<typeof FlowRecord>;
export type NodeRecord = z.infer<typeof NodeRecord>;
export type StepType = z.infer<typeof StepType>;
export type StepRecord = z.infer<typeof StepRecord>;
export type BlockRecord = z.infer<typeof BlockRecord>;
export type FlowFileRecord = z.infer<typeof FlowFileRecord>;
export type GroupRecord = z.infer<typeof GroupRecord>;
export type ConfigFileRecord = z.infer<typeof ConfigFileRecord>;
