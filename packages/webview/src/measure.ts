const FONT_FAMILY = 'var(--vscode-font-family, system-ui, sans-serif)';
const MONO_FAMILY = 'var(--vscode-editor-font-family, ui-monospace, monospace)';

let ctx: CanvasRenderingContext2D | null | undefined;

/** Resolves a CSS font family that may be a custom property, for canvas measuring. */
function resolveFamily(family: string): string {
  const m = /^var\((--[^,]+),\s*(.+)\)$/.exec(family);
  if (!m) return family;
  const value = getComputedStyle(document.documentElement).getPropertyValue(m[1]!).trim();
  return value || m[2]!;
}

export function textWidth(text: string, size: number, opts: { bold?: boolean; mono?: boolean } = {}) {
  if (ctx === undefined) ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return text.length * size * 0.6;
  ctx.font = `${opts.bold ? '600 ' : ''}${size}px ${resolveFamily(opts.mono ? MONO_FAMILY : FONT_FAMILY)}`;
  return ctx.measureText(text).width;
}

export const truncate = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1) + '…' : s);
