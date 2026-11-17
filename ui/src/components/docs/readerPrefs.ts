/**
 * Reader preferences (design board "Rich Docs — reading", B): what a reader changes for themselves while reading a
 * page — text size, Page / Serif / Sans, line width, a White, Sepia or Night theme and justified text. They stay on
 * this device (localStorage), apply over the page's own settings, and never change the page for anyone else.
 * White keeps the author's colours; Sepia and Night are reading themes that never print.
 */

import { useEffect, useState, type CSSProperties } from 'react';
import { lookVars, readPageLook, type PageFont, type PageLook, type PageWidth } from './pageSettings';

export type ReaderTheme = 'white' | 'sepia' | 'night';
/** `page` keeps the fonts the author chose. */
export type ReaderFont = 'page' | 'serif' | 'sans';
/** `page` keeps the width the author chose. */
export type ReaderWidth = 'page' | Exclude<PageWidth, 'full'>;

/** One reader's settings on this device. */
export interface ReaderPrefs {
  /** Body text size in CSS pixels; `null` keeps the page's own size. */
  size: number | null;
  theme: ReaderTheme;
  font: ReaderFont;
  width: ReaderWidth;
  /** Even edges on both sides. */
  justify: boolean;
}

export const DEFAULT_READER_PREFS: ReaderPrefs = {
  size: null,
  theme: 'white',
  font: 'page',
  width: 'page',
  justify: false,
};

/** The four steps of the text size; the slider moves between {@link READER_SIZE_MIN} and {@link READER_SIZE_MAX}. */
export const READER_SIZE_STEPS: readonly { px: number; label: string }[] = [
  { px: 15, label: 'Small' },
  { px: 17, label: 'Medium' },
  { px: 19, label: 'Large' },
  { px: 22, label: 'Extra large' },
];
export const READER_SIZE_MIN = 14;
export const READER_SIZE_MAX = 24;

/** The localStorage key of the preferences. */
export const READER_PREFS_KEY = 'docsReaderPrefs';

const SERIFS: readonly PageFont[] = ['lora', 'source-serif', 'merriweather', 'playfair'];
const THEMES: readonly ReaderTheme[] = ['white', 'sepia', 'night'];
const FONTS: readonly ReaderFont[] = ['page', 'serif', 'sans'];
const WIDTHS: readonly ReaderWidth[] = ['page', 'narrow', 'normal', 'wide'];

/**
 * Checks stored preferences, keeping each valid value and the default for the rest.
 * @param raw - What was stored (any JSON).
 */
export function cleanReaderPrefs(raw: unknown): ReaderPrefs {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const size =
    typeof r.size === 'number' && r.size >= READER_SIZE_MIN && r.size <= READER_SIZE_MAX ? Math.round(r.size) : null;
  return {
    size,
    theme: THEMES.includes(r.theme as ReaderTheme) ? (r.theme as ReaderTheme) : 'white',
    font: FONTS.includes(r.font as ReaderFont) ? (r.font as ReaderFont) : 'page',
    width: WIDTHS.includes(r.width as ReaderWidth) ? (r.width as ReaderWidth) : 'page',
    justify: r.justify === true,
  };
}

/** The preferences stored on this device (the defaults when there are none or storage is blocked). */
export function readReaderPrefs(): ReaderPrefs {
  try {
    const raw = localStorage.getItem(READER_PREFS_KEY);
    return raw ? cleanReaderPrefs(JSON.parse(raw)) : DEFAULT_READER_PREFS;
  } catch {
    return DEFAULT_READER_PREFS;
  }
}

const listeners = new Set<(p: ReaderPrefs) => void>();

/**
 * Stores the preferences on this device and tells every open reader (the page and the public view at once).
 * @param prefs - The new preferences.
 */
export function writeReaderPrefs(prefs: ReaderPrefs): void {
  try {
    localStorage.setItem(READER_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* storage blocked: they hold until the page is closed */
  }
  listeners.forEach((l) => l(prefs));
}

/**
 * The reader's preferences and a setter: a patch changes some of them, `null` resets them all.
 * Kept in step with other readers on the page and with other tabs.
 */
export function useReaderPrefs(): [ReaderPrefs, (patch: Partial<ReaderPrefs> | null) => void] {
  const [prefs, setPrefs] = useState<ReaderPrefs>(readReaderPrefs);
  useEffect(() => {
    listeners.add(setPrefs);
    const onStorage = (e: StorageEvent) => {
      if (e.key === READER_PREFS_KEY) setPrefs(readReaderPrefs());
    };
    window.addEventListener('storage', onStorage);
    return () => {
      listeners.delete(setPrefs);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  const change = (patch: Partial<ReaderPrefs> | null) => {
    writeReaderPrefs(patch ? cleanReaderPrefs({ ...readReaderPrefs(), ...patch }) : DEFAULT_READER_PREFS);
  };
  return [prefs, change];
}

/**
 * The page's settings with the reader's font and width over them (Sans swaps a serif page to sans, Serif a sans
 * page to serif). The theme is not applied here: it is a class (see {@link readerClass}), so it never prints.
 * @param look - The page's own settings.
 * @param prefs - The reader's preferences.
 */
export function applyReaderLook(look: PageLook, prefs: ReaderPrefs): PageLook {
  const out = { ...look };
  if (prefs.font === 'sans') {
    if (SERIFS.includes(out.bodyFont)) out.bodyFont = 'jakarta';
    if (out.headingFont && SERIFS.includes(out.headingFont)) out.headingFont = null;
  } else if (prefs.font === 'serif') {
    if (!SERIFS.includes(out.bodyFont)) out.bodyFont = 'source-serif';
    if (out.headingFont && !SERIFS.includes(out.headingFont)) out.headingFont = null;
  }
  if (prefs.width !== 'page') out.width = prefs.width;
  return out;
}

/**
 * The CSS custom properties the reader's text size sets (`--dp-size`; headings are sized from it).
 * @param prefs - The reader's preferences.
 */
export function readerVars(prefs: ReaderPrefs): CSSProperties {
  return (prefs.size ? { '--dp-size': `${prefs.size}px` } : {}) as CSSProperties;
}

/**
 * The classes of the reader's theme and justification: `dk-rt-sepia` / `dk-rt-night` (colours from
 * {@link readerThemeCss}, screen only) and `dk-justify`.
 * @param prefs - The reader's preferences.
 */
export function readerClass(prefs: ReaderPrefs): string {
  return [prefs.theme !== 'white' ? `dk-rt-${prefs.theme}` : '', prefs.justify ? 'dk-justify' : '']
    .filter(Boolean)
    .join(' ');
}

const COLOR_VAR = /^--(dp-(page|ink|text|muted|rule|surface|link)|rd-(c|hl)-)/;

/**
 * The style sheet of the reading themes: the page colours of Sepia and Night (palette.json, the named colours
 * mapped too) over the author's, for the screen only — a reading theme never prints.
 */
export function readerThemeCss(): string {
  const rules = (['sepia', 'night'] as const).map((bg) => {
    const vars = lookVars({ ...readPageLook({}), background: bg }) as Record<string, string>;
    const decl = Object.entries(vars)
      .filter(([k]) => COLOR_VAR.test(k))
      .map(([k, v]) => `${k}:${v} !important;`)
      .join('');
    return `.dk-rt-${bg}{${decl}}`;
  });
  return `@media screen{${rules.join('')}}`;
}

/**
 * The size shown beside "Text size": the reader's, or the page's own when they kept it.
 * @param prefs - The reader's preferences.
 * @param pagePx - The page's own body size in CSS pixels.
 */
export function readerSizeLabel(prefs: ReaderPrefs, pagePx: number): string {
  return `${prefs.size ?? pagePx} px`;
}
