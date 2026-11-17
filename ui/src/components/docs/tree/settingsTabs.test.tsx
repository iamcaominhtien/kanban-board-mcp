// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocsPage, DocsTreeNode } from '../../../types/docs';

const api = vi.hoisted(() => ({ patchPageSettings: vi.fn() }));
vi.mock('../../../api/docs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../api/docs')>()),
  patchPageSettings: api.patchPageSettings,
}));

import { docsKeys } from '../../../api/docs';
import { docsSpaceKey } from '../../../api/docsSpace';
import { ToastProvider } from '../../Toast';
import { PageSettingsPanel, type SettingsTab } from '../PageSettingsPanel';
import { SETTINGS_SAVE_MS } from '../usePageSettings';

const PAGE: DocsPage = {
  id: 'p1',
  projectId: 'proj',
  parentId: null,
  title: 'The Harbour Lights',
  slug: 'the-harbour-lights',
  status: 'published',
  version: 2,
  markdown: 'Hello',
  settings: {},
  headings: [],
  path: [],
  createdBy: 'Hoa Mai',
  updatedBy: 'Hoa Mai',
  updatedAt: '2026-11-12T10:00:00Z',
  createdAt: '2026-11-01T10:00:00Z',
  hasUnpublishedChanges: false,
  draft: null,
};
const NODES: DocsTreeNode[] = [
  {
    id: 'p1',
    parentId: null,
    position: 0,
    title: 'The Harbour Lights',
    slug: 'x',
    status: 'published',
    version: 2,
    hasDraft: false,
    updatedAt: '',
  },
  {
    id: 'c1',
    parentId: 'p1',
    position: 0,
    title: 'The Letter',
    slug: 'y',
    status: 'published',
    version: 1,
    hasDraft: false,
    updatedAt: '',
  },
];

function setup(tab: SettingsTab, projectHighlights: 'on' | 'off' = 'on') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(docsKeys.page(PAGE.id), PAGE);
  qc.setQueryData(docsKeys.tree('proj'), NODES);
  qc.setQueryData(docsSpaceKey('proj'), { highlights: projectHighlights });
  function Live() {
    const { data } = useQuery({
      queryKey: docsKeys.page(PAGE.id),
      queryFn: () => PAGE,
      enabled: false,
      staleTime: Infinity,
    });
    return <PageSettingsPanel page={data!} layout="desktop" initialTab={tab} nodes={NODES} onClose={vi.fn()} />;
  }
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <Live />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return qc;
}

async function flushSave() {
  await act(async () => {
    vi.advanceTimersByTime(SETTINGS_SAVE_MS + 10);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  api.patchPageSettings.mockReset();
  api.patchPageSettings.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
    ...PAGE,
    settings: patch,
  }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Page settings › Book', () => {
  it('turns the page into a book that numbers its chapters, and the tree knows at once', async () => {
    const qc = setup('book');
    expect(screen.getByTestId('ps-book').textContent).toContain('1 child page becomes a chapter.');
    fireEvent.click(screen.getByTestId('ps-book'));
    expect(qc.getQueryData<DocsTreeNode[]>(docsKeys.tree('proj'))![0].book).toEqual({
      isBook: true,
      numberChapters: true,
    });
    await flushSave();
    expect(api.patchPageSettings).toHaveBeenCalledWith('p1', { book: { isBook: true, numberChapters: true } });
  });
});

describe('Page settings › Access', () => {
  it('Not for AI teams writes notForAi, and Off for this page writes highlights off', async () => {
    setup('access');
    fireEvent.click(screen.getByTestId('ps-not-for-ai'));
    fireEvent.click(screen.getByTestId('ps-highlights-off'));
    await flushSave();
    expect(api.patchPageSettings).toHaveBeenCalledWith('p1', { notForAi: true, highlights: 'off' });
  });

  it('says so when an admin turned highlights off for the project', () => {
    setup('access', 'off');
    expect((screen.getByTestId('ps-highlights-off') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('An admin turned highlights off for this project.')).toBeTruthy();
  });
});
