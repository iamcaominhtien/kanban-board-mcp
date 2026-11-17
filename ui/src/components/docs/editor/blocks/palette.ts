/**
 * The named colours blocks use (server/contract/richdoc/palette.json): callout colours come from the text palette,
 * table shading from the highlight palette. A stored value is a palette name or `#rrggbb`; on screen a name is the
 * page's CSS variable (`--rd-c-<name>`, `--rd-hl-<name>`, set by the page settings), with the white page's value as
 * fallback, as the reader draws it (RichDocView `colorOf`).
 */

import { HIGHLIGHT_NAMES, PALETTE, TEXT_COLOR_NAMES } from '../../pageSettings';

export type TextColorName = (typeof TEXT_COLOR_NAMES)[number];
export type HighlightName = (typeof HIGHLIGHT_NAMES)[number];

export { HIGHLIGHT_NAMES, TEXT_COLOR_NAMES };

const HEX_RE = /^#[0-9a-f]{6}$/i;

/** True for a `#rrggbb` value. */
export const isHex = (v: unknown): v is string => typeof v === 'string' && HEX_RE.test(v);

/**
 * The CSS value of a stored colour, or undefined for anything that is neither a palette name nor `#rrggbb`.
 * @param kind - `c` for the text palette, `hl` for the highlight palette.
 * @param value - The stored colour.
 */
export function colorCss(kind: 'c' | 'hl', value: unknown): string | undefined {
  if (isHex(value)) return value;
  if (typeof value !== 'string') return undefined;
  const white = PALETTE.white;
  const table: Record<string, string> = kind === 'c' ? white.text : white.highlight;
  return value in table ? `var(--rd-${kind}-${value}, ${table[value]})` : undefined;
}

/** The plain hex of a palette name on a white page (for swatches), or the value when it is already hex. */
export function swatchHex(kind: 'c' | 'hl', value: string): string {
  if (isHex(value)) return value;
  const table: Record<string, string> = kind === 'c' ? PALETTE.white.text : PALETTE.white.highlight;
  return table[value] ?? '#ffffff';
}

/** "violet" → "Violet". */
export const colorLabel = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);
