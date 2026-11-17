// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { client } from '../../api/client';
import type { DocsLayout } from '../../hooks/useDocsLayout';
import type { DocsPage } from '../../types/docs';
import { ToastProvider } from '../Toast';
import { DocsPageView, type PageAction } from './DocsPageView';

// the panels around the page ask the server; here nothing answers
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
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const PAGE: DocsPage = {
  id: 'p1',
  projectId: 'proj',
  parentId: 'p0',
  title: 'What a year of weekly releases taught us',
  slug: 'weekly-releases',
  status: 'published',
  version: 14,
  markdown:
    '## Smaller batches\n\nA monthly release carried about sixty tickets.\n\n## Fewer surprises\n\nA week is short.',
  format: 'rich',
  content: {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Smaller batches' }] },
      para('A monthly release carried about sixty tickets.'),
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Fewer surprises' }] },
      para('A week is short.'),
    ],
  },
  settings: {},
  // two headings: a page with fewer has no outline
  headings: [
    { level: 2, text: 'Smaller batches', slug: 'smaller-batches' },
    { level: 2, text: 'Fewer surprises', slug: 'fewer-surprises' },
  ],
  path: [
    { id: 'a', title: 'Handbook', slug: 'handbook' },
    { id: 'b', title: 'Engineering', slug: 'engineering' },
    { id: 'p0', title: 'Blog', slug: 'blog' },
  ],
  createdBy: 'Hoa Mai',
  updatedBy: 'Hoa Mai',
  updatedAt: '2026-11-12T10:00:00Z',
  createdAt: '2026-11-01T10:00:00Z',
  hasUnpublishedChanges: false,
  draft: null,
};

function show(layout: DocsLayout, page: Partial<DocsPage> = {}, extra: { onOpenTree?: () => void } = {}) {
  const onAction = vi.fn<(a: PageAction) => void>();
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
          onAction={onAction}
          onOpenPage={() => undefined}
          onOpenTicket={() => undefined}
          onOpenTree={extra.onOpenTree}
          onSearch={() => undefined}
        />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { onAction };
}

describe('DocsPageView on a desktop', () => {
  it('draws the page with its settings: width, background, fonts and header', () => {
    show('desktop', {
      settings: {
        width: 'narrow',
        background: 'sepia',
        bodyFont: 'lora',
        headingFont: 'playfair',
        eyebrow: 'Engineering notes',
        titleStyle: 'display',
      },
    });
    const scroll = screen.getByTestId('page-column').parentElement as HTMLElement;
    expect(scroll.dataset.pageWidth).toBe('narrow');
    expect(scroll.dataset.pageBg).toBe('sepia');
    expect(scroll.className).toContain('dk-bg-sepia');
    expect(scroll.style.getPropertyValue('--dp-col')).toBe('560px');
    expect(scroll.style.getPropertyValue('--dp-page')).toBe('#F4ECD8');
    expect(scroll.style.getPropertyValue('--rd-c-green')).toBe('#2A6A3C');
    expect(scroll.style.getPropertyValue('--dp-body-font')).toContain('Lora');
    expect(scroll.style.getPropertyValue('--dp-heading-font')).toContain('Playfair Display');
    expect(screen.getByTestId('page-eyebrow').textContent).toBe('Engineering notes');
    expect(screen.getByTestId('page-title').className).toContain('dk-ph-title-display');
    expect(screen.getByTestId('page-byline').textContent).toContain('Hoa Mai');
    expect(screen.getByTestId('reading-time').textContent).toBe('1 min read');
    // the outline sits beside the page; Edit is in the page bar
    expect(screen.getByRole('navigation', { name: 'On this page' })).toBeTruthy();
    expect(screen.getByTestId('edit-page').closest('.dk-fab')).toBeNull();
  });

  it('folds the outline to a button on a Wide page, and hides it when the page says so', () => {
    show('desktop', { settings: { width: 'wide' } });
    expect(screen.queryByRole('navigation', { name: 'On this page' })).toBeNull();
    expect(screen.getByTestId('toc-button')).toBeTruthy();
    cleanup();
    show('desktop', { settings: { showOutline: false } });
    expect(screen.queryByRole('navigation', { name: 'On this page' })).toBeNull();
    expect(screen.queryByTestId('toc-button')).toBeNull();
  });

  it('leaves the byline and the reading time out when the page says so', () => {
    show('desktop', { settings: { showReadingTime: false } });
    expect(screen.getByTestId('page-byline')).toBeTruthy();
    expect(screen.queryByTestId('reading-time')).toBeNull();
    cleanup();
    show('desktop', { settings: { showByline: false } });
    expect(screen.queryByTestId('page-byline')).toBeNull();
  });

  it('draws the cover above the title, or the title on it', () => {
    show('desktop', { settings: { cover: { src: '/uploads/c.png', positionY: 30, height: 's', titleOnCover: true } } });
    const cover = screen.getByTestId('page-cover');
    expect(cover.style.height).toBe('160px');
    expect(cover.style.backgroundPosition).toBe('center 30%');
    expect(cover.contains(screen.getByTestId('page-title'))).toBe(true);
  });
});

describe('DocsPageView on a phone', () => {
  it('floats Edit, folds the path and opens the tree, the outline and the menu as sheets', () => {
    const onOpenTree = vi.fn();
    const { onAction } = show('phone', { settings: { width: 'wide' } }, { onOpenTree });
    // the column is the screen, whatever the page width
    const scroll = screen.getByTestId('page-column').parentElement as HTMLElement;
    expect(scroll.style.getPropertyValue('--dp-col')).toBe('100%');
    // Edit floats in thumb reach; Share and Comments are not in the bar
    const edit = screen.getByTestId('edit-page');
    expect(edit.className).toBe('dk-fab');
    fireEvent.click(edit);
    expect(onAction).toHaveBeenCalledWith('edit');
    expect(screen.queryByTestId('share')).toBeNull();
    expect(screen.queryByTestId('comments-button')).toBeNull();
    // the middle of the path folds to "…"
    expect(screen.getByTestId('crumbs-fold')).toBeTruthy();
    expect(screen.queryByText('Engineering')).toBeNull();
    fireEvent.click(screen.getByTestId('open-tree'));
    expect(onOpenTree).toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('toc-button'));
    const toc = screen.getByTestId('toc-sheet');
    expect(toc.textContent).toContain('Smaller batches');

    fireEvent.click(screen.getByTestId('page-menu'));
    const sheet = screen.getByTestId('page-menu-sheet');
    expect(sheet.textContent).toContain('Share');
    fireEvent.click(screen.getByTestId('menu-settings'));
    expect(onAction).toHaveBeenCalledWith('settings');
  });
});

describe('DocsPageView on a tablet', () => {
  it('keeps Edit in the bar and the outline behind a button', () => {
    show('tablet');
    expect(screen.getByTestId('edit-page').className).toContain('st-btn');
    expect(screen.queryByRole('navigation', { name: 'On this page' })).toBeNull();
    fireEvent.click(screen.getByTestId('toc-button'));
    expect(screen.queryByTestId('toc-sheet')).toBeNull();
    expect(screen.getAllByText('Smaller batches').length).toBeGreaterThan(1);
  });
});
