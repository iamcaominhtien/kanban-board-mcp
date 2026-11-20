// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocsTreeNode } from '../../types/docs';
import { bookOf, chapterLabel, readingNeighbours } from './book';
import { headerPlan, HEADER_WIDE_MIN } from './headerActions';
import { readPageLook } from './pageSettings';
import { monthsBetween, outdatedOf, outdatedText } from './pageStatusRules';
import { buildPrintSheet, DEFAULT_PRINT, mountPrintSheet, pageCss } from './printPage';
import {
  applyReaderLook,
  cleanReaderPrefs,
  docsTone,
  DEFAULT_READER_PREFS,
  READER_PREFS_KEY,
  readerClass,
  readerThemeCss,
  readerVars,
  readReaderPrefs,
  writeReaderPrefs,
} from './readerPrefs';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  document.body.innerHTML = '';
  document.body.className = '';
  document.head.querySelectorAll('style[data-docs-print]').forEach((s) => s.remove());
});

describe('reader preferences', () => {
  it('stay on this device: written, read back, and cleaned of values they cannot hold', () => {
    expect(readReaderPrefs()).toEqual(DEFAULT_READER_PREFS);
    writeReaderPrefs({ size: 19, theme: 'sepia', font: 'sans', width: 'narrow', justify: true, highlights: true });
    expect(JSON.parse(localStorage.getItem(READER_PREFS_KEY)!)).toMatchObject({ size: 19, theme: 'sepia' });
    expect(readReaderPrefs()).toEqual({
      size: 19,
      theme: 'sepia',
      font: 'sans',
      width: 'narrow',
      justify: true,
      highlights: true,
    });
    expect(cleanReaderPrefs({ size: 99, theme: 'purple', font: 'comic', width: 'full', justify: 'yes' })).toEqual(
      DEFAULT_READER_PREFS,
    );
  });

  it('show highlights unless the reader turned them off (Reader 5-7, "Show highlights")', () => {
    expect(cleanReaderPrefs({}).highlights).toBe(true);
    expect(cleanReaderPrefs({ highlights: 'no' }).highlights).toBe(true);
    expect(cleanReaderPrefs({ highlights: false }).highlights).toBe(false);
  });

  it('fall back to the defaults when storage is blocked, and writing does not throw', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readReaderPrefs()).toEqual(DEFAULT_READER_PREFS);
    expect(() => writeReaderPrefs({ ...DEFAULT_READER_PREFS, theme: 'night' })).not.toThrow();
  });

  it('apply over the page: Sans swaps a serif page to sans, Serif the other way, width and size on top', () => {
    const serifPage = readPageLook({ bodyFont: 'lora', headingFont: 'playfair', width: 'wide' });
    const sans = applyReaderLook(serifPage, { ...DEFAULT_READER_PREFS, font: 'sans', width: 'narrow' });
    expect(sans.bodyFont).toBe('jakarta');
    expect(sans.headingFont).toBeNull();
    expect(sans.width).toBe('narrow');
    expect(applyReaderLook(readPageLook({}), { ...DEFAULT_READER_PREFS, font: 'serif' }).bodyFont).toBe('source-serif');
    // "Page" keeps the author's choices
    expect(applyReaderLook(serifPage, DEFAULT_READER_PREFS)).toEqual(serifPage);
    expect(readerVars({ ...DEFAULT_READER_PREFS, size: 22 })).toEqual({ '--dp-size': '22px' });
    expect(readerVars(DEFAULT_READER_PREFS)).toEqual({});
  });

  it('draw Sepia and Night as screen-only classes, so a reading theme never prints', () => {
    expect(readerClass({ ...DEFAULT_READER_PREFS, theme: 'night', justify: true })).toBe('dk-rt-night dk-justify');
    expect(readerClass(DEFAULT_READER_PREFS)).toBe('');
    const css = readerThemeCss();
    expect(css.startsWith('@media screen{')).toBe(true);
    expect(css).toContain('.dk-rt-sepia{--dp-page:#F4ECD8 !important;');
    expect(css).toContain('.dk-rt-night{--dp-page:#171D19 !important;');
    expect(css).toContain('--rd-c-green:#7FCB95 !important;');
  });
});

describe('the outdated rule', () => {
  const now = new Date('2026-11-17T12:00:00Z');
  it('marks a published page not edited for 6 months, and a review starts the clock again', () => {
    expect(monthsBetween(new Date('2026-02-17T12:00:00Z'), now)).toBe(9);
    const old = { version: 9, updatedAt: '2026-02-10T09:00:00Z', settings: {} };
    expect(outdatedOf(old, now)).toEqual({ months: 9, marked: false });
    expect(outdatedText(outdatedOf(old, now)!)).toBe(
      'This page has not been edited for 9 months, so it may be out of date. Check it before you rely on it.',
    );
    expect(outdatedOf({ ...old, updatedAt: '2026-06-01T09:00:00Z' }, now)).toBeNull();
    expect(outdatedOf({ ...old, settings: { reviewedAt: '2026-10-01T09:00:00Z' } }, now)).toBeNull();
  });

  it('follows the Outdated status whatever the age, and never notes a page that was never published', () => {
    const fresh = { version: 3, updatedAt: '2026-11-10T09:00:00Z', settings: { status: 'outdated' } };
    expect(outdatedOf(fresh, now)).toMatchObject({ marked: true });
    expect(outdatedOf({ version: 0, updatedAt: '2025-01-01T00:00:00Z', settings: {} }, now)).toBeNull();
  });
});

describe('header actions as the room shrinks', () => {
  it('keeps every action in the open from 1000 px, then moves Export and Print into More', () => {
    const wide = headerPlan(HEADER_WIDE_MIN, 'desktop');
    expect(wide).toMatchObject({ share: 'open', export: 'open', print: 'open', comments: 'open' });
    const app = headerPlan(880, 'desktop');
    expect(app).toMatchObject({ share: 'open', export: 'more', print: 'more', follow: 'icon' });
    // not measured yet: wide
    expect(headerPlan(0, 'desktop').export).toBe('open');
  });

  it('draws icons on a tablet and keeps only Edit and More on a phone', () => {
    expect(headerPlan(800, 'tablet')).toEqual({
      reader: 'icon',
      follow: 'icon',
      comments: 'icon',
      share: 'icon',
      export: 'more',
      print: 'more',
    });
    expect(Object.values(headerPlan(390, 'phone')).every((p) => p === 'more')).toBe(true);
  });
});

describe('books', () => {
  const node = (id: string, parentId: string | null, position: number, extra: Partial<DocsTreeNode> = {}) =>
    ({
      id,
      parentId,
      position,
      title: id,
      slug: id,
      status: 'published',
      version: 1,
      hasDraft: false,
      updatedAt: '',
      ...extra,
    }) as DocsTreeNode;
  const nodes = [
    node('book', null, 0, { book: { isBook: true, numberChapters: true } }),
    node('c2', 'book', 2),
    node('c1', 'book', 1),
    node('draft', 'book', 3, { status: 'draft', version: 0 }),
    node('c3', 'book', 4),
    node('post-a', null, 1),
    node('post-b', null, 2),
  ];

  it('finds a chapter’s book, its place and its neighbours, drafts left out', () => {
    const b = bookOf({ id: 'c2', parentId: 'book', title: 'c2', settings: {} }, nodes)!;
    expect(b.chapters.map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
    expect(b.index).toBe(1);
    const around = readingNeighbours({ id: 'c2', parentId: 'book' }, nodes, b);
    expect(around.prev?.id).toBe('c1');
    expect(around.next?.id).toBe('c3');
    expect(chapterLabel(around.next!, b.numberChapters)).toBe('3. c3');
  });

  it('leads any other page to the next page under the same parent', () => {
    expect(bookOf({ id: 'post-a', parentId: null, title: 'a', settings: {} }, nodes)).toBeNull();
    expect(readingNeighbours({ id: 'post-a', parentId: null }, nodes, null).next?.id).toBe('post-b');
  });
});

describe('print', () => {
  const body = () => {
    const el = document.createElement('div');
    el.innerHTML = '<p data-testid="x" id="docs-a">Hello <a href="https://example.com">site</a></p>';
    return el;
  };

  it('builds a sheet of the title, author and date, the content and a footer, with the options as data', () => {
    const sheet = buildPrintSheet(
      { ...DEFAULT_PRINT, colours: true },
      {
        title: 'Rate limiting',
        meta: 'Hoa Mai · Updated Oct 5, 2026 · v15',
        footer: 'Kanban Board · Rate limiting · Printed Nov 17, 2026',
        body: body(),
        coverSrc: '/c.png',
        vars: { '--dp-page': '#FFFFFF' },
        className: 'dk-paged dk-bg-white',
        chapter: true,
      },
    );
    expect(sheet.querySelector('.dk-print-title')?.textContent).toBe('Rate limiting');
    expect(sheet.querySelector('.dk-print-meta')?.textContent).toContain('Hoa Mai');
    expect(sheet.querySelector('.dk-print-cover')).toBeTruthy();
    expect(sheet.querySelector('.dk-print-foot')?.textContent).toContain('Printed');
    expect(sheet.dataset.colours).toBe('on');
    expect(sheet.dataset.highlights).toBe('off');
    expect(sheet.dataset.chapter).toBe('break');
    expect(sheet.style.getPropertyValue('--dp-page')).toBe('#FFFFFF');
    // a copy: no ids or test ids twice in the document
    expect(sheet.querySelector('[id], .dk-print-body [data-testid]')).toBeNull();
    const plain = buildPrintSheet(
      { ...DEFAULT_PRINT, meta: false, cover: false },
      { title: 'T', meta: 'M', footer: 'F', body: body(), coverSrc: '/c.png' },
    );
    expect(plain.querySelector('.dk-print-meta')).toBeNull();
    expect(plain.querySelector('.dk-print-cover')).toBeNull();
    expect(plain.dataset.colours).toBe('off');
  });

  it('sets paper, margins and the running footer with page numbers', () => {
    const css = pageCss(DEFAULT_PRINT, 'Kanban Board · "API"');
    expect(css).toContain('size:A4;margin:18mm;');
    expect(css).toContain('counter(page) " of " counter(pages)');
    expect(css).toContain('\\"API\\"');
    expect(pageCss({ ...DEFAULT_PRINT, headerFooter: false, paper: 'letter', margins: 'wide' }, 'x')).toBe(
      '@page{size:letter;margin:25mm;}',
    );
  });

  it('puts the sheet beside the app while printing and takes it away after', () => {
    mountPrintSheet(DEFAULT_PRINT, { title: 'T', meta: null, footer: 'F', body: body() });
    expect(document.body.classList.contains('dk-printing')).toBe(true);
    expect(document.querySelector('.dk-print-sheet')).toBeTruthy();
    expect(document.head.querySelector('style[data-docs-print]')?.textContent).toContain('@page');
    window.dispatchEvent(new Event('afterprint'));
    expect(document.body.classList.contains('dk-printing')).toBe(false);
    expect(document.querySelector('.dk-print-sheet')).toBeNull();
    expect(document.head.querySelector('style[data-docs-print]')).toBeNull();
  });
});

describe('the tone of the Docs area', () => {
  it('is the reading theme over the page, the page background otherwise, white with no page', () => {
    const look = readPageLook({ background: 'sepia' });
    expect(docsTone(null, { ...DEFAULT_READER_PREFS, theme: 'night' }).tone).toBe('white');
    expect(docsTone(look, DEFAULT_READER_PREFS)).toMatchObject({ tone: 'sepia', className: '' });
    expect(docsTone(look, { ...DEFAULT_READER_PREFS, theme: 'night' })).toMatchObject({
      tone: 'night',
      className: 'dk-rt-night',
    });
    expect((docsTone(look, DEFAULT_READER_PREFS).style as Record<string, string>)['--dp-page']).toBeTruthy();
  });
});
