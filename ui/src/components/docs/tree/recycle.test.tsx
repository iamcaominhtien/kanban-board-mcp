// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecycleEntry } from '../../../types/docsActions';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn(), patch: vi.fn() }));
vi.mock('../../../api/client', () => ({ client: api }));

import { RecycleBin } from '../../RecycleBin';
import { ToastProvider } from '../../Toast';
import { daysLeftTone, pagesToEmpty } from './RecycleBinParts';

function entry(id: string, over: Partial<RecycleEntry> = {}): RecycleEntry {
  return {
    id,
    title: id,
    projectId: 'p1',
    deletedAt: '2026-11-14T10:00:00Z',
    deletedBy: 'An Nguyen',
    pageCount: 1,
    daysLeft: 27,
    ...over,
  };
}

const ENTRIES: RecycleEntry[] = [
  entry('Sunset plan', { pageCount: 2, childTitles: ['Pricing note'] }),
  entry('Pricing draft', { parentTitle: 'Sunset plan', parentDeleted: true, daysLeft: 2 }),
  entry('Old launch plan', { daysLeft: 6, deletedAt: '2026-10-24T10:00:00Z', icon: '📘' }),
];
const TREE = [
  {
    id: 'arch',
    parentId: null,
    position: 0,
    title: 'Architecture',
    slug: 'architecture',
    status: 'published',
    version: 1,
    hasDraft: false,
    updatedAt: '',
  },
];

function setup() {
  api.get.mockImplementation(async (url: string) => {
    if (url.endsWith('/docs/recycle-bin')) return { data: ENTRIES };
    if (url.endsWith('/docs/tree')) return { data: TREE };
    return { data: null };
  });
  api.post.mockImplementation(async (url: string) =>
    url.endsWith('/restore') ? { data: { id: 'x', restoredPages: 1, movedToTopLevel: true } } : { data: {} },
  );
  api.delete.mockResolvedValue({ data: {} });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <RecycleBin tickets={[]} projectId="p1" onRestore={vi.fn()} onClose={vi.fn()} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const restoreButtons = () => screen.getAllByRole('button', { name: /^Restore$/ });

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
});
afterEach(cleanup);

describe('the Recycle Bin', () => {
  it("shows a deleted page's emoji in place of the page mark", async () => {
    setup();
    const title = await screen.findByText('Old launch plan');
    const row = title.closest('[data-testid]') ?? title.parentElement!.parentElement!;
    expect(row.textContent).toContain('📘');
    // only that page has one: the others keep the page mark
    expect(document.body.textContent?.match(/📘/g)).toHaveLength(1);
  });

  it('colours the days left: grey, amber in the last week, red in the last three days', async () => {
    setup();
    await screen.findByText('Pricing draft');
    const tones = screen.getAllByTestId('bin-days-left').map((d) => d.getAttribute('data-tone'));
    expect(tones).toEqual(['grey', 'red', 'amber']);
    expect(daysLeftTone(8).tone).toBe('grey');
    expect(daysLeftTone(7).tone).toBe('amber');
    expect(daysLeftTone(3).tone).toBe('red');
  });

  it('asks where a page whose parent is gone should go: a chosen page restores it, then moves it there', async () => {
    setup();
    await screen.findByText('Pricing draft');
    fireEvent.click(restoreButtons()[1]);
    const dialog = await screen.findByRole('dialog', { name: 'Restore page' });
    expect(dialog.textContent).toContain('Its parent, Sunset plan, is still in the Recycle Bin.');
    // the safe choice is the default
    expect((screen.getByRole('radio', { name: /At the top level/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: /Choose a page/ }));
    await waitFor(() => expect(screen.getByRole('option', { name: 'Architecture' })).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Restore under'), { target: { value: 'arch' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('restore-where-go'));
    });
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/docs/pages/Pricing draft/move', {
        parentId: 'arch',
        beforeId: null,
        afterId: null,
      }),
    );
    expect(api.post.mock.calls[0][0]).toBe('/docs/pages/Pricing draft/restore');
  });

  it('can restore the parent first', async () => {
    setup();
    await screen.findByText('Pricing draft');
    fireEvent.click(restoreButtons()[1]);
    fireEvent.click(await screen.findByRole('radio', { name: /Restore “Sunset plan” first/ }));
    await act(async () => {
      fireEvent.click(screen.getByTestId('restore-where-go'));
    });
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(api.post.mock.calls.map((c) => c[0])).toEqual([
      '/docs/pages/Sunset plan/restore',
      '/docs/pages/Pricing draft/restore',
    ]);
  });

  it('restores a page whose parent is still there without asking', async () => {
    setup();
    await screen.findByText('Old launch plan');
    await act(async () => {
      fireEvent.click(restoreButtons()[2]);
    });
    expect(screen.queryByRole('dialog', { name: 'Restore page' })).toBeNull();
    expect(api.post).toHaveBeenCalledWith('/docs/pages/Old launch plan/restore');
  });

  it('deletes several picked pages forever after naming them', async () => {
    setup();
    await screen.findByText('Old launch plan');
    fireEvent.click(screen.getByLabelText('Select Sunset plan'));
    fireEvent.click(screen.getByLabelText('Select Old launch plan'));
    expect(screen.getByTestId('bin-selection-bar').textContent).toContain('2 selected');
    fireEvent.click(within(screen.getByTestId('bin-selection-bar')).getByRole('button', { name: 'Delete forever' }));
    const confirm = screen.getByTestId('purge-confirm');
    expect(confirm.textContent).toBe('Delete 3 pages forever');
    await act(async () => {
      fireEvent.click(confirm);
    });
    await waitFor(() => expect(api.delete).toHaveBeenCalledTimes(2));
    expect(api.delete.mock.calls.map((c) => c[0])).toEqual([
      '/docs/pages/Sunset plan/purge',
      '/docs/pages/Old launch plan/purge',
    ]);
  });

  it('empties only the older pages when asked', () => {
    // 30 days in the bin: 2 and 6 days left were deleted 28 and 24 days ago
    expect(pagesToEmpty(ENTRIES, 'older').map((e) => e.id)).toEqual(['Pricing draft', 'Old launch plan']);
    expect(pagesToEmpty(ENTRIES, 'all')).toHaveLength(3);
  });
});
