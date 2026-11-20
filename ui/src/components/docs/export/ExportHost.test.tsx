// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { client } from '../../../api/client';
import type { DocsPage, DocsTreeNode } from '../../../types/docs';
import { ToastProvider } from '../../Toast';
import { openExport } from '../docsExport';
import { requestBookExport } from '../tree/useTreeActions';
import type { ExportRow } from './exportApi';
import { ExportHost } from './ExportHost';

const sse: ((data: string) => void)[] = [];
vi.mock('../../../hooks/sseEvents', () => ({
  subscribeSSE: (l: (data: string) => void) => {
    sse.push(l);
    return () => sse.splice(sse.indexOf(l), 1);
  },
}));

const node = (id: string, title: string, parentId: string | null, position: number, over: Partial<DocsTreeNode> = {}) =>
  ({
    id,
    title,
    parentId,
    position,
    slug: id,
    status: 'published',
    version: 1,
    hasDraft: false,
    updatedAt: '',
    ...over,
  }) as DocsTreeNode;

const NODES = [
  node('p1', 'Architecture', null, 0),
  node('c1', 'API', 'p1', 0),
  node('c2', 'Data model', 'p1', 1, { hasDraft: true }),
  node('c3', 'Rate limiting', 'p1', 2),
  node('o1', 'Overview', null, 1),
];

const PAGE = {
  id: 'p1',
  projectId: 'proj',
  title: 'Architecture',
  markdown: '# Architecture\n\nThe board is three services.',
  format: 'rich',
  content: {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }, { type: 'diagram' }, { type: 'sketch' }],
  },
  draft: null,
  status: 'published',
} as unknown as DocsPage;

const row = (over: Partial<ExportRow> = {}): ExportRow => ({
  id: 'e1',
  projectId: 'proj',
  pageId: 'p1',
  scope: 'page',
  format: 'pdf',
  state: 'running',
  step: 'Preparing pages',
  fileName: 'Architecture.pdf',
  size: null,
  error: null,
  createdBy: 'me',
  createdAt: new Date().toISOString(),
  finishedAt: null,
  expiresAt: null,
  download: null,
  ...over,
});

let post: ReturnType<typeof vi.fn>;
let get: ReturnType<typeof vi.fn>;
let del: ReturnType<typeof vi.fn>;
let current: ExportRow;
let history: ExportRow[];
let clicks: { href: string; download: string }[];

beforeEach(() => {
  localStorage.clear();
  current = row();
  history = [];
  clicks = [];
  post = vi.fn(async (url: string) => {
    if (url.endsWith('/cancel')) {
      current = { ...current, state: 'cancelled' };
      return { data: current };
    }
    return { data: current };
  });
  get = vi.fn(async (url: string) => {
    if (url.endsWith('/download')) return { data: new Blob(['file']) };
    if (url.endsWith('/docs/exports')) return { data: history };
    return { data: current };
  });
  del = vi.fn(async () => ({ data: { deleted: true } }));
  vi.spyOn(client, 'post').mockImplementation(post as never);
  vi.spyOn(client, 'get').mockImplementation(get as never);
  vi.spyOn(client, 'delete').mockImplementation(del as never);
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicks.push({ href: this.href, download: this.download });
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount(over: { canEdit?: boolean; page?: DocsPage } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <ExportHost
          projectId="proj"
          projectName="Kanban Board"
          nodes={NODES}
          canEdit={over.canEdit ?? true}
          layout="desktop"
          currentPage={over.page ?? PAGE}
        />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const startBody = () => post.mock.calls.find((c) => String(c[0]).endsWith('/docs/exports'));

describe('Export dialog', () => {
  it('answers the export request with the chosen format and sends its options', async () => {
    mount();
    let handled = false;
    act(() => {
      handled = openExport('p1', 'pdf');
    });
    expect(handled).toBe(true);
    const dlg = await screen.findByTestId('export-dialog');
    expect(screen.getByTestId('export-format-pdf').getAttribute('aria-pressed')).toBe('true');
    expect(dlg.textContent).toContain('Architecture · Kanban Board');
    expect(dlg.textContent).toContain('2 embeds are exported as pictures.');
    fireEvent.click(screen.getByTestId('export-pagesize-letter'));
    fireEvent.click(screen.getByTestId('export-contents'));
    fireEvent.click(screen.getByTestId('export-go'));
    await waitFor(() => expect(startBody()).toBeTruthy());
    const [url, body, cfg] = startBody()!;
    expect(url).toBe('/projects/proj/docs/exports');
    expect(body).toEqual({
      scope: 'page',
      format: 'pdf',
      pageId: 'p1',
      draft: false,
      fileName: 'Architecture',
      options: {
        pageSize: 'letter',
        orientation: 'portrait',
        margins: 'normal',
        pageNumbers: true,
        contents: true,
        coverPage: false,
        includeHighlights: false,
      },
    });
    expect(cfg).toEqual({ rawKeys: ['options', 'book'] });
  });

  it('Fit to content greys orientation and page numbers', async () => {
    mount();
    act(() => void openExport('p1', 'docx'));
    await screen.findByTestId('export-dialog');
    fireEvent.click(screen.getByTestId('export-pagesize-fit'));
    expect((screen.getByTestId('export-orientation-landscape') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('export-pagenumbers') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('export-pagenumbers').getAttribute('aria-checked')).toBe('false');
  });

  it('shows each format’s own options', async () => {
    mount();
    act(() => void openExport('p1', 'html'));
    await screen.findByTestId('export-dialog');
    expect(screen.getByTestId('export-look')).toBeTruthy();
    expect(screen.queryByTestId('export-pagesize')).toBeNull();
    fireEvent.click(screen.getByTestId('export-format-md'));
    expect(screen.getByTestId('export-images')).toBeTruthy();
    expect(screen.getByTestId('export-embeds')).toBeTruthy();
    // the embeds note is for PDF and Word only
    expect(screen.queryByTestId('export-embeds-note')).toBeNull();
    fireEvent.click(screen.getByTestId('export-embeds-placeholder'));
    fireEvent.click(screen.getByTestId('export-highlights'));
    fireEvent.click(screen.getByTestId('export-go'));
    await waitFor(() => expect(startBody()).toBeTruthy());
    expect(startBody()![1].options).toEqual({ images: 'folder', embeds: 'placeholder', includeHighlights: true });
  });

  it('checks the file name as you type; the extension is fixed', async () => {
    mount();
    act(() => void openExport('p1', 'pdf'));
    await screen.findByTestId('export-dialog');
    const input = screen.getByTestId('export-file-name') as HTMLInputElement;
    expect(input.value).toBe('Architecture');
    expect(input.parentElement!.textContent).toContain('.pdf');
    fireEvent.change(input, { target: { value: 'Architecture / draft?' } });
    expect(screen.getByRole('alert').textContent).toContain('cannot contain');
    expect((screen.getByTestId('export-go') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'architecture-overview' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByTestId('export-go') as HTMLButtonElement).disabled).toBe(false);
  });

  it('children with one unticked sends the pages in order; editors pick their draft', async () => {
    mount();
    act(() => void openExport('p1', 'docx'));
    await screen.findByTestId('export-dialog');
    fireEvent.click(screen.getByTestId('export-scope-children'));
    const ticks = within(screen.getByTestId('export-ticks')).getAllByRole('checkbox');
    expect(ticks).toHaveLength(4);
    fireEvent.click(ticks[2]); // Data model
    expect(screen.getByTestId('export-scope-children').textContent).toContain('3 of 4 pages');
    expect(screen.getByTestId('export-file-name').parentElement!.textContent).toContain('.zip');
    fireEvent.click(screen.getByTestId('export-version-draft'));
    fireEvent.click(screen.getByTestId('export-go'));
    await waitFor(() => expect(startBody()).toBeTruthy());
    expect(startBody()![1]).toMatchObject({
      scope: 'children',
      pageId: 'p1',
      pageIds: ['p1', 'c1', 'c3'],
      draft: true,
      format: 'docx',
    });
  });

  it('the whole space starts in the background and leaves a card', async () => {
    current = row({ scope: 'space', fileName: 'kanban-board-docs.zip' });
    mount();
    act(() => void openExport('p1', 'md'));
    await screen.findByTestId('export-dialog');
    fireEvent.click(screen.getByTestId('export-scope-space'));
    expect(screen.getByTestId('export-background-note')).toBeTruthy();
    expect((screen.getByTestId('export-file-name') as HTMLInputElement).value).toBe('kanban-board-docs');
    fireEvent.click(screen.getByRole('button', { name: 'Start export' }));
    await waitFor(() => expect(screen.queryByTestId('export-dialog')).toBeNull());
    expect(startBody()![1]).toMatchObject({ scope: 'space', fileName: 'kanban-board-docs' });
    expect(startBody()![1].pageId).toBeUndefined();
    const card = screen.getByTestId('export-card');
    expect(card.textContent).toContain('Exporting Kanban Board docs');
    // ready: the card turns into Download
    current = { ...current, state: 'ready', size: 18 * 1024 * 1024, download: '/docs/exports/e1/download' };
    act(() => sse.forEach((l) => l(JSON.stringify({ type: 'docs_export', id: 'e1' }))));
    await screen.findByTestId('export-card-download');
    expect(screen.getByTestId('export-card').textContent).toContain('kanban-board-docs.zip · 18 MB');
    expect(clicks).toHaveLength(0); // the card waits for Download
    fireEvent.click(screen.getByTestId('export-card-download'));
    await waitFor(() => expect(clicks).toEqual([{ href: 'blob:x', download: 'kanban-board-docs.zip' }]));
  });

  it('a whole-space export already running is said in the dialog', async () => {
    post.mockImplementationOnce(async () => {
      throw { response: { status: 409, data: { detail: { code: 'export_running', message: 'One at a time.' } } } };
    });
    mount();
    act(() => void openExport('p1', 'pdf'));
    await screen.findByTestId('export-dialog');
    fireEvent.click(screen.getByTestId('export-scope-space'));
    fireEvent.click(screen.getByTestId('export-go'));
    expect((await screen.findByTestId('export-blocked')).textContent).toContain('already running');
  });

  it('an empty page greys Export with a line', async () => {
    mount({ page: { ...PAGE, markdown: '  ', content: { type: 'doc', content: [] } } as DocsPage });
    act(() => void openExport('p1', 'pdf'));
    await screen.findByTestId('export-dialog');
    expect(screen.getByTestId('export-blocked').textContent).toContain('This page is empty');
    expect((screen.getByTestId('export-go') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('Progress and endings', () => {
  it('counts up while it runs, then downloads by itself when the server says it is ready', async () => {
    mount();
    act(() => void openExport('p1', 'pdf'));
    await screen.findByTestId('export-dialog');
    fireEvent.click(screen.getByTestId('export-go'));
    const progress = await screen.findByTestId('export-progress');
    expect(progress.textContent).toContain('Architecture.pdf');
    expect(progress.textContent).toContain('Building the PDF');
    current = { ...current, state: 'ready', size: 1258291, download: '/docs/exports/e1/download' };
    act(() => sse.forEach((l) => l(JSON.stringify({ type: 'docs_export', id: 'e1' }))));
    const ready = await screen.findByTestId('export-ready');
    expect(ready.textContent).toContain('Your PDF is ready');
    expect(ready.textContent).toContain('1.2 MB');
    await waitFor(() => expect(clicks).toEqual([{ href: 'blob:x', download: 'Architecture.pdf' }]));
    expect(get).toHaveBeenCalledWith('/docs/exports/e1/download', { responseType: 'blob', keepKeys: true });
    expect(screen.getByTestId('export-open')).toBeTruthy();
  });

  it('polls a running export', async () => {
    mount();
    act(() => void openExport('p1', 'md'));
    await screen.findByTestId('export-dialog');
    fireEvent.click(screen.getByTestId('export-go'));
    await screen.findByTestId('export-progress');
    current = { ...current, format: 'md', fileName: 'Architecture.md', state: 'ready', size: 900, download: '/d' };
    await screen.findByTestId('export-ready', undefined, { timeout: 4000 });
    expect(get).toHaveBeenCalledWith('/docs/exports/e1');
    expect(screen.queryByTestId('export-open')).toBeNull(); // Markdown has Download and Copy link
  });

  it('Cancel export stops it and says so', async () => {
    mount();
    act(() => void openExport('p1', 'pdf'));
    await screen.findByTestId('export-dialog');
    fireEvent.click(screen.getByTestId('export-go'));
    await screen.findByTestId('export-progress');
    fireEvent.click(screen.getByTestId('export-cancel'));
    await screen.findByTestId('export-cancelled');
    expect(post).toHaveBeenCalledWith('/docs/exports/e1/cancel');
  });

  it('Keep working closes the dialog and leaves a card that can be stopped', async () => {
    mount();
    act(() => void openExport('p1', 'pdf'));
    await screen.findByTestId('export-dialog');
    fireEvent.click(screen.getByTestId('export-go'));
    await screen.findByTestId('export-progress');
    fireEvent.click(screen.getByTestId('export-keep-working'));
    expect(screen.queryByTestId('export-dialog')).toBeNull();
    fireEvent.click(screen.getByTestId('export-card-stop'));
    await waitFor(() => expect(screen.queryByTestId('export-card')).toBeNull());
    expect(post).toHaveBeenCalledWith('/docs/exports/e1/cancel');
  });

  it('a failure says where it stopped and offers Export again', async () => {
    mount();
    act(() => void openExport('p1', 'pdf'));
    await screen.findByTestId('export-dialog');
    fireEvent.click(screen.getByTestId('export-go'));
    await screen.findByTestId('export-progress');
    current = { ...current, state: 'failed', step: 'Drawing pictures', error: 'A diagram timed out' };
    act(() => sse.forEach((l) => l(JSON.stringify({ type: 'docs_export', id: 'e1' }))));
    const failed = await screen.findByTestId('export-failed');
    expect(failed.textContent).toContain('It stopped while drawing pictures.');
    expect(failed.textContent).toContain('A diagram timed out');
    current = row({ id: 'e2' });
    fireEvent.click(screen.getByTestId('export-retry'));
    await waitFor(() => expect(post.mock.calls.filter((c) => String(c[0]).endsWith('/docs/exports'))).toHaveLength(2));
  });

  it('too big shows the size, the limit and four ways to make it smaller', async () => {
    post.mockImplementationOnce(async () => {
      throw {
        response: {
          status: 413,
          data: {
            detail: { code: 'export_too_big', message: 'Too big', size: 310 * 1024 * 1024, limit: 200 * 1024 * 1024 },
          },
        },
      };
    });
    mount();
    act(() => void openExport('p1', 'pdf'));
    await screen.findByTestId('export-dialog');
    fireEvent.click(screen.getByTestId('export-scope-children'));
    fireEvent.click(screen.getByTestId('export-go'));
    const big = await screen.findByTestId('export-too-big');
    expect(screen.getByTestId('export-size').textContent).toBe('310 MB');
    expect(screen.getByTestId('export-limit').textContent).toBe('200 MB');
    expect(big.querySelectorAll('[role="radio"]')).toHaveLength(4);
    fireEvent.click(screen.getByTestId('export-reduce-markdown'));
    fireEvent.click(screen.getByTestId('export-smaller'));
    await waitFor(() => expect(post.mock.calls.filter((c) => String(c[0]).endsWith('/docs/exports'))).toHaveLength(2));
    expect(post.mock.calls[1][1]).toMatchObject({ scope: 'children', format: 'md', options: { images: 'folder' } });
  });
});

describe('History', () => {
  it('lists ready, running, did not finish and expired exports with the action that fits', async () => {
    history = [
      row({ id: 'h1', state: 'ready', size: 1258291, download: '/docs/exports/h1/download' }),
      row({ id: 'h2', state: 'running', scope: 'space', fileName: 'kanban-board-docs.zip' }),
      row({ id: 'h3', state: 'failed', fileName: 'Rate limiting.html', format: 'html', error: 'A diagram timed out.' }),
      row({ id: 'h4', state: 'expired', fileName: 'Why.zip', format: 'md' }),
    ];
    mount();
    act(() => void openExport('p1', 'pdf'));
    await screen.findByTestId('export-dialog');
    fireEvent.click(screen.getByTestId('export-tab-history'));
    const rows = await screen.findAllByTestId('export-row');
    expect(rows.map((r) => r.getAttribute('data-state'))).toEqual(['ready', 'running', 'failed', 'expired']);
    expect(within(rows[0]).getByTestId('export-row-download-btn')).toBeTruthy();
    expect(within(rows[1]).getByTestId('export-row-stop')).toBeTruthy();
    expect(rows[2].textContent).toContain('Did not finish');
    expect(rows[3].textContent).toContain('Expired');
    // Download from the row
    fireEvent.click(within(rows[0]).getByTestId('export-row-download-btn'));
    await waitFor(() => expect(clicks).toHaveLength(1));
    // the row menu: Delete the file
    fireEvent.click(within(rows[0]).getByTestId('export-row-more'));
    expect(within(rows[0]).getByTestId('export-row-copy')).toBeTruthy();
    expect(within(rows[0]).getByTestId('export-row-again')).toBeTruthy();
    fireEvent.click(within(rows[0]).getByTestId('export-row-remove'));
    await waitFor(() => expect(del).toHaveBeenCalledWith('/docs/exports/h1'));
    // Stop a running one
    fireEvent.click(within(rows[1]).getByTestId('export-row-stop'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/docs/exports/h2/cancel'));
  });

  it('Export again sends the same request when this device started it', async () => {
    mount();
    act(() => void openExport('p1', 'html'));
    await screen.findByTestId('export-dialog');
    fireEvent.click(screen.getByTestId('export-go'));
    await screen.findByTestId('export-progress');
    const first = startBody()![1];
    history = [row({ state: 'expired', format: 'html' })];
    current = row({ id: 'e9', format: 'html' });
    fireEvent.click(screen.getByTestId('export-keep-working'));
    act(() => void openExport('p1', 'html'));
    fireEvent.click(await screen.findByTestId('export-tab-history'));
    fireEvent.click(await screen.findByTestId('export-row-again-btn'));
    await waitFor(() => expect(post.mock.calls.filter((c) => String(c[0]).endsWith('/docs/exports'))).toHaveLength(2));
    expect(post.mock.calls.filter((c) => String(c[0]).endsWith('/docs/exports'))[1][1]).toEqual(first);
  });

  it('has an empty state', async () => {
    mount();
    act(() => void openExport('p1', 'pdf'));
    await screen.findByTestId('export-dialog');
    fireEvent.click(screen.getByTestId('export-tab-history'));
    expect((await screen.findByTestId('export-history-empty')).textContent).toContain('No exports yet');
  });
});

describe('Book mode', () => {
  it('opens from the tree’s selection, reorders and sends the pages in order with the book', async () => {
    current = row({ scope: 'book', fileName: 'Architecture.docx' });
    mount();
    act(() => requestBookExport(['c1', 'c2', 'c3']));
    await screen.findByTestId('book-columns');
    const order = () => screen.getAllByTestId('book-order-row').map((r) => r.textContent);
    expect(order()[0]).toContain('API');
    // Move "Rate limiting" up with Alt + ↑, then "API" down with its menu
    const handles = screen.getAllByRole('button', { name: /^Move .* position/ });
    fireEvent.keyDown(handles[2], { key: 'ArrowUp', altKey: true });
    expect(order().map((t) => t?.replace(/\d|NEW PAGE/g, '').trim())).toEqual(['API', 'Rate limiting', 'Data model']);
    expect(screen.getByTestId('book-said').textContent).toContain('Moved Rate limiting to position 2 of 3');
    fireEvent.click(screen.getByRole('button', { name: 'More for API' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move down' }));
    expect(order().map((t) => t?.replace(/\d|NEW PAGE/g, '').trim())).toEqual(['Rate limiting', 'API', 'Data model']);
    // the book's settings
    expect((screen.getByTestId('book-title') as HTMLInputElement).value).toBe('Architecture');
    fireEvent.change(screen.getByTestId('book-subtitle'), { target: { value: 'Three services' } });
    fireEvent.click(screen.getByTestId('book-contents'));
    fireEvent.click(screen.getByTestId('book-format-docx'));
    fireEvent.click(screen.getByTestId('book-export'));
    await waitFor(() => expect(startBody()).toBeTruthy());
    const body = startBody()![1];
    expect(body).toMatchObject({
      scope: 'book',
      format: 'docx',
      pageIds: ['c3', 'c1', 'c2'],
      fileName: 'Architecture',
      draft: false,
    });
    expect(body.book).toMatchObject({
      title: 'Architecture',
      subtitle: 'Three services',
      cover: true,
      titlePage: true,
      contents: false,
      chapterBreaks: true,
      numberChapters: true,
    });
    await screen.findByTestId('export-progress');
  });

  it('opens from the dialog’s “Combine pages into one document…” with the page and its children', async () => {
    mount();
    act(() => void openExport('p1', 'pdf'));
    await screen.findByTestId('export-dialog');
    fireEvent.click(screen.getByTestId('export-combine'));
    await screen.findByTestId('book-columns');
    expect(screen.getAllByTestId('book-order-row')).toHaveLength(4);
    // unticking a page in the list takes it out of the order
    const list = screen.getByTestId('book-pages');
    fireEvent.click(within(list).getByRole('checkbox', { name: /API/ }));
    expect(screen.getAllByTestId('book-order-row')).toHaveLength(3);
  });
});
