// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocsPage, RichDoc } from '../../../types/docs';
import type { DocsSuggestion } from './api';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock('../../../api/client', () => ({ client: http }));
vi.mock('../../diagrams/DiagramEmbed', () => ({ DiagramEmbed: () => <div data-testid="diagram" /> }));
vi.mock('../../sketch/SketchEmbed', () => ({ SketchEmbed: () => null }));
vi.mock('../../canvas/CanvasEmbed', () => ({ CanvasEmbed: () => null, CanvasChip: () => null }));

import { ToastProvider } from '../../Toast';
import { RichDocView } from '../RichDocView';
import { ReviewBar, ReviewContext, SuggestionChip, usePageSuggestions } from './index';
import type { DocsLayout } from '../../../hooks/useDocsLayout';

const p = (id: string, text: string, attrs: Record<string, unknown> = {}): RichDoc => ({
  type: 'paragraph',
  attrs: { blockId: id, ...attrs },
  content: [{ type: 'text', text }],
});
const DOC: RichDoc = {
  type: 'doc',
  content: [p('b-1', 'A short note.'), p('b-2', 'Every quarter someone exported it.'), p('b-3', 'What changed')],
};
const PAGE: DocsPage = {
  id: 'pg',
  projectId: 'proj',
  parentId: null,
  title: 'Roadmap',
  slug: 'roadmap',
  status: 'published',
  version: 14,
  markdown: '',
  format: 'rich',
  content: DOC,
  settings: {},
  headings: [],
  path: [],
  createdBy: 'Hoa Mai',
  updatedBy: 'Hoa Mai',
  updatedAt: '2026-11-17T10:00:00Z',
  createdAt: '2026-11-01T10:00:00Z',
  hasUnpublishedChanges: false,
  draft: null,
};

function sg(partial: Partial<DocsSuggestion>): DocsSuggestion {
  return {
    id: 's1',
    kind: 'replace',
    blockId: 'b-2',
    afterBlockId: null,
    after: null,
    before: null,
    author: 'Docs team',
    memberId: 'm1',
    runId: 'r1',
    note: null,
    baseVersion: 14,
    createdAt: '2026-11-17T10:00:00Z',
    stale: false,
    ...partial,
  };
}

const TEXT = sg({
  id: 's-text',
  before: p('b-2', 'Every quarter someone exported it.'),
  after: p('b-2', 'Each quarter somebody exported it.'),
});
const ALIGN = sg({
  id: 's-align',
  kind: 'attrs',
  blockId: 'b-3',
  before: p('b-3', 'What changed'),
  after: { blockId: 'b-3', textAlign: 'center' },
});
const NEW = sg({
  id: 's-new',
  kind: 'insert',
  blockId: 'b-9',
  afterBlockId: 'b-3',
  after: { type: 'pullQuote', attrs: { blockId: 'b-9' }, content: [{ type: 'text', text: 'Pages did the work.' }] },
});
const GONE = sg({ id: 's-gone', kind: 'delete', blockId: 'b-1', before: p('b-1', 'A short note.') });

let list: DocsSuggestion[] = [];

function serve() {
  http.get.mockImplementation(async (url: string) => {
    if (url.endsWith('/suggestions')) return { data: { count: list.length, suggestions: list } };
    if (url.endsWith('/work'))
      return {
        data: {
          tickets: [
            {
              id: 'KAN-154',
              title: 'Review',
              status: 'todo',
              assignee: null,
              run: {
                id: 'r1',
                memberId: 'm1',
                member: 'Docs team',
                mode: 'x',
                state: 'finished',
                doing: null,
                startedAt: null,
                endedAt: null,
              },
            },
          ],
          active: 0,
        },
      };
    throw new Error(`unexpected GET ${url}`);
  });
}

function Harness({ layout = 'desktop', canEdit = true }: { layout?: DocsLayout; canEdit?: boolean }) {
  const sgv = usePageSuggestions({ page: PAGE, projectId: 'proj', doc: DOC, enabled: true, canEdit, layout });
  return (
    <ReviewContext.Provider value={sgv.review}>
      <SuggestionChip />
      <ReviewBar />
      <RichDocView doc={DOC} projectId="proj" blockWrap={sgv.wrap} lead={sgv.lead} tail={sgv.tail} />
    </ReviewContext.Provider>
  );
}

function setup(opts: { layout?: DocsLayout; canEdit?: boolean } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <Harness {...opts} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return qc;
}

const suggestionGets = () => http.get.mock.calls.filter(([u]) => String(u).endsWith('/suggestions')).length;

beforeEach(() => {
  http.get.mockReset();
  http.post.mockReset();
  http.patch.mockReset();
  serve();
});
afterEach(() => cleanup());

describe('suggestions on the page', () => {
  it('draws each block with its label in words and Accept / Reject always there', async () => {
    list = [GONE, TEXT, ALIGN, NEW];
    setup();
    const blocks = await screen.findAllByTestId('sg-block');
    expect(blocks).toHaveLength(4);
    const labels = blocks.map((b) => within(b).getByTestId('sg-label').textContent);
    expect(labels).toEqual(['Removed block', 'Text edited', 'Format', 'New block']);
    expect(
      within(blocks[2])
        .getByText(/Alignment/)
        .closest('.sg-change')?.textContent,
    ).toBe('Alignment: left→centre');
    expect(within(blocks[3]).getByText('Pull quote')).toBeTruthy();
    // the words that changed: struck and underlined
    expect(within(blocks[1]).getAllByText(/quarter/).length).toBeGreaterThan(0);
    expect(blocks[1].querySelector('del.sg-del')?.textContent).toContain('Every');
    expect(blocks[1].querySelector('ins.sg-ins')?.textContent).toContain('Each');
    for (const b of blocks) {
      expect(within(b).getByTestId('sg-accept')).toBeTruthy();
      expect(within(b).getByTestId('sg-reject')).toBeTruthy();
    }
    expect(screen.getByTestId('sg-chip').textContent).toContain(
      'Docs team suggested 2 edits, 1 new block and 1 removed block',
    );
    expect(screen.getByTestId('sg-count').textContent).toBe('1 of 4');
  });

  it('accepts one block, refetches, and offers Undo', async () => {
    list = [TEXT, ALIGN];
    setup();
    const [first] = await screen.findAllByTestId('sg-block');
    const before = suggestionGets();
    http.post.mockImplementation(async () => {
      list = [ALIGN];
      return { data: { ...PAGE, version: 15 } };
    });
    fireEvent.click(within(first).getByTestId('sg-accept'));
    await waitFor(() =>
      expect(http.post).toHaveBeenCalledWith('/docs/pages/pg/suggestions/accept', { ids: ['s-text'] }),
    );
    await waitFor(() => expect(suggestionGets()).toBeGreaterThan(before));
    await waitFor(() => expect(screen.getAllByTestId('sg-block')).toHaveLength(1));
    expect(await screen.findByText('Accepted 1 of 2 suggestions')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() =>
      expect(http.post).toHaveBeenCalledWith('/docs/pages/pg/versions/14/restore', { note: undefined }),
    );
  });

  it('rejects one block; there is nothing to undo', async () => {
    list = [TEXT];
    setup();
    const [first] = await screen.findAllByTestId('sg-block');
    http.post.mockImplementation(async () => {
      list = [];
      return { data: { rejected: 1 } };
    });
    fireEvent.click(within(first).getByTestId('sg-reject'));
    await waitFor(() =>
      expect(http.post).toHaveBeenCalledWith('/docs/pages/pg/suggestions/reject', { ids: ['s-text'] }),
    );
    expect(
      await screen.findByText(/Rejected 1 of 1 suggestion · The page stays as it is, so there is nothing to undo/),
    ).toBeTruthy();
    // all settled: the chip goes quiet
    expect(await screen.findByTestId('sg-chip-quiet')).toBeTruthy();
    expect(screen.getByTestId('sg-settled').textContent).toContain('1 rejected');
  });

  it('a stale block: Look at it first, then Accept sends looked', async () => {
    list = [{ ...TEXT, stale: true }];
    setup();
    const [block] = await screen.findAllByTestId('sg-block');
    expect(within(block).getByTestId('sg-stale').textContent).toBe('Changed since the team wrote it');
    expect(within(block).queryByTestId('sg-accept')).toBeNull();
    expect(within(block).getByTestId('sg-stale-note')).toBeTruthy();
    fireEvent.click(within(block).getByTestId('sg-look'));
    expect(within(block).getByTestId('sg-compare').textContent).toContain('On the page now');
    http.post.mockResolvedValue({ data: { ...PAGE, version: 15 } });
    fireEvent.click(within(block).getByTestId('sg-accept'));
    await waitFor(() =>
      expect(http.post).toHaveBeenCalledWith('/docs/pages/pg/suggestions/accept', { ids: ['s-text'], looked: true }),
    );
  });

  it('a failed Accept keeps the suggestion and turns Accept into Retry', async () => {
    list = [TEXT];
    setup();
    const [block] = await screen.findAllByTestId('sg-block');
    http.post.mockRejectedValue(new Error('Network Error'));
    fireEvent.click(within(block).getByTestId('sg-accept'));
    expect((await within(block).findByTestId('sg-error')).textContent).toContain('Couldn’t accept this change');
    expect(within(block).getByTestId('sg-accept').textContent).toContain('Retry');
  });

  it('Accept all asks first, skips the stale one and says so', async () => {
    list = [TEXT, { ...ALIGN, stale: true }];
    setup();
    await screen.findAllByTestId('sg-block');
    expect(screen.getByTestId('sg-bar-stale').textContent).toBe('1 changed since the team wrote it');
    fireEvent.click(screen.getByTestId('sg-accept-all'));
    const dialog = screen.getByTestId('sg-confirm-accept');
    expect(dialog.textContent).toContain('Accept 1 of 2 suggestions?');
    expect(within(dialog).getByTestId('sg-confirm-stale').textContent).toContain('1 changed since the team wrote it');
    expect(http.post).not.toHaveBeenCalled();
    http.post.mockImplementation(async () => {
      list = [{ ...ALIGN, stale: true }];
      return { data: { accepted: 1, skippedStale: 1, page: { ...PAGE, version: 15 } } };
    });
    fireEvent.click(within(dialog).getByTestId('sg-confirm-accept-yes'));
    await waitFor(() => expect(http.post).toHaveBeenCalledWith('/docs/pages/pg/suggestions/accept-all'));
    expect(await screen.findByText('Accepted 1 of 2 suggestions')).toBeTruthy();
    expect(screen.getByText(/1 changed since the team wrote it and is still waiting/)).toBeTruthy();
  });

  it('Reject all asks first; Cancel sends nothing', async () => {
    list = [TEXT, ALIGN];
    setup();
    await screen.findAllByTestId('sg-block');
    fireEvent.click(screen.getByTestId('sg-reject-all'));
    let dialog = screen.getByTestId('sg-confirm-reject');
    expect(dialog.textContent).toContain('Reject all 2 suggestions?');
    expect(dialog.textContent).toContain('its run and Report stay on KAN-154');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('sg-confirm-reject')).toBeNull();
    expect(http.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('sg-reject-all'));
    dialog = screen.getByTestId('sg-confirm-reject');
    http.post.mockImplementation(async () => {
      list = [];
      return { data: { rejected: 2 } };
    });
    fireEvent.click(within(dialog).getByTestId('sg-confirm-reject-yes'));
    await waitFor(() => expect(http.post).toHaveBeenCalledWith('/docs/pages/pg/suggestions/reject', { ids: [] }));
  });

  it('steps through the suggestions', async () => {
    list = [TEXT, ALIGN, NEW];
    setup();
    await screen.findAllByTestId('sg-block');
    fireEvent.click(screen.getByRole('button', { name: 'Next suggestion' }));
    expect(screen.getByTestId('sg-count').textContent).toBe('2 of 3');
    fireEvent.click(screen.getByRole('button', { name: 'Previous suggestion' }));
    fireEvent.click(screen.getByRole('button', { name: 'Previous suggestion' }));
    expect(screen.getByTestId('sg-count').textContent).toBe('3 of 3');
  });

  it('a whole object has a Before / After switch', async () => {
    const embed = (html: string): RichDoc => ({
      type: 'htmlEmbed',
      attrs: { blockId: 'b-2', html, title: 'Countdown' },
    });
    list = [sg({ id: 's-embed', before: embed('<b>12</b>'), after: embed('<b>5</b>') })];
    setup();
    const [block] = await screen.findAllByTestId('sg-block');
    expect(within(block).getByTestId('sg-label').textContent).toBe('Embed replaced');
    const after = within(block).getByRole('button', { name: 'After' });
    expect(after.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(block).getByRole('button', { name: 'Before' }));
    expect(within(block).getByRole('button', { name: 'Before' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('phone: a Review chip per block opens its sheet', async () => {
    list = [TEXT, ALIGN];
    setup({ layout: 'phone' });
    const [block] = await screen.findAllByTestId('sg-block');
    expect(within(block).queryByTestId('sg-accept')).toBeNull();
    await act(async () => {
      fireEvent.click(within(block).getByTestId('sg-review'));
    });
    const sheet = await screen.findByTestId('sg-sheet');
    expect(sheet.textContent).toContain('Suggestion 1 of 2');
    expect(within(sheet).getByTestId('sg-accept')).toBeTruthy();
  });

  it('a reader who cannot edit sees the suggestions without the buttons that settle them', async () => {
    list = [TEXT];
    setup({ canEdit: false });
    await screen.findAllByTestId('sg-block');
    expect(screen.queryByTestId('sg-accept-all')).toBeNull();
    expect((screen.getByTestId('sg-accept') as HTMLButtonElement).disabled).toBe(true);
  });
});
