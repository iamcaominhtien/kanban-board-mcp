import { describe, expect, it } from 'vitest';
import type { DocsTreeNode } from '../../../types/docs';
import { moveInOrder, newBook } from './BookExport';
import {
  DEFAULT_OPTIONS,
  buildBookBody,
  buildExportBody,
  checkFileName,
  countEmbeds,
  defaultFileName,
  descendantsInOrder,
  extensionFor,
  fmtSize,
  optionDisabled,
  optionsFor,
  progressAt,
  reduceChoices,
  type ExportForm,
} from './exportModel';

const node = (id: string, parentId: string | null, position: number, over: Partial<DocsTreeNode> = {}) =>
  ({
    id,
    parentId,
    position,
    title: id.toUpperCase(),
    slug: id,
    status: 'published',
    version: 1,
    hasDraft: false,
    updatedAt: '',
    ...over,
  }) as DocsTreeNode;

const form = (over: Partial<ExportForm> = {}): ExportForm => ({
  format: 'pdf',
  scope: 'page',
  pageId: 'p1',
  unticked: [],
  draft: false,
  fileName: 'Architecture',
  nameEdited: false,
  options: { ...DEFAULT_OPTIONS },
  ...over,
});

describe('options per format', () => {
  it('sends only the options of the chosen format', () => {
    const o = { ...DEFAULT_OPTIONS, pageSize: 'letter' as const, contents: true, includeHighlights: true };
    expect(optionsFor('pdf', o)).toEqual({
      pageSize: 'letter',
      orientation: 'portrait',
      margins: 'normal',
      pageNumbers: true,
      contents: true,
      coverPage: false,
      includeHighlights: true,
    });
    expect(Object.keys(optionsFor('docx', o)).sort()).toEqual(
      ['contents', 'coverPage', 'includeHighlights', 'margins', 'orientation', 'pageNumbers', 'pageSize'].sort(),
    );
    expect(optionsFor('html', { ...o, look: 'plain', layout: 'folder' })).toEqual({
      look: 'plain',
      layout: 'folder',
      includeHighlights: true,
    });
    expect(optionsFor('md', { ...o, images: 'inline', embeds: 'placeholder' })).toEqual({
      images: 'inline',
      embeds: 'placeholder',
      includeHighlights: true,
    });
  });

  it('Fit to content turns orientation and page numbers off', () => {
    const o = { ...DEFAULT_OPTIONS, pageSize: 'fit' as const, orientation: 'landscape' as const, pageNumbers: true };
    expect(optionDisabled(o, 'orientation')).toBe(true);
    expect(optionDisabled(o, 'pageNumbers')).toBe(true);
    expect(optionDisabled({ ...o, pageSize: 'a4' }, 'orientation')).toBe(false);
    expect(optionsFor('pdf', o)).toMatchObject({ pageSize: 'fit', orientation: 'portrait', pageNumbers: false });
    expect(optionsFor('pdf', { ...o, pageSize: 'a4' })).toMatchObject({ orientation: 'landscape', pageNumbers: true });
  });

  it('highlights are off by default', () => {
    expect(optionsFor('md', DEFAULT_OPTIONS).includeHighlights).toBe(false);
  });
});

describe('file name', () => {
  it('rejects characters a file system rejects and an empty name', () => {
    expect(checkFileName('Architecture').error).toBeNull();
    expect(checkFileName('architecture overview nov 2026').error).toBeNull();
    expect(checkFileName('Architecture / draft?').error).toBe('A file name cannot contain / \\ : * ? " < > |');
    expect(checkFileName('a:b').error).not.toBeNull();
    expect(checkFileName('   ').error).toBe('Give the file a name.');
  });

  it('shortens a long name to 120 characters and says so', () => {
    const c = checkFileName('x'.repeat(130));
    expect(c.name).toHaveLength(120);
    expect(c.error).toBeNull();
    expect(c.note).toBe('Shortened to 120 characters. You can change it.');
  });

  it('starts as the page title, or the project for the whole space', () => {
    expect(defaultFileName('page', 'Architecture', 'Kanban Board')).toBe('Architecture');
    expect(defaultFileName('page', 'A/B: notes', 'Kanban Board')).toBe('A B  notes');
    expect(defaultFileName('space', 'Architecture', 'Kanban Board')).toBe('kanban-board-docs');
  });

  it('the extension is fixed by the format, and a zip for many pages', () => {
    expect(extensionFor('pdf', 'page', 1)).toBe('pdf');
    expect(extensionFor('docx', 'children', 4)).toBe('zip');
    expect(extensionFor('html', 'space', 42)).toBe('zip');
    expect(extensionFor('pdf', 'book', 6)).toBe('pdf');
    expect(extensionFor('md', 'book', 6)).toBe('zip');
  });
});

describe('the request body', () => {
  it('a page', () => {
    expect(buildExportBody(form({ draft: true }))).toEqual({
      scope: 'page',
      format: 'pdf',
      pageId: 'p1',
      draft: true,
      fileName: 'Architecture',
      options: optionsFor('pdf', DEFAULT_OPTIONS),
    });
  });

  it('a page and its children: page_ids in tree order only when some are unticked', () => {
    const all = ['p1', 'c1', 'c2', 'c3'];
    expect(buildExportBody(form({ scope: 'children' }), all).pageIds).toBeUndefined();
    const b = buildExportBody(form({ scope: 'children', unticked: ['c2'] }), all);
    expect(b.pageId).toBe('p1');
    expect(b.pageIds).toEqual(['p1', 'c1', 'c3']);
  });

  it('the whole space has no page', () => {
    const b = buildExportBody(form({ scope: 'space', fileName: 'kanban-board-docs', format: 'md' }));
    expect(b.pageId).toBeUndefined();
    expect(b).toMatchObject({ scope: 'space', format: 'md', fileName: 'kanban-board-docs' });
  });

  it('a book: the pages in order and the book settings', () => {
    const b = buildBookBody(
      ['c3', 'c1'],
      'docx',
      DEFAULT_OPTIONS,
      {
        title: 'The Harbour Lights',
        subtitle: '',
        author: 'Hoa Mai',
        date: 'November 2026',
        coverImage: '/uploads/cover.png',
        cover: true,
        titlePage: true,
        contents: false,
        chapterBreaks: true,
        numberChapters: false,
      },
      false,
    );
    expect(b).toMatchObject({ scope: 'book', format: 'docx', pageIds: ['c3', 'c1'], fileName: 'The Harbour Lights' });
    expect(b.book).toEqual({
      title: 'The Harbour Lights',
      subtitle: undefined,
      author: 'Hoa Mai',
      date: 'November 2026',
      coverImage: '/uploads/cover.png',
      cover: true,
      titlePage: true,
      contents: false,
      chapterBreaks: true,
      numberChapters: false,
    });
  });
});

describe('too big', () => {
  it('offers four ways, each changing the form', () => {
    const f = form({ scope: 'children', format: 'pdf' });
    const c = reduceChoices(f);
    expect(c.map((x) => x.id)).toEqual(['fewer', 'links', 'plain', 'markdown']);
    expect(c.every((x) => !x.disabled)).toBe(true);
    expect(c[0].apply(f).scope).toBe('page');
    expect(c[1].apply(f)).toMatchObject({ format: 'md', options: { images: 'link' } });
    expect(c[2].apply(f)).toMatchObject({ format: 'html', options: { look: 'plain' } });
    expect(c[3].apply(f).format).toBe('md');
    // what would change nothing is off
    expect(
      reduceChoices(form({ scope: 'page', format: 'md' }))
        .filter((x) => x.disabled)
        .map((x) => x.id),
    ).toEqual(['fewer', 'markdown']);
  });
});

describe('helpers', () => {
  it('counts embeds that become pictures', () => {
    expect(
      countEmbeds({
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'x' }] },
          { type: 'diagram' },
          { type: 'columns', content: [{ type: 'column', content: [{ type: 'htmlEmbed' }] }] },
        ],
      }),
    ).toBe(2);
    expect(countEmbeds(null)).toBe(0);
  });

  it('sizes and progress', () => {
    expect(fmtSize(340 * 1024)).toBe('340 KB');
    expect(fmtSize(1.2 * 1024 * 1024)).toBe('1.2 MB');
    expect(fmtSize(310 * 1024 * 1024)).toBe('310 MB');
    expect(progressAt(3, 0).step).toBe(0);
    expect(progressAt(3, 1300).step).toBe(1);
    expect(progressAt(3, 60_000).step).toBe(2);
    expect(progressAt(3, 60_000).percent).toBeLessThan(100);
  });

  it('children in tree order, and a book of them', () => {
    const nodes = [
      node('book', null, 0, { cover: '/c.png' }),
      node('b2', 'book', 1),
      node('b1', 'book', 0),
      node('b1a', 'b1', 0),
      node('other', null, 1),
    ];
    expect(descendantsInOrder(nodes, 'book').map((n) => n.id)).toEqual(['b1', 'b1a', 'b2']);
    const b = newBook(['b2', 'b1'], nodes, 'pdf', DEFAULT_OPTIONS, new Date(2026, 10, 17));
    expect(b.ids).toEqual(['b2', 'b1']);
    expect(b.settings).toMatchObject({ title: 'BOOK', coverImage: '/c.png', date: 'November 2026' });
    expect(moveInOrder(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b']);
    expect(moveInOrder(['a', 'b', 'c'], 'a', 5)).toEqual(['b', 'c', 'a']);
  });
});
