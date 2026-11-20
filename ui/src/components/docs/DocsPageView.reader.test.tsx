// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { client } from '../../api/client';
import type { DocsLayout } from '../../hooks/useDocsLayout';
import type { DocsPage } from '../../types/docs';
import { ToastProvider } from '../Toast';
import { DocsPageView, type OlderVersion, type PageAction } from './DocsPageView';
import type { ExportFormat } from './docsExport';
import { READER_PREFS_KEY } from './readerPrefs';

let width = 0;
beforeEach(() => {
  const pending = () => new Promise<never>(() => undefined);
  vi.spyOn(client, 'get').mockImplementation(pending);
  vi.spyOn(client, 'post').mockImplementation(pending);
  class IO {
    observe() {}
    disconnect() {}
    unobserve() {}
  }
  vi.stubGlobal('IntersectionObserver', IO);
  vi.stubGlobal('ResizeObserver', IO);
  width = 0;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () =>
      ({ width, height: 800, top: 0, left: 0, right: width, bottom: 800, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect,
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  document.body.className = '';
});

const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const PAGE: DocsPage = {
  id: 'p1',
  projectId: 'proj',
  parentId: null,
  title: 'Rate limiting',
  slug: 'rate-limiting',
  status: 'published',
  version: 15,
  markdown: 'Every route counts requests per token.',
  format: 'rich',
  content: { type: 'doc', content: [para('Every route counts requests per token.')] },
  settings: {},
  headings: [],
  path: [{ id: 'a', title: 'Architecture', slug: 'architecture' }],
  createdBy: 'Hoa Mai',
  updatedBy: 'Hoa Mai',
  updatedAt: new Date().toISOString(),
  createdAt: '2026-01-01T10:00:00Z',
  hasUnpublishedChanges: false,
  draft: null,
};

function show(
  layout: DocsLayout,
  page: Partial<DocsPage> = {},
  extra: { readOnly?: string | null; olderVersion?: OlderVersion | null } = {},
) {
  const onAction = vi.fn<(a: PageAction) => void>();
  const onExport = vi.fn<(f: ExportFormat | null) => void>();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <DocsPageView
          page={{ ...PAGE, ...page }}
          projectId="proj"
          projectName="Kanban Board"
          narrow={false}
          layout={layout}
          readOnly={extra.readOnly ?? null}
          olderVersion={extra.olderVersion ?? null}
          onAction={onAction}
          onExport={onExport}
          onOpenPage={() => undefined}
          onOpenTicket={() => undefined}
        />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { onAction, onExport };
}

const scroll = () => screen.getByTestId('page-column').parentElement as HTMLElement;

describe('reader settings on the page', () => {
  it('apply what this device stored, over the page settings', () => {
    localStorage.setItem(READER_PREFS_KEY, JSON.stringify({ size: 22, theme: 'night', justify: true }));
    show('desktop');
    expect(scroll().className).toContain('dk-rt-night');
    expect(scroll().className).toContain('dk-justify');
    expect(scroll().style.getPropertyValue('--dp-size')).toBe('22px');
    // the author's own colours stay on the page; the reading theme is a screen-only class over them
    expect(scroll().style.getPropertyValue('--dp-page')).toBe('#FFFFFF');
    expect(document.querySelector('style')?.textContent).toContain('@media screen{.dk-rt-sepia');
  });

  it('change the page at once from the Aa popover and are stored on this device', () => {
    show('desktop');
    fireEvent.click(screen.getByTestId('reader-button'));
    const panel = screen.getByTestId('reader-settings');
    fireEvent.click(within(panel).getByTestId('reader-theme-sepia'));
    // − and + step through 15, 17, 19 and 22 px (Reader boards, B: a slider between them)
    fireEvent.change(within(panel).getByRole('slider', { name: 'Text size in pixels' }), { target: { value: '19' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Larger text' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Sans' }));
    expect(scroll().className).toContain('dk-rt-sepia');
    expect(scroll().style.getPropertyValue('--dp-size')).toBe('22px');
    expect(JSON.parse(localStorage.getItem(READER_PREFS_KEY)!)).toMatchObject({
      theme: 'sepia',
      size: 22,
      font: 'sans',
    });
    fireEvent.click(within(panel).getByTestId('reader-reset'));
    expect(scroll().className).not.toContain('dk-rt-sepia');
  });

  it('open as a sheet from More on a phone', () => {
    show('phone');
    fireEvent.click(screen.getByTestId('page-menu'));
    fireEvent.click(screen.getByTestId('sheet-reader'));
    expect(within(screen.getByTestId('reader-sheet')).getByTestId('reader-settings')).toBeTruthy();
  });
});

describe('the page header as the room shrinks', () => {
  it('shows Export and Print in the open from 1000 px; Export lists four formats', () => {
    width = 1200;
    const { onExport } = show('desktop');
    expect(screen.getByTestId('print-button')).toBeTruthy();
    fireEvent.click(screen.getByTestId('export-button'));
    const menu = screen.getByRole('menu', { name: 'Export this page as' });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((m) => m.querySelector('b')?.textContent),
    ).toEqual(['Word', 'PDF', 'HTML', 'Markdown']);
    fireEvent.click(within(menu).getByTestId('export-docx'));
    expect(onExport).toHaveBeenCalledWith('docx');
    // More does not repeat them
    fireEvent.click(screen.getByTestId('page-menu'));
    expect(screen.queryByTestId('menu-export')).toBeNull();
    expect(screen.queryByTestId('menu-print')).toBeNull();
  });

  it('moves Export and Print into More at about 880 px', () => {
    width = 880;
    const { onExport } = show('desktop');
    expect(screen.queryByTestId('export-button')).toBeNull();
    expect(screen.queryByTestId('print-button')).toBeNull();
    expect(screen.getByTestId('share').textContent).toContain('Share');
    fireEvent.click(screen.getByTestId('page-menu'));
    expect(screen.getByTestId('menu-export').textContent).toContain('Export…');
    expect(screen.getByTestId('menu-copy-markdown')).toBeTruthy();
    fireEvent.click(screen.getByTestId('menu-export'));
    expect(onExport).toHaveBeenCalledWith(null);
    fireEvent.click(screen.getByTestId('page-menu'));
    fireEvent.click(screen.getByTestId('menu-print'));
    expect(screen.getByTestId('print-dialog')).toBeTruthy();
  });

  it('draws Share as an icon on a tablet, and puts Follow this page in More on a phone', () => {
    show('tablet');
    expect(screen.getByRole('button', { name: 'Share' }).textContent).toBe('');
    expect(screen.queryByTestId('export-button')).toBeNull();
    cleanup();
    show('phone');
    expect(screen.queryByTestId('share')).toBeNull();
    fireEvent.click(screen.getByTestId('page-menu'));
    expect(screen.getByTestId('sheet-follow').textContent).toContain('Follow this page');
    expect(screen.getByTestId('menu-print')).toBeTruthy();
  });

  it('greys Edit for a reader who cannot edit, with the reason', () => {
    show('desktop', {}, { readOnly: 'Only project members can edit pages in this space' });
    const edit = screen.getByTestId('edit-page') as HTMLButtonElement;
    expect(edit.disabled).toBe(true);
    fireEvent.mouseEnter(edit.parentElement!);
    expect(screen.getByRole('tooltip').textContent).toBe('Only project members can edit pages in this space');
  });

  it('has no outline with fewer than two headings', () => {
    show('tablet', { headings: [{ level: 2, text: 'Only', slug: 'only' }] });
    expect(screen.queryByTestId('toc-button')).toBeNull();
  });
});

describe('page status', () => {
  it('opens the version from the Published badge, with Page history', () => {
    const { onAction } = show('desktop');
    fireEvent.click(screen.getByTestId('status-badge'));
    const pop = screen.getByRole('dialog', { name: 'Version 15' });
    expect(pop.textContent).toContain('by Hoa Mai. Readers see this version.');
    fireEvent.click(within(pop).getByRole('button', { name: /Page history/ }));
    expect(onAction).toHaveBeenCalledWith('history');
  });

  it('notes a page not edited for 6 months; an editor marks it as reviewed', async () => {
    const patch = vi
      .spyOn(client, 'patch')
      .mockResolvedValue({ data: { ...PAGE, settings: { reviewedAt: '2026-11-17T00:00:00Z' } } });
    show('desktop', { updatedAt: '2025-01-10T10:00:00Z' });
    expect(screen.getByTestId('outdated-note').textContent).toContain('may be out of date');
    expect(screen.getByTestId('outdated-chip').textContent).toBe('May be outdated');
    fireEvent.click(screen.getByTestId('mark-reviewed'));
    await waitFor(() => expect(patch).toHaveBeenCalled());
    const [url, body] = patch.mock.calls[0] as [string, { settings: Record<string, unknown> }];
    expect(url).toBe('/docs/pages/p1/settings');
    expect(body.settings.status).toBeNull();
    expect(typeof body.settings.reviewedAt).toBe('string');
  });

  it('gives a reader the note without the button, and a marked page the note at any age', () => {
    show('desktop', { settings: { status: 'outdated' } }, { readOnly: 'Only project members can edit pages' });
    expect(screen.getByTestId('outdated-note').textContent).toContain('marked as outdated');
    expect(screen.queryByTestId('mark-reviewed')).toBeNull();
  });

  it('reads an older version opened from History: Edit off, a way back, Restore for editors', () => {
    const onBack = vi.fn();
    const onRestore = vi.fn();
    show(
      'desktop',
      {},
      {
        olderVersion: {
          version: 13,
          detail: {
            version: 13,
            title: 'Rate limiting',
            markdown: 'The old text.',
            format: 'md',
            content: null,
            author: 'Hoa Mai',
            note: null,
            createdAt: '2026-09-29T10:00:00Z',
          },
          onBack,
          onRestore,
        },
      },
    );
    expect(screen.getByTestId('older-chip').textContent).toBe('Older version');
    expect(screen.getByTestId('older-version-bar').textContent).toContain(
      'You are reading v13. The current page is v15',
    );
    expect((screen.getByTestId('edit-page') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Restore this version' }));
    fireEvent.click(screen.getByTestId('older-restore-yes'));
    expect(onRestore).toHaveBeenCalled();
  });
});

describe('print', () => {
  it('asks a few choices first, then prints only the page and takes the sheet away after', () => {
    width = 1200;
    const print = vi.fn();
    vi.stubGlobal('print', print);
    show('desktop');
    fireEvent.click(screen.getByTestId('print-button'));
    const dialog = screen.getByTestId('print-dialog');
    expect(within(dialog).getByRole('switch', { name: 'Include highlights' }).getAttribute('aria-checked')).toBe(
      'false',
    );
    expect(within(dialog).getByRole('switch', { name: 'Title, author and date' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    fireEvent.click(within(dialog).getByTestId('print-go'));
    expect(print).toHaveBeenCalled();
    const sheet = document.querySelector('.dk-print-sheet') as HTMLElement;
    expect(sheet.querySelector('.dk-print-title')?.textContent).toBe('Rate limiting');
    expect(sheet.querySelector('.dk-print-meta')?.textContent).toContain('Hoa Mai');
    expect(sheet.textContent).toContain('Every route counts requests per token.');
    expect(sheet.querySelector('.dk-print-foot')?.textContent).toContain('Kanban Board · Rate limiting · Printed');
    act(() => {
      window.dispatchEvent(new Event('afterprint'));
    });
    expect(document.querySelector('.dk-print-sheet')).toBeNull();
  });

  it('never prints a reading theme: the sheet carries the author’s colours', () => {
    localStorage.setItem(READER_PREFS_KEY, JSON.stringify({ theme: 'night' }));
    show('desktop', { settings: { background: 'paper' } });
    act(() => {
      window.dispatchEvent(new Event('beforeprint'));
    });
    const sheet = document.querySelector('.dk-print-sheet') as HTMLElement;
    expect(sheet.className).not.toContain('dk-rt-night');
    expect(sheet.style.getPropertyValue('--dp-page')).toBe('#FBF8F1');
    act(() => {
      window.dispatchEvent(new Event('afterprint'));
    });
  });
});
