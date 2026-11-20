// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { docToMarkdown } from '../../richdoc';
import type { DocsPage } from '../../types/docs';
import {
  convertLock,
  convertLockTip,
  editableDoc,
  localDraftKey,
  publishedDoc,
  readLocalDraft,
  replaceSectionRefs,
  writeLocalDraft,
} from './richPage';

afterEach(() => localStorage.clear());

const DOC = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { blockId: 'b-000001', level: 2 }, content: [{ type: 'text', text: 'Setup' }] },
    {
      type: 'paragraph',
      attrs: { blockId: 'b-000002' },
      content: [
        { type: 'text', text: 'See ' },
        { type: 'docRef', attrs: { page: 'API', section: 'Auth' } },
        { type: 'text', text: ' and ' },
        { type: 'docRef', attrs: { page: 'API', section: 'Paging' } },
      ],
    },
  ],
};

function page(over: Partial<DocsPage>): DocsPage {
  return {
    id: 'pg1',
    projectId: 'p1',
    parentId: null,
    title: 'Guide',
    slug: 'guide',
    status: 'published',
    version: 2,
    markdown: '# Old\n\nFrom **Markdown**',
    headings: [],
    path: [],
    createdBy: 'user',
    updatedBy: 'user',
    updatedAt: '',
    createdAt: '',
    hasUnpublishedChanges: false,
    draft: null,
    ...over,
  };
}

describe('local draft copy', () => {
  it('keeps {content, title, at} and reads it back', () => {
    writeLocalDraft('pg1', { content: DOC, title: 'Guide' });
    const raw = JSON.parse(localStorage.getItem(localDraftKey('pg1'))!);
    expect(Object.keys(raw).sort()).toEqual(['at', 'content', 'title']);
    const back = readLocalDraft('pg1');
    expect(back?.content).toEqual(DOC);
    expect(back?.title).toBe('Guide');
  });

  it('reads a copy written before Rich Docs ({markdown, …}) into a page with block ids', () => {
    localStorage.setItem(
      localDraftKey('pg1'),
      JSON.stringify({ markdown: '## Setup\n\nRun **it**.', title: 'Old copy', at: '2026-01-01T00:00:00Z' }),
    );
    const back = readLocalDraft('pg1')!;
    expect(back.title).toBe('Old copy');
    expect(back.at).toBe('2026-01-01T00:00:00Z');
    expect(back.content.content?.[0]).toMatchObject({ type: 'heading', attrs: { level: 2 } });
    expect(back.content.content?.every((b) => /^b-[0-9a-f]{6}$/.test(String(b.attrs?.blockId)))).toBe(true);
    expect(docToMarkdown(back.content)).toBe('## Setup\n\nRun **it**.');
  });

  it('ignores a broken copy', () => {
    localStorage.setItem(localDraftKey('pg1'), '{not json');
    expect(readLocalDraft('pg1')).toBeNull();
    localStorage.setItem(localDraftKey('pg1'), JSON.stringify({ title: 'x' }));
    expect(readLocalDraft('pg1')).toBeNull();
  });
});

describe('which text a page shows and edits', () => {
  it('uses the rich JSON when there is one and reads Markdown into a page otherwise', () => {
    expect(publishedDoc(page({ format: 'rich', content: DOC }))).toBe(DOC);
    expect(publishedDoc(page({ format: 'md', content: null }))).toBeNull();
    expect(publishedDoc(page({}))).toBeNull();
    expect(editableDoc(page({ format: 'rich', content: DOC }))).toBe(DOC);
    expect(docToMarkdown(editableDoc(page({})))).toBe('# Old\n\nFrom **Markdown**');
  });

  it('opens the draft first, rich or Markdown', () => {
    const draft = {
      title: 'Guide',
      markdown: 'Draft **text**',
      baseVersion: 2,
      saves: 1,
      updatedAt: '',
      author: 'user',
    };
    expect(editableDoc(page({ format: 'rich', content: DOC, draft: { ...draft, format: 'rich', content: DOC } }))).toBe(
      DOC,
    );
    expect(docToMarkdown(editableDoc(page({ format: 'rich', content: DOC, draft })))).toBe('Draft **text**');
  });
});

describe('conversion lock', () => {
  it('blocks editing while converting and after a failure, not otherwise', () => {
    expect(convertLock({ convertState: 'waiting' })).toBe('converting');
    expect(convertLock({ convertState: 'working' })).toBe('converting');
    expect(convertLock({ convertState: 'failed' })).toBe('failed');
    expect(convertLock({ convertState: 'done' })).toBeNull();
    expect(convertLock({ convertState: null })).toBeNull();
    expect(convertLock({})).toBeNull();
    expect(convertLockTip('converting')).toBe('Editing comes back when the conversion is done');
  });
});

describe('replaceSectionRefs', () => {
  it('points only the references to that page and section at the new section', () => {
    const next = replaceSectionRefs(DOC, { title: 'API', anchor: 'Auth' }, 'Authentication')!;
    const refs = next.content![1].content!.filter((n) => n.type === 'docRef');
    expect(refs.map((r) => r.attrs?.section)).toEqual(['Authentication', 'Paging']);
    expect(DOC.content[1].content[1].attrs.section).toBe('Auth');
    expect(replaceSectionRefs(DOC, { title: 'API', anchor: 'Nowhere' }, 'X')).toBeNull();
  });
});
