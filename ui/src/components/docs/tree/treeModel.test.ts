import { describe, expect, it } from 'vitest';
import type { DocsTreeNode } from '../../../types/docs';
import {
  affectedPages,
  buildRows,
  chapterNumbers,
  childrenMap,
  coverOf,
  describeTarget,
  filterCounts,
  groupByDay,
  keyboardMove,
  matchesFilters,
  NO_FILTERS,
  noMatchText,
  parseIcon,
  placeOf,
  rowStatus,
  selectionRoots,
  sortPages,
  type TreeFilters,
} from './treeModel';

const NOW = new Date('2026-11-17T12:00:00Z');

function node(id: string, over: Partial<DocsTreeNode> = {}): DocsTreeNode {
  return {
    id,
    parentId: null,
    position: 0,
    title: id,
    slug: id.toLowerCase(),
    status: 'published',
    version: 1,
    hasDraft: false,
    updatedAt: '2026-11-17T10:00:00Z',
    ...over,
  };
}

// Overview, Architecture (API, Data model, Rate limiting), Billing (draft, mine), Book (2 chapters)
const NODES: DocsTreeNode[] = [
  node('Overview', { position: 0, updatedAt: '2026-01-01T10:00:00Z' }),
  node('Architecture', { position: 1 }),
  node('API', { parentId: 'Architecture', position: 0 }),
  node('Data model', { parentId: 'Architecture', position: 1, pageStatus: 'outdated' }),
  node('Rate limiting', { parentId: 'Architecture', position: 2, suggestions: 3, updatedBy: 'An' }),
  node('Billing', { position: 2, status: 'draft', version: 0, createdBy: 'An', updatedAt: '2026-11-16T10:00:00Z' }),
  node('Book', { position: 3, book: { isBook: true, numberChapters: true } }),
  node('Ferry', { parentId: 'Book', position: 1, status: 'draft', version: 0 }),
  node('Letter', { parentId: 'Book', position: 0 }),
];
const ctx = { me: 'An', now: NOW };
const ids = (rows: { node: DocsTreeNode }[]) => rows.map((r) => r.node.id);

describe('filters', () => {
  it('combine with AND: my drafts', () => {
    const f: TreeFilters = { only: ['mine', 'drafts'], edited: 'any' };
    const kept = NODES.filter((n) => matchesFilters(n, f, ctx)).map((n) => n.id);
    expect(kept).toEqual(['Billing']);
  });

  it('show matches with their parents dimmed and open', () => {
    const rows = buildRows(NODES, {
      closed: new Set(['Architecture']),
      q: '',
      filters: { only: ['suggestions'], edited: 'any' },
      ctx,
    });
    expect(ids(rows)).toEqual(['Architecture', 'Rate limiting']);
    expect(rows[0]).toMatchObject({ dim: true, open: true });
    expect(rows[1]).toMatchObject({ dim: false });
  });

  it('combine with the title text', () => {
    const rows = buildRows(NODES, { closed: new Set(), q: 'i', filters: { only: ['drafts'], edited: 'any' }, ctx });
    expect(ids(rows).filter((id) => !rows.find((r) => r.node.id === id)!.dim)).toEqual(['Billing']);
  });

  it('may be outdated: marked, or old', () => {
    const kept = NODES.filter((n) => matchesFilters(n, { only: ['outdated'], edited: 'any' }, ctx)).map((n) => n.id);
    expect(kept).toEqual(['Overview', 'Data model']);
  });

  it('count each choice and name them when nothing matches', () => {
    expect(filterCounts(NODES, ctx)).toMatchObject({ mine: 2, drafts: 2, outdated: 2, suggestions: 1, books: 1 });
    expect(noMatchText({ only: ['mine', 'outdated'], edited: 'any' })).toBe('None of your pages may be outdated.');
    expect(noMatchText({ only: ['outdated'], edited: 'today' })).toBe(
      'None of the pages edited today may be outdated.',
    );
  });

  it('without filters the closed pages hide their children', () => {
    const rows = buildRows(NODES, { closed: new Set(['Architecture']), q: '', filters: NO_FILTERS, ctx });
    expect(ids(rows)).toEqual(['Overview', 'Architecture', 'Billing', 'Book', 'Letter', 'Ferry']);
  });
});

describe('rows', () => {
  it('number the chapters of a book in tree order', () => {
    const n = chapterNumbers(NODES);
    expect(n.get('Letter')).toBe(1);
    expect(n.get('Ferry')).toBe(2);
    expect(n.has('API')).toBe(false);
  });

  it('say draft, unpublished changes, outdated and published', () => {
    expect(rowStatus(NODES[5], NOW).key).toBe('draft');
    expect(rowStatus(node('x', { hasDraft: true }), NOW).label).toBe('Unpublished changes');
    expect(rowStatus(NODES[3], NOW).key).toBe('outdated');
    expect(rowStatus(NODES[1], NOW).key).toBe('published');
  });

  it('read the icon setting', () => {
    expect(parseIcon('🚀')).toEqual({ kind: 'emoji', value: '🚀' });
    expect(parseIcon('icon:folder')).toEqual({ kind: 'icon', name: 'folder' });
    expect(parseIcon('/uploads/a.png')).toEqual({ kind: 'image', src: '/uploads/a.png' });
    expect(parseIcon('')).toBeNull();
  });
});

describe('views', () => {
  it('sort by edit, title or tree order', () => {
    const top = NODES.filter((n) => !n.parentId);
    expect(sortPages(top, 'title').map((n) => n.id)).toEqual(['Architecture', 'Billing', 'Book', 'Overview']);
    expect(sortPages(top, 'edited')[3].id).toBe('Overview');
    expect(sortPages(top, 'tree').map((n) => n.id)).toEqual(['Overview', 'Architecture', 'Billing', 'Book']);
  });

  it('group recent edits by day', () => {
    const g = groupByDay(sortPages(NODES, 'edited'), NOW);
    expect(g.map((x) => x.label)).toEqual(['Today', 'Yesterday', 'Earlier']);
    expect(g[1].pages.map((p) => p.id)).toEqual(['Billing']);
  });
});

describe('selecting several pages', () => {
  it('children follow their parent', () => {
    const sel = new Set(['Architecture', 'Billing']);
    expect([...affectedPages(NODES, sel)].sort()).toEqual([
      'API',
      'Architecture',
      'Billing',
      'Data model',
      'Rate limiting',
    ]);
  });

  it('runs actions on the roots only, in tree order', () => {
    expect(selectionRoots(NODES, new Set(['API', 'Billing', 'Architecture']))).toEqual(['Architecture', 'Billing']);
  });
});

describe('keyboard moves', () => {
  it('move up and down among siblings', () => {
    expect(keyboardMove(NODES, 'Data model', 'up')).toEqual({
      parentId: 'Architecture',
      beforeId: 'API',
      afterId: null,
    });
    expect(keyboardMove(NODES, 'Data model', 'down')).toEqual({
      parentId: 'Architecture',
      beforeId: null,
      afterId: 'Rate limiting',
    });
    expect(keyboardMove(NODES, 'API', 'up')).toBeNull();
    expect(keyboardMove(NODES, 'Rate limiting', 'down')).toBeNull();
  });

  it('move out of the parent and into the page above', () => {
    expect(keyboardMove(NODES, 'API', 'out')).toEqual({ parentId: null, beforeId: null, afterId: 'Architecture' });
    expect(keyboardMove(NODES, 'Billing', 'in')).toEqual({
      parentId: 'Architecture',
      beforeId: null,
      afterId: 'Rate limiting',
    });
    expect(keyboardMove(NODES, 'Overview', 'in')).toBeNull();
    expect(keyboardMove(NODES, 'Overview', 'out')).toBeNull();
  });

  it('say where a page lands, and where it was', () => {
    expect(describeTarget(NODES, { parentId: 'Architecture', afterId: 'Data model', beforeId: null })).toBe(
      'Move under Architecture, after Data model',
    );
    expect(describeTarget(NODES, { parentId: 'Book', afterId: null, beforeId: null }, 'Move', 'Billing')).toBe(
      'Move under Book, as chapter 3',
    );
    expect(placeOf(NODES, 'Data model')).toEqual({ parentId: 'Architecture', afterId: 'API', beforeId: null });
    expect(placeOf(NODES, 'API')).toEqual({ parentId: 'Architecture', afterId: null, beforeId: 'Data model' });
  });
});

describe('the picture of a gallery card', () => {
  it('is the page cover, else the first cover among the pages inside it, else none', () => {
    const nodes = [
      node('Blog'),
      node('Post', { parentId: 'Blog', position: 1, cover: '/uploads/post.png' }),
      node('Draft', { parentId: 'Blog', position: 0 }),
      node('Note', { parentId: 'Draft', cover: '/uploads/note.png' }),
      node('Own', { cover: '/uploads/own.png' }),
      node('Plain'),
    ];
    const kids = childrenMap(nodes);
    expect(coverOf(nodes[4], kids)).toBe('/uploads/own.png');
    // the children in order first, then theirs
    expect(coverOf(nodes[0], kids)).toBe('/uploads/post.png');
    expect(coverOf(nodes[5], kids)).toBeNull();
  });
});
