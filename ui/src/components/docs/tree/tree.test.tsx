// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ComponentProps, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocsPage, DocsTreeNode } from '../../../types/docs';
import { ToastProvider } from '../../Toast';
import { DocsTree } from '../DocsTree';
import { PageMenu } from '../PageMenu';
import { IconPicker } from './IconPicker';
import { GalleryView, RecentView } from './PageViews';
import { NO_FILTERS, type TreeFilters } from './treeModel';

const NOW = new Date();
const today = NOW.toISOString();
const old = new Date(NOW.getTime() - 400 * 86_400_000).toISOString();

function node(id: string, over: Partial<DocsTreeNode> = {}): DocsTreeNode {
  return {
    id,
    parentId: null,
    position: 0,
    title: id,
    slug: id.toLowerCase().replace(/\s+/g, '-'),
    status: 'published',
    version: 2,
    hasDraft: false,
    updatedAt: today,
    ...over,
  };
}

const NODES: DocsTreeNode[] = [
  node('Overview', { position: 0, updatedAt: old }),
  node('Architecture', { position: 1, icon: '🧱' }),
  node('API', { parentId: 'Architecture', position: 0 }),
  node('Data model', { parentId: 'Architecture', position: 1 }),
  node('Rate limiting', { parentId: 'Architecture', position: 2 }),
  node('Billing', { position: 2, status: 'draft', version: 0 }),
  node('Book', { position: 3, book: { isBook: true, numberChapters: true } }),
  node('Letter', { parentId: 'Book', position: 0 }),
  node('Ferry', { parentId: 'Book', position: 1 }),
];

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
}

function renderTree(over: Partial<ComponentProps<typeof DocsTree>> = {}) {
  const props: ComponentProps<typeof DocsTree> = {
    projectId: 'p1',
    projectName: 'Kanban Board',
    nodes: NODES,
    selectedId: null,
    onSelect: vi.fn(),
    onNewPage: vi.fn(),
    onRequestRename: vi.fn(),
    renamingId: null,
    onRenamingChange: vi.fn(),
    onMove: vi.fn(() => Promise.resolve()),
    onCollapse: vi.fn(),
    renderMenu: () => null,
    onViewChange: vi.fn(),
    onSortChange: vi.fn(),
    onFiltersChange: vi.fn(),
    onBulk: vi.fn(),
    ...over,
  };
  wrap(<DocsTree {...props} />);
  return props;
}

const row = (slug: string) => screen.getByTestId(`tree-row-${slug}`);
const shownRows = () => screen.queryAllByRole('treeitem').map((r) => r.getAttribute('data-page-id'));

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the tree rows', () => {
  it('show the page icon, the status and a book’s numbered chapters', () => {
    renderTree();
    expect(row('architecture').textContent).toContain('🧱');
    expect(row('billing').getAttribute('data-status')).toBe('draft');
    expect(row('overview').getAttribute('data-status')).toBe('outdated');
    expect(row('letter').textContent).toContain('1. Letter');
    expect(row('ferry').textContent).toContain('2. Ferry');
    expect(row('book').textContent).toContain('Book');
  });
});

describe('filters', () => {
  it('keep the matching pages with their parents dimmed and open', () => {
    renderTree({ filters: { only: ['drafts'], edited: 'any' } });
    expect(shownRows()).toEqual(['Billing']);
  });

  it('combine (AND): drafts that may be outdated match nothing, and the state names them', () => {
    const f: TreeFilters = { only: ['drafts', 'outdated'], edited: 'any' };
    renderTree({ filters: f });
    expect(shownRows()).toEqual([]);
    expect(screen.getByTestId('tree-no-match').textContent).toContain(
      'None of the pages are drafts and may be outdated.',
    );
  });

  it('show a matching child under its dimmed parent', () => {
    renderTree({
      nodes: NODES.map((n) => (n.id === 'API' ? { ...n, pageStatus: 'outdated' } : n)),
      filters: { only: ['outdated'], edited: 'any' },
    });
    expect(shownRows()).toEqual(['Overview', 'Architecture', 'API']);
    expect(row('architecture').style.opacity).toBe('0.6');
    expect(row('api').style.opacity).toBe('');
  });

  it('are chosen in the filter panel', () => {
    const p = renderTree();
    fireEvent.click(screen.getByTestId('tree-filter'));
    fireEvent.click(screen.getByTestId('tree-filter-drafts'));
    expect(p.onFiltersChange).toHaveBeenCalledWith({ only: ['drafts'], edited: 'any' });
  });
});

describe('view switching', () => {
  it('switches between Tree, Gallery and Recent from the header', () => {
    const p = renderTree();
    fireEvent.click(screen.getByTestId('tree-view-menu'));
    fireEvent.click(screen.getByTestId('tree-view-gallery'));
    expect(p.onViewChange).toHaveBeenCalledWith('gallery');
  });

  it('the gallery opens a page with children as a folder and numbers a book’s chapters', () => {
    const onOpen = vi.fn();
    const props = {
      nodes: NODES,
      layout: 'desktop' as const,
      filters: NO_FILTERS,
      onFiltersChange: vi.fn(),
      ctx: { me: '', now: NOW },
      sort: 'tree' as const,
      onSortChange: vi.fn(),
      onOpen,
    };
    wrap(<GalleryView {...props} />);
    fireEvent.click(
      within(screen.getByTestId('gallery-card-architecture')).getByRole('button', { name: 'Architecture' }),
    );
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.getByText('3 pages inside')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'All pages' }));
    fireEvent.click(within(screen.getByTestId('gallery-card-book')).getByRole('button', { name: 'Book' }));
    expect(screen.getByRole('button', { name: '1. Letter' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '2. Ferry' }));
    expect(onOpen).toHaveBeenCalledWith('Ferry');
  });

  it('the recent list groups the newest edits by day', () => {
    wrap(
      <RecentView
        nodes={NODES}
        layout="desktop"
        filters={NO_FILTERS}
        onFiltersChange={vi.fn()}
        ctx={{ me: '', now: NOW }}
        sort="edited"
        onSortChange={vi.fn()}
        onOpen={vi.fn()}
      />,
    );
    const groups = screen.getAllByRole('group').map((g) => g.getAttribute('aria-label'));
    expect(groups).toContain('Today');
    expect(groups).toContain('Earlier');
  });
});

describe('several pages', () => {
  it('a picked parent brings its children; the bar counts them and runs on the parent', () => {
    const p = renderTree();
    fireEvent.click(row('architecture'), { ctrlKey: true });
    const kid = screen.getByTestId('tree-check-api');
    expect(kid.getAttribute('aria-checked')).toBe('true');
    expect(kid.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByTestId('tree-selection-bar').textContent).toContain('1 selected · 4 pages');
    // a click on a child that follows its parent changes nothing
    fireEvent.click(row('api'));
    expect(screen.getByTestId('tree-selection-bar').textContent).toContain('1 selected · 4 pages');
    fireEvent.click(row('billing'));
    expect(screen.getByTestId('tree-selection-bar').textContent).toContain('2 selected · 5 pages');
    fireEvent.click(screen.getByTestId('bulk-delete'));
    expect(p.onBulk).toHaveBeenCalledWith('delete', ['Architecture', 'Billing']);
    fireEvent.click(screen.getByTestId('bulk-export'));
    expect(p.onBulk).toHaveBeenCalledWith('export', ['Architecture', 'Billing']);
    expect(p.onSelect).not.toHaveBeenCalled();
  });
});

describe('moving with the keyboard', () => {
  it('Alt+Shift+↑ moves a page up among its siblings and says so', async () => {
    const p = renderTree();
    await act(async () => {
      fireEvent.keyDown(row('data-model'), { key: 'ArrowUp', altKey: true, shiftKey: true });
    });
    expect(p.onMove).toHaveBeenCalledWith('Data model', 'Architecture', 'API', null);
    expect(screen.getByTestId('tree-announce').textContent).toBe('Moving Data model under Architecture, before API');
  });

  it('Alt+Shift+→ moves it into the page above, Alt+Shift+← out of its parent', async () => {
    const p = renderTree();
    await act(async () => {
      fireEvent.keyDown(row('billing'), { key: 'ArrowRight', altKey: true, shiftKey: true });
    });
    expect(p.onMove).toHaveBeenCalledWith('Billing', 'Architecture', null, 'Rate limiting');
    await act(async () => {
      fireEvent.keyDown(row('api'), { key: 'ArrowLeft', altKey: true, shiftKey: true });
    });
    expect(p.onMove).toHaveBeenCalledWith('API', null, null, 'Architecture');
  });

  it('says when a page can’t go that way', async () => {
    const p = renderTree();
    await act(async () => {
      fireEvent.keyDown(row('overview'), { key: 'ArrowUp', altKey: true, shiftKey: true });
    });
    expect(p.onMove).not.toHaveBeenCalled();
    expect(screen.getByTestId('tree-announce').textContent).toBe('Overview is already first');
  });
});

const PAGE = { id: 'p', title: 'X', settings: {} } as unknown as DocsPage;

describe('the row menu', () => {
  it('has Page icon… and Turn into a book…; a book says Book settings…', () => {
    const onAction = vi.fn();
    render(<PageMenu page={PAGE} onAction={onAction} onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('menu-icon'));
    expect(onAction).toHaveBeenCalledWith('icon');
    expect(screen.getByTestId('menu-book').textContent).toContain('Turn into a book…');
    cleanup();
    render(<PageMenu page={{ ...PAGE, settings: { book: { isBook: true } } }} onAction={onAction} onClose={vi.fn()} />);
    expect(screen.getByTestId('menu-book').textContent).toContain('Book settings…');
  });

  it('the icon picker hands back an emoji, a line icon or no icon', () => {
    const onPick = vi.fn();
    wrap(<IconPicker projectId="p1" title="X" current="🚀" layout="desktop" onPick={onPick} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('option', { name: '📖' }));
    expect(onPick).toHaveBeenLastCalledWith('📖');
    fireEvent.click(screen.getByRole('tab', { name: 'Icons' }));
    fireEvent.click(screen.getByRole('option', { name: 'Icon folder' }));
    expect(onPick).toHaveBeenLastCalledWith('icon:folder');
    fireEvent.click(screen.getByRole('button', { name: 'Remove icon' }));
    expect(onPick).toHaveBeenLastCalledWith(null);
  });
});
