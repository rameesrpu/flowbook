import type { Anchor } from './schema.js';

/** Collapses whitespace in a signature so `(int,char *)` and `(int, char*)` compare equal. */
export function normalizeSig(sig: string): string {
  return sig
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),*&<>[\]])\s*/g, '$1')
    .trim();
}

/** Stable identity of a code location, shared by every flow that mentions it. */
export function anchorKey(anchor: Anchor): string {
  const sig = anchor.sig === undefined ? '' : normalizeSig(anchor.sig);
  return `${anchor.file}#${anchor.symbol}${sig}`;
}
