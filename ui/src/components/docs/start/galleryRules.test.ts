// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type { DocsTreeNode } from '../../../types/docs';
import type { DocsGallery, GallerySaved } from '../../../types/docsGallery';
import {
  MAX_TEMPLATE_NAME,
  checkTitle,
  chipCounts,
  filterGallery,
  galleryItems,
  recentTemplates,
  rememberTemplate,
  templateNameState,
} from './galleryRules';

const saved = (id: string, name: string, extra: Partial<GallerySaved> = {}): GallerySaved => ({
  id,
  name,
  description: null,
  category: 'writing',
  keeps: 'content',
  scope: 'me',
  owner: 'An',
  mine: true,
  usedCount: 0,
  createdAt: '',
  updatedAt: '',
  settings: null,
  preview: '',
  ...extra,
});

const GALLERY: DocsGallery = {
  builtin: [
    {
      id: 'blank',
      name: 'Blank',
      description: 'Start from an empty page',
      category: 'work',
      settings: {},
      preview: '',
    },
    {
      id: 'requirements',
      name: 'Requirements',
      description: 'Goals, scope and criteria',
      category: 'work',
      settings: {},
      preview: '# Requirements',
    },
    { id: 'use-case', name: 'Use case', description: 'Actors and flows', category: 'ba', settings: {}, preview: '' },
    {
      id: 'blog-post',
      name: 'Blog post',
      description: 'Cover, centred title, pull quote',
      category: 'writing',
      settings: { width: 'narrow' },
      preview: '',
    },
    {
      id: 'short-story',
      name: 'Short story',
      description: 'Serif, indented',
      category: 'writing',
      settings: {},
      preview: '',
    },
  ],
  yours: [saved('t1', 'Release notes', { category: 'work' })],
  project: [saved('t2', 'Weekly status', { mine: false, owner: 'Hoa', scope: 'project', category: 'work' })],
  defaultTemplate: 'blank',
  hidden: ['short-story'],
};

describe('the gallery', () => {
  const items = galleryItems(GALLERY);

  it('puts Blank first and Canvas next, leaves hidden built-ins out and lists saved templates last', () => {
    expect(items.map((i) => i.id)).toEqual(['blank', 'canvas', 'requirements', 'use-case', 'blog-post', 't1', 't2']);
    expect(items.find((i) => i.id === 't1')?.source).toBe('yours');
    expect(items.find((i) => i.id === 't2')?.source).toBe('project');
  });

  it('filters by chip: a category, or Yours for every saved template', () => {
    expect(filterGallery(items, 'writing', '').map((i) => i.id)).toEqual(['blog-post']);
    expect(filterGallery(items, 'ba', '').map((i) => i.id)).toEqual(['use-case']);
    expect(filterGallery(items, 'yours', '').map((i) => i.id)).toEqual(['t1', 't2']);
    // saved templates are also under the category they were saved with
    expect(filterGallery(items, 'work', '').map((i) => i.id)).toEqual(['blank', 'canvas', 'requirements', 't1', 't2']);
  });

  it('searches names and descriptions, every word, ignoring case and accents', () => {
    expect(filterGallery(items, 'all', 'PULL quote').map((i) => i.id)).toEqual(['blog-post']);
    expect(filterGallery(items, 'all', 'scope goals').map((i) => i.id)).toEqual(['requirements']);
    expect(filterGallery(items, 'all', 'cÔver').map((i) => i.id)).toEqual(['blog-post']);
    expect(filterGallery(items, 'all', 'pitch deck')).toEqual([]);
    // a search inside a chip
    expect(filterGallery(items, 'work', 'status').map((i) => i.id)).toEqual(['t2']);
  });

  it('counts each chip', () => {
    expect(chipCounts(items)).toEqual({ all: 7, work: 5, writing: 1, ba: 1, yours: 2 });
  });
});

describe('the title of a new page', () => {
  const nodes = [
    { id: 'a', parentId: null, title: 'Architecture', slug: 'architecture', position: 0 },
    { id: 'b', parentId: 'a', title: 'API', slug: 'api', position: 0 },
  ] as DocsTreeNode[];

  it('is empty only once the field was touched or Create pressed', () => {
    expect(checkTitle(nodes, null, '  ', false).empty).toBe(false);
    expect(checkTitle(nodes, null, '  ', true).empty).toBe(true);
    expect(checkTitle(nodes, null, 'Notes', true).empty).toBe(false);
  });

  it('clashes with a page of the same title under the same parent, and names the address it will get', () => {
    const c = checkTitle(nodes, 'a', 'api', true);
    expect(c.clash).toBe(true);
    expect(c.nextAddress).toBe('api-2');
    expect(checkTitle(nodes, null, 'API', true).clash).toBe(false);
  });
});

describe('a template name', () => {
  it('is required and has a limit', () => {
    expect(templateNameState('')).toBe('empty');
    expect(templateNameState('   ')).toBe('empty');
    expect(templateNameState('Blog post')).toBe('ok');
    expect(templateNameState('x'.repeat(MAX_TEMPLATE_NAME))).toBe('ok');
    expect(templateNameState('x'.repeat(MAX_TEMPLATE_NAME + 1))).toBe('too_long');
  });
});

describe('recent templates', () => {
  beforeEach(() => localStorage.clear());

  it('keeps the last two, newest first, without Blank or Canvas', () => {
    rememberTemplate({ id: 'blank', name: 'Blank' });
    rememberTemplate({ id: 'blog-post', name: 'Blog post' });
    rememberTemplate({ id: 't1', name: 'Weekly status' });
    rememberTemplate({ id: 'readme', name: 'README' });
    rememberTemplate({ id: 't1', name: 'Weekly status' });
    expect(recentTemplates()).toEqual([
      { id: 't1', name: 'Weekly status' },
      { id: 'readme', name: 'README' },
    ]);
  });
});
