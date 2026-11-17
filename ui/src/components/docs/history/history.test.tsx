// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocsCommentThread, DocsPage, DocsVersionDetail, DocsVersionSummary, RichDoc } from '../../../types/docs';

const post = vi.fn();
const put = vi.fn();
const get = vi.fn();
vi.mock('../../../api/client', () => ({
  client: {
    post: (...a: unknown[]) => post(...a),
    put: (...a: unknown[]) => put(...a),
    get: (...a: unknown[]) => get(...a),
  },
}));

const versionData = new Map<number, DocsVersionDetail>();
vi.mock('../../../api/docs', async (orig) => {
  const real = await orig<typeof import('../../../api/docs')>();
  return {
    ...real,
    useDocsVersion: (_: string, v: number | null) =>
      v == null
        ? { data: undefined, isLoading: false, isError: false }
        : { data: versionData.get(v), isLoading: !versionData.has(v), isError: false, refetch: vi.fn() },
    useDocsDiff: () => ({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() }),
  };
});

import { CompareView } from './CompareView';
import { CopyPageDialog, RestoreDialog } from './Dialogs';
import { VersionRow } from './VersionRow';
import { orphanSentence, rowChange } from './versionInfo';

const p = (id: string, text: string, attrs: Record<string, unknown> = {}): RichDoc => ({
  type: 'paragraph',
  attrs: { blockId: id, ...attrs },
  content: [{ type: 'text', text }],
});
const doc = (...content: RichDoc[]): RichDoc => ({ type: 'doc', content });
const image: RichDoc = { type: 'image', attrs: { blockId: 'b-img', src: '/x.png', alt: 'Chart' } };

const summary = (version: number, extra: Partial<DocsVersionSummary> = {}): DocsVersionSummary => ({
  version,
  title: 'Roadmap',
  author: 'Hoa Mai',
  note: null,
  createdAt: '2026-10-29T11:05:00Z',
  words: 10,
  ...extra,
});
const detail = (
  version: number,
  content: RichDoc | null,
  extra: Partial<DocsVersionDetail> = {},
): DocsVersionDetail => ({
  version,
  title: 'Roadmap',
  markdown: 'text',
  format: content ? 'rich' : 'md',
  content,
  author: 'Hoa Mai',
  note: null,
  createdAt: '2026-10-29T11:05:00Z',
  ...extra,
});

const page = (content: RichDoc, version = 15): DocsPage =>
  ({
    id: 'pg',
    projectId: 'p1',
    parentId: 'parent',
    title: 'Why we moved our roadmap',
    slug: 'roadmap',
    status: 'published',
    version,
    markdown: '',
    format: 'rich',
    content,
    headings: [],
    path: [
      { id: 'parent', title: 'Product blog', slug: 'blog' },
      { id: 'pg', title: 'Why we moved our roadmap', slug: 'roadmap' },
    ],
    createdBy: 'Hoa Mai',
    updatedBy: 'Hoa Mai',
    updatedAt: '',
    createdAt: '',
    hasUnpublishedChanges: false,
    draft: null,
  }) as DocsPage;

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  versionData.clear();
});

describe('a version row counts the blocks it changed', () => {
  const v12 = detail(12, doc(p('b-1', 'One'), p('b-2', 'Two'), p('b-3', 'Old note')));
  const v13 = detail(13, doc(p('b-1', 'One edited'), p('b-2', 'Two', { textAlign: 'center' }), p('b-4', 'New')));

  it('against the version before it', () => {
    expect(rowChange(summary(13), v13, v12)?.text).toBe('2 blocks edited, 1 added, 1 removed');
    expect(rowChange(summary(1), v12, null)?.text).toBe('3 blocks added');
    // still loading
    expect(rowChange(summary(13), undefined, v12)).toBeNull();
    expect(rowChange(summary(13), v13, undefined)).toBeNull();
  });

  it('marks the conversion and the old Markdown versions', () => {
    const md = detail(6, null);
    const conv = detail(7, doc(p('b-1', 'A'), p('b-2', 'B')), {
      note: 'Converted from Markdown',
      author: 'Kanban Board',
    });
    expect(rowChange(summary(7, { note: 'Converted from Markdown', author: 'Kanban Board' }), conv, md)).toEqual({
      kind: 'converted',
      blocks: 2,
      text: '2 blocks',
    });
    expect(rowChange(summary(6), md, detail(5, null))?.kind).toBe('markdown');
  });

  it('shows the count, the conversion chip and the Markdown chip on the rows', () => {
    const actions = {};
    render(
      <>
        <VersionRow
          v={summary(13, { note: 'Statuses updated', withAi: true })}
          current={15}
          change={rowChange(summary(13), v13, v12)}
          previous={12}
          selected={false}
          onToggle={() => undefined}
          actions={actions}
          touch={false}
        />
        <VersionRow
          v={summary(7, { note: 'Converted from Markdown', author: 'Kanban Board' })}
          current={15}
          change={{ kind: 'converted', blocks: 14, text: '14 blocks' }}
          previous={6}
          selected={false}
          onToggle={() => undefined}
          actions={{ onView: () => undefined }}
          touch={false}
        />
        <VersionRow
          v={summary(6)}
          current={15}
          change={{ kind: 'markdown', text: 'Markdown' }}
          previous={5}
          selected={false}
          onToggle={() => undefined}
          actions={actions}
          touch={false}
        />
      </>,
    );
    expect(screen.getByTestId('version-count-13').textContent).toBe('2 blocks edited, 1 added, 1 removed');
    expect(screen.getByTestId('with-ai-13')).toBeTruthy();
    expect(screen.getByTestId('converted-7').textContent).toBe('Converted from Markdown');
    expect(screen.getByText('Same text, now in the new page format. Nothing was rewritten.')).toBeTruthy();
    expect(screen.getByText('Compare with v6')).toBeTruthy();
    expect(screen.getByTestId('markdown-6')).toBeTruthy();
    expect(screen.queryByTestId('version-count-6')).toBeNull();
  });

  it('has a menu with Open, Compare, Restore and Copy as new page', () => {
    const onCopy = vi.fn();
    render(
      <VersionRow
        v={summary(12)}
        current={15}
        change={null}
        previous={11}
        selected
        onToggle={() => undefined}
        actions={{
          onOpen: () => undefined,
          onView: () => undefined,
          onCompareCurrent: () => undefined,
          onRestore: () => undefined,
          onCopy,
        }}
        touch={false}
      />,
    );
    fireEvent.click(screen.getByTestId('version-menu-12'));
    expect(screen.getAllByRole('menuitem').map((b) => b.textContent)).toEqual([
      'Open',
      'Compare with previous',
      'Compare with current',
      'Restore as v16…',
      'Copy as new page',
    ]);
    fireEvent.click(screen.getByTestId('menu-copy'));
    expect(onCopy).toHaveBeenCalled();
  });
});

describe('restore asks first', () => {
  const current = doc(p('b-1', 'One edited'), image, p('b-4', 'New'));
  const target = detail(12, doc(p('b-1', 'One'), p('b-3', 'Old note')));
  const thread = (id: string, blockId: string, quote: string) =>
    ({
      id,
      kind: 'inline',
      status: 'open',
      number: 1,
      anchor: { quote, prefix: '', suffix: '', section: null, state: 'attached', pos: null, blockId },
      createdAt: '',
    }) as unknown as DocsCommentThread;

  it('says what it changes in blocks and what happens to comments on blocks the version lacks', () => {
    const onConfirm = vi.fn();
    wrap(
      <RestoreDialog
        projectId="p1"
        page={page(current)}
        target={summary(12, { note: 'Statuses updated' })}
        detail={target}
        threads={[thread('a', 'b-img', 'Chart'), thread('b', 'b-4', 'New'), thread('c', 'b-1', 'One')]}
        busy={false}
        error={null}
        onCancel={() => undefined}
        onConfirm={onConfirm}
      />,
    );
    expect(screen.getByTestId('hx-restore-what').textContent).toContain('Restoring creates v16.');
    const counts = screen.getByTestId('hx-restore-counts').textContent;
    expect(counts).toContain('1block changed');
    expect(counts).toContain('1added back');
    expect(counts).toContain('2removed');
    expect(screen.getByTestId('hx-restore-comments').textContent).toBe(
      'Comments stay with the page, not with a version. 2 comments are on blocks that v12 does not have. They stay in the Comments panel as orphaned threads; nothing is deleted.',
    );
    fireEvent.click(screen.getByTestId('hx-restore-confirm'));
    expect(onConfirm).toHaveBeenCalledWith('Restored from v12');
  });

  it('says nothing about orphans when no comment is affected', () => {
    expect(orphanSentence(0, 12)).toBeNull();
    expect(orphanSentence(1, 8)).toBe(
      '1 comment is on blocks that v8 does not have. They stay in the Comments panel as orphaned threads; nothing is deleted.',
    );
  });
});

describe('copy as a new page', () => {
  it('creates a page next to this one, then saves the version as its draft', async () => {
    post.mockResolvedValue({ data: { id: 'new' } });
    put.mockResolvedValue({ data: { id: 'new', title: 'Roadmap (v12)' } });
    const onCreated = vi.fn();
    const content = doc(p('b-1', 'One'));
    wrap(
      <CopyPageDialog
        projectId="p1"
        page={page(doc())}
        target={summary(12)}
        detail={detail(12, content)}
        onCancel={() => undefined}
        onCreated={onCreated}
      />,
    );
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Roadmap (v12)');
    expect(screen.getByText('Product blog')).toBeTruthy();
    fireEvent.click(screen.getByTestId('hx-copy-confirm'));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith('/projects/p1/docs/pages', { title: 'Roadmap (v12)', parentId: 'parent' });
    expect(put).toHaveBeenCalledWith(
      '/docs/pages/new/draft',
      { content, title: 'Roadmap (v12)' },
      { rawKeys: ['content'] },
    );
    expect(onCreated.mock.calls[0].slice(1)).toEqual(['Roadmap (v12)', 'Product blog']);
  });

  it('copies a Markdown version as Markdown', async () => {
    post.mockResolvedValue({ data: { id: 'new' } });
    put.mockResolvedValue({ data: { id: 'new' } });
    wrap(
      <CopyPageDialog
        projectId="p1"
        page={page(doc())}
        target={summary(5)}
        detail={detail(5, null, { markdown: '# Old' })}
        onCancel={() => undefined}
        onCreated={() => undefined}
      />,
    );
    fireEvent.click(screen.getByTestId('hx-copy-confirm'));
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(put.mock.calls[0][1]).toEqual({ markdown: '# Old', title: 'Roadmap (v5)' });
  });
});

describe('compare two versions block by block', () => {
  const versions = [summary(15), summary(14), summary(13)];
  const view = (from: number, to: number) =>
    wrap(
      <CompareView
        projectId="p1"
        page={page(doc(), 15)}
        versions={versions}
        from={from}
        to={to}
        onPair={() => undefined}
        onBack={() => undefined}
        onClose={() => undefined}
        onRestore={() => undefined}
        layout="desktop"
        keys
      />,
    );

  it('wraps each changed block with its change in words, and lists them to jump to', () => {
    versionData.set(13, detail(13, doc(p('b-1', 'The board has three columns'), p('b-2', 'Gone'))));
    versionData.set(15, detail(15, doc(p('b-1', 'The board has four columns'), p('b-3', 'Fresh'))));
    view(13, 15);
    expect(screen.getAllByTestId('hx-label').map((e) => e.textContent)).toEqual([
      'Text edited',
      'Removed block',
      'New block',
    ]);
    expect(screen.getByTestId('hx-diff').querySelector('del')?.textContent?.trim()).toBe('three');
    expect(screen.getByTestId('hx-counts').textContent).toContain('1 changed 1 added 1 removed');
    const jump = screen.getByRole('navigation', { name: 'Jump to a change' });
    expect(jump.querySelectorAll('button')).toHaveLength(3);
  });

  it('says when two versions look the same', () => {
    versionData.set(13, detail(13, doc(p('b-1', 'Same'))));
    versionData.set(14, detail(14, doc(p('b-1', 'Same'))));
    view(13, 14);
    expect(screen.getByTestId('hx-same').textContent).toContain('v13 and v14 have the same blocks.');
  });

  it('shows the loading state while a version loads', () => {
    versionData.set(13, detail(13, doc(p('b-1', 'Same'))));
    view(13, 14);
    expect(screen.getByTestId('hx-loading')).toBeTruthy();
  });

  it('falls back to the line diff around the conversion', () => {
    versionData.set(13, detail(13, null));
    versionData.set(14, detail(14, doc(p('b-1', 'Same'))));
    view(13, 14);
    expect(screen.getByTestId('hx-conversion-note').textContent).toContain('v14 is the converted page');
  });
});
