import type { StepType } from '@flowbook/core';

export type EdgeStyle = StepType | 'aggregated';

const OPEN: ReadonlySet<EdgeStyle> = new Set(['return', 'async', 'signal']);
const STYLES: EdgeStyle[] = ['call', 'return', 'async', 'callback', 'signal', 'aggregated'];

export const markerId = (style: EdgeStyle, highlighted = false) =>
  `fb-arrow-${style}${highlighted ? '-hl' : ''}`;

/**
 * Arrowheads shared by the flowchart and the sequence view. Markers are referenced by id from
 * anywhere in the document, so this is rendered once per view.
 */
export function ArrowDefs() {
  return (
    <svg className="fb-defs" width="0" height="0" aria-hidden>
      <defs>
        {STYLES.flatMap((style) =>
          [false, true].map((hl) => (
            <marker
              key={markerId(style, hl)}
              id={markerId(style, hl)}
              viewBox="0 0 10 10"
              refX="9.5"
              refY="5"
              markerWidth="11"
              markerHeight="11"
              markerUnits="userSpaceOnUse"
              orient="auto-start-reverse"
            >
              <path
                d={OPEN.has(style) ? 'M 1 1 L 9.5 5 L 1 9' : 'M 0 0.5 L 10 5 L 0 9.5 z'}
                className={`fb-mk fb-mk--${style}${OPEN.has(style) ? ' fb-mk--open' : ''}${hl ? ' fb-mk--hl' : ''}`}
              />
            </marker>
          )),
        )}
      </defs>
    </svg>
  );
}
