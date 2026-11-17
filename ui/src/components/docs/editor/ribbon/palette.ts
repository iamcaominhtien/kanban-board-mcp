/**
 * The named colours of the editor (server/contract/richdoc/palette.json): 12 text colours and 12 highlights, stored
 * by NAME and drawn through the page's CSS variables (`--rd-c-<name>`, `--rd-hl-<name>`), so they follow the page
 * background. A custom colour is stored as `#rrggbb` and gets a contrast check against the page (a warning under
 * 4.5 : 1, never a block). Recent colours are kept per device.
 */

import {
  BACKGROUNDS,
  HIGHLIGHT_NAMES,
  PALETTE,
  TEXT_COLOR_NAMES,
  contrastRatio,
  type PageBackground,
  type PaletteEntry,
} from '../../pageSettings';

export type TextColorName = (typeof TEXT_COLOR_NAMES)[number];
export type HighlightName = (typeof HIGHLIGHT_NAMES)[number];
/** Which palette a picker shows: text colours or highlights. */
export type ColorKind = 'text' | 'highlight';

export { HIGHLIGHT_NAMES, TEXT_COLOR_NAMES };

/** A stored custom colour. */
export const HEX_RE = /^#[0-9a-f]{6}$/i;
/** The contrast a text colour needs on its page (WCAG AA for body text). */
export const MIN_CONTRAST = 4.5;

/** "green" → "Green": the name a person reads under a swatch. */
export function colorLabel(name: string): string {
  return HEX_RE.test(name) ? name.toUpperCase() : name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Whether `value` is a name of the palette of that kind.
 * @param kind - `text` or `highlight`.
 * @param value - A stored colour.
 */
export function isNamed(kind: ColorKind, value: unknown): boolean {
  return (
    typeof value === 'string' &&
    (kind === 'text' ? (TEXT_COLOR_NAMES as readonly string[]) : (HIGHLIGHT_NAMES as readonly string[])).includes(value)
  );
}

/**
 * The CSS value that draws a stored colour: a name becomes its page variable (with the white page's value as a
 * fallback), `#rrggbb` stays, anything else is `undefined`.
 * @param kind - `text` or `highlight`.
 * @param value - The stored colour.
 */
export function cssColor(kind: ColorKind, value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (HEX_RE.test(value)) return value;
  if (kind === 'text' && isNamed('text', value))
    return `var(--rd-c-${value}, ${PALETTE.white.text[value as TextColorName]})`;
  if (kind === 'highlight' && isNamed('highlight', value))
    return `var(--rd-hl-${value}, ${PALETTE.white.highlight[value as HighlightName]})`;
  return undefined;
}

/**
 * The page background whose page colour is `pageHex` (`white` when none matches).
 * @param pageHex - The page colour, `#rrggbb`.
 */
export function backgroundOf(pageHex: string): PageBackground {
  const hex = pageHex.toLowerCase();
  return BACKGROUNDS.find((b) => PALETTE[b].page.toLowerCase() === hex) ?? 'white';
}

/**
 * The palette values on a page.
 * @param pageHex - The page colour, `#rrggbb`.
 */
export function paletteFor(pageHex: string): PaletteEntry {
  return PALETTE[backgroundOf(pageHex)];
}

/**
 * The hex value a stored colour has on a page (for swatches and contrast); `null` for an unknown value.
 * @param kind - `text` or `highlight`.
 * @param value - A palette name or `#rrggbb`.
 * @param pageHex - The page colour.
 */
export function hexOf(kind: ColorKind, value: string, pageHex: string): string | null {
  if (HEX_RE.test(value)) return value;
  const pal = paletteFor(pageHex);
  if (kind === 'text' && isNamed('text', value)) return pal.text[value as TextColorName];
  if (kind === 'highlight' && isNamed('highlight', value)) return pal.highlight[value as HighlightName];
  return null;
}

/**
 * A typed colour as `#rrggbb` (lower case), or `null` when it is not one: `2e6f40`, `#2E6F40` and `#abc` are taken.
 * @param input - What the person typed.
 */
export function normalizeHex(input: string): string | null {
  let v = input.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(v)) v = [...v].map((c) => c + c).join('');
  return /^[0-9a-f]{6}$/i.test(v) ? `#${v.toLowerCase()}` : null;
}

/**
 * `#rrggbb` from red, green and blue (0 to 255, clamped).
 * @param r - Red.
 * @param g - Green.
 * @param b - Blue.
 */
export function rgbToHex(r: number, g: number, b: number): string {
  const c = (n: number) =>
    Math.max(0, Math.min(255, Math.round(Number.isFinite(n) ? n : 0)))
      .toString(16)
      .padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/**
 * Red, green and blue of `#rrggbb`.
 * @param hex - The colour.
 */
export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Hue (0 to 360) and saturation (0 to 1) of `#rrggbb`. */
function hueSat(hex: string): [number, number] {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (!d) return [0, 0];
  const l = (max + min) / 2;
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s];
}

/** What the contrast line under a custom colour says. */
export interface ContrastCheck {
  /** Contrast against the page, 1 to 21. */
  ratio: number;
  /** At least 4.5 : 1. */
  ok: boolean;
  /** The nearest named text colour that reads well on this page, offered when `ok` is false. */
  suggestion: TextColorName | null;
  /** "Contrast on this page 6.1 : 1. Easy to read." or "… Hard to read on white. Try Amber." */
  message: string;
}

/**
 * The contrast of a custom text colour on its page, with a nearby palette colour to try when it is low. It only
 * warns: the colour can be used either way.
 * @param hex - The custom colour, `#rrggbb`.
 * @param pageHex - The page colour, `#rrggbb`.
 */
export function checkContrast(hex: string, pageHex: string): ContrastCheck {
  const ratio = contrastRatio(hex, pageHex);
  const shown = (Math.floor(ratio * 10) / 10).toFixed(1);
  if (ratio >= MIN_CONTRAST)
    return { ratio, ok: true, suggestion: null, message: `Contrast on this page ${shown} : 1. Easy to read.` };
  const pal = paletteFor(pageHex);
  const [h, s] = hueSat(hex);
  let best: TextColorName | null = null;
  let bestD = Infinity;
  for (const name of TEXT_COLOR_NAMES) {
    if (name === 'ink' || contrastRatio(pal.text[name], pageHex) < MIN_CONTRAST) continue;
    const [h2, s2] = hueSat(pal.text[name]);
    // the nearest hue; a grey custom colour is nearest to the greys
    const dh = Math.min(Math.abs(h - h2), 360 - Math.abs(h - h2));
    const d = s < 0.15 || s2 < 0.15 ? Math.abs(s - s2) * 400 + (s2 < 0.15 ? 0 : 200) : dh + Math.abs(s - s2) * 30;
    if (d < bestD) {
      bestD = d;
      best = name;
    }
  }
  const bg = backgroundOf(pageHex);
  return {
    ratio,
    ok: false,
    suggestion: best,
    message: `Contrast on this page ${shown} : 1. Hard to read on ${bg}.${best ? ` Try ${colorLabel(best)}.` : ''}`,
  };
}

const RECENT_KEY = 'docsRecentColors';
const RECENT_MAX = 5;

/**
 * The last five colours used on this device, newest first.
 * @param kind - `text` or `highlight`.
 */
export function recentColors(kind: ColorKind): string[] {
  try {
    const all = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '{}') as Partial<Record<ColorKind, unknown>>;
    const list = all[kind];
    return Array.isArray(list)
      ? list.filter((v): v is string => typeof v === 'string' && (isNamed(kind, v) || HEX_RE.test(v)))
      : [];
  } catch {
    return [];
  }
}

/**
 * Puts a colour first in the recent list of its kind (at most five are kept).
 * @param kind - `text` or `highlight`.
 * @param value - The colour used: a name or `#rrggbb`.
 */
export function rememberColor(kind: ColorKind, value: string): void {
  try {
    const all = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '{}') as Record<string, unknown>;
    const next = [value, ...recentColors(kind).filter((v) => v !== value)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify({ ...all, [kind]: next }));
  } catch {
    /* storage is off: nothing is remembered */
  }
}
