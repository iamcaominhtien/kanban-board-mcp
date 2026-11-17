import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BACKGROUNDS,
  FONTS,
  HIGHLIGHT_NAMES,
  LOOK_KEYS,
  PALETTE,
  TEXT_COLOR_NAMES,
  WIDTH_PX,
  contrastRatio,
  foldCrumbs,
  isWidePage,
  lookVars,
  mergeSettings,
  readPageLook,
  readingMinutes,
} from './pageSettings';

const contract = (name: string) =>
  JSON.parse(readFileSync(resolve(__dirname, '../../../../server/contract/richdoc', name), 'utf8'));

describe('page settings follow the contract', () => {
  it('has the palette of palette.json for every background', () => {
    const pal = contract('palette.json');
    expect([...TEXT_COLOR_NAMES]).toEqual(pal.textColors);
    expect([...HIGHLIGHT_NAMES]).toEqual(pal.highlightColors);
    expect(Object.keys(PALETTE).sort()).toEqual(Object.keys(pal.backgrounds).sort());
    for (const [bg, want] of Object.entries(pal.backgrounds) as [string, Record<string, unknown>][]) {
      expect(PALETTE[bg as keyof typeof PALETTE]).toEqual(want);
    }
  });

  it('knows every value and default of page-settings.json it draws', () => {
    const { keys } = contract('page-settings.json');
    expect([...BACKGROUNDS].sort()).toEqual([...keys.background.values].sort());
    expect([...FONTS].sort()).toEqual([...keys.bodyFont.values].sort());
    expect(WIDTH_PX).toEqual(keys.width.px);
    for (const k of LOOK_KEYS) expect(keys[k], k).toBeDefined();
    const look = readPageLook({});
    expect(look.width).toBe(keys.width.default);
    expect(look.background).toBe(keys.background.default);
    expect(look.bodyFont).toBe(keys.bodyFont.default);
    expect(look.headingFont).toBe(keys.headingFont.default);
    expect(look.textSize).toBe(keys.textSize.default);
    expect(look.lineHeight).toBe(keys.lineHeight.default);
    expect(look.showOutline).toBe(keys.showOutline.default);
    expect(look.cover).toBe(keys.cover.default);
    expect(look.titleStyle).toBe(keys.titleStyle.default);
    expect(look.titleAlign).toBe(keys.titleAlign.default);
    expect(look.eyebrow).toBe(keys.eyebrow.default);
    expect(look.showByline).toBe(keys.showByline.default);
    expect(look.showReadingTime).toBe(keys.showReadingTime.default);
  });
});

describe('readPageLook', () => {
  it('ignores values the contract does not have', () => {
    const look = readPageLook({ width: 'huge', background: 'pink', bodyFont: 'comic', lineHeight: 3, cover: 'x' });
    expect(look).toMatchObject({ width: 'normal', background: 'white', bodyFont: 'jakarta', cover: null });
    expect(look.lineHeightSet).toBe(false);
  });

  it('reads a cover and keeps its position within 0..100', () => {
    const look = readPageLook({ cover: { src: '/uploads/a.png', positionY: 140, height: 'l', titleOnCover: true } });
    expect(look.cover).toEqual({ src: '/uploads/a.png', positionY: 100, height: 'l', titleOnCover: true });
  });
});

describe('lookVars', () => {
  it('sets the column from the width, always the screen on a phone', () => {
    const wide = readPageLook({ width: 'wide' });
    expect(lookVars(wide)['--dp-col' as never]).toBe('880px');
    expect(lookVars(readPageLook({ width: 'narrow' }))['--dp-col' as never]).toBe('560px');
    expect(lookVars(readPageLook({ width: 'full' }))['--dp-col' as never]).toBe('100%');
    expect(lookVars(wide, 'phone')['--dp-col' as never]).toBe('100%');
    expect(isWidePage(wide)).toBe(true);
    expect(isWidePage(readPageLook({}))).toBe(false);
  });

  it('gives the palette of the background and the fonts and sizes', () => {
    const v = lookVars(
      readPageLook({ background: 'night', bodyFont: 'lora', headingFont: 'playfair', textSize: 'l', lineHeight: 1.8 }),
    ) as Record<string, string>;
    expect(v['--dp-page']).toBe('#17211A');
    expect(v['--dp-ink']).toBe('#E6EEE8');
    expect(v['--rd-c-green']).toBe('#7FCB95');
    expect(v['--rd-hl-yellow']).toBe('#5C4A12');
    expect(v['--dp-body-font']).toContain('Lora');
    expect(v['--dp-heading-font']).toContain('Playfair Display');
    expect(v['--dp-size']).toBe('16.5px');
    expect(v['--dp-lh']).toBe('1.8');
    // no line height chosen: the reader's own
    expect((lookVars(readPageLook({})) as Record<string, string>)['--dp-lh']).toBe('1.7');
  });
});

describe('helpers', () => {
  it('merges a patch as the server does: null removes a key', () => {
    expect(mergeSettings({ width: 'wide', status: 'final' }, { width: null, background: 'paper' })).toEqual({
      status: 'final',
      background: 'paper',
    });
  });

  it('folds the middle of a long path', () => {
    expect(foldCrumbs(['a', 'b'], 3)).toEqual(['a', 'b']);
    expect(foldCrumbs(['a', 'b', 'c', 'd'], 3)).toEqual(['a', null, 'c', 'd']);
    expect(foldCrumbs(['a', 'b', 'c'], 1)).toEqual(['a', null, 'c']);
  });

  it('counts reading time and contrast', () => {
    expect(readingMinutes('')).toBe(1);
    expect(readingMinutes(Array(461).fill('word').join(' '))).toBe(3);
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 0);
    expect(contrastRatio(PALETTE.white.ink, PALETTE.white.page)).toBeGreaterThan(14);
  });
});
