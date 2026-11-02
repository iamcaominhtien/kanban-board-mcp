import { describe, expect, it } from 'vitest';
import { internalPageLink, linkifyDocs, pageRefKey, parseDocRef, REF_SCHEME } from './docsMarkdown';

describe('internalPageLink', () => {
  it('reads the page and section of a link that stays inside the space', () => {
    expect(internalPageLink('tổng-quan')).toEqual({ title: 'tổng-quan', anchor: null });
    expect(internalPageLink('/docs/spec#fields')).toEqual({ title: 'spec', anchor: 'fields' });
    expect(internalPageLink('./api.md')).toEqual({ title: 'api', anchor: null });
    expect(internalPageLink('../T%E1%BB%95ng%20quan.md#M%E1%BB%A5c')).toEqual({ title: 'Tổng quan', anchor: 'Mục' });
  });

  it('leaves web links, other schemes, sections and uploads alone', () => {
    for (const href of [
      'https://example.com/a',
      'mailto:a@b.c',
      'docref:API%23',
      'diagram:dg_1',
      '#fields',
      '//cdn.example.com/x',
      '/uploads/a.xlsx',
      '',
    ]) {
      expect(internalPageLink(href), href).toBeNull();
    }
  });
});

describe('linkifyDocs with page links', () => {
  it('turns a Markdown link to a page into a page reference resolved by slug', () => {
    const { markdown, refs } = linkifyDocs('See [Overview](tong-quan) and [[API]].', { pageLinks: true });
    expect(refs).toEqual([
      { kind: 'page', title: 'tong-quan', anchor: null, bySlug: true },
      { kind: 'page', title: 'API', anchor: null },
    ]);
    const href = markdown.match(/\[Overview\]\(([^)]+)\)/)?.[1] ?? '';
    expect(href.startsWith(REF_SCHEME)).toBe(true);
    const ref = parseDocRef(href);
    expect(ref).toEqual({ title: 'tong-quan', anchor: null, bySlug: true });
    expect(pageRefKey(ref!)).toBe(pageRefKey(refs[0] as { title: string; bySlug: boolean }));
  });

  it('keeps web links, images and code as written', () => {
    const md = 'A [site](https://x.dev), ![shot](shot.png) and `[x](y)`.';
    expect(linkifyDocs(md, { pageLinks: true })).toEqual({ markdown: md, refs: [] });
  });

  it('leaves Markdown links alone without the option (tickets, comments)', () => {
    const md = 'See [Overview](tong-quan).';
    expect(linkifyDocs(md).markdown).toBe(md);
  });

  it('a [[Title]] reference parses as before', () => {
    const { markdown } = linkifyDocs('[[Data model#Fields]]');
    const href = markdown.match(/\]\(([^)]+)\)/)?.[1] ?? '';
    expect(parseDocRef(href)).toEqual({ title: 'Data model', anchor: 'Fields', bySlug: false });
  });
});
