export type Selection =
  | { kind: 'node'; id: string }
  | { kind: 'edge'; id: string; steps: string[] }
  | { kind: 'step'; id: string }
  | { kind: 'block'; id: string };
