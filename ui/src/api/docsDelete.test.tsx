// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocsTreeNode } from '../types/docs';

const api = vi.hoisted(() => ({ get: vi.fn(), delete: vi.fn(), post: vi.fn() }));
vi.mock('./client', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, client: { ...(real.client as object), get: api.get, delete: api.delete, post: api.post } };
});

import { docsKeys, goneHere, useDeletePage, useDocsPage, useRestorePage, withSubPages } from './docs';

const node = (id: string, parentId: string | null) => ({ id, parentId }) as DocsTreeNode;

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, wrapper };
}

afterEach(() => {
  vi.clearAllMocks();
  goneHere.clear();
});

describe('deleting a page', () => {
  it('knows the page and every page under it', () => {
    const tree = [node('a', null), node('b', 'a'), node('c', 'b'), node('d', null), node('e', 'a')];
    expect(withSubPages(tree, 'a').sort()).toEqual(['a', 'b', 'c', 'e']);
    expect(withSubPages(tree, 'd')).toEqual(['d']);
  });

  it('never asks for a deleted page or its sub-pages again, until a restore', async () => {
    const { qc, wrapper } = setup();
    qc.setQueryData(docsKeys.tree('p1'), [node('a', null), node('b', 'a')]);
    api.delete.mockResolvedValue({ data: { id: 'a', deletedPages: 2 } });
    const del = renderHook(() => useDeletePage('p1'), { wrapper });
    await act(async () => {
      const out = await del.result.current.mutateAsync('a');
      expect(out.gone.sort()).toEqual(['a', 'b']);
    });
    // a view of the sub-page that mounts now does not fetch it (it would get 410)
    api.get.mockResolvedValue({ data: { id: 'b' } });
    const view = renderHook(() => useDocsPage('b'), { wrapper });
    expect(view.result.current.fetchStatus).toBe('idle');
    expect(api.get).not.toHaveBeenCalledWith('/docs/pages/b');

    // restored, it is asked for as usual
    api.post.mockResolvedValue({ data: { id: 'a', restoredPages: 2, movedToTopLevel: false } });
    const restore = renderHook(() => useRestorePage('p1'), { wrapper });
    await act(async () => {
      await restore.result.current.mutateAsync('a');
    });
    const again = renderHook(() => useDocsPage('b'), { wrapper });
    await waitFor(() => expect(again.result.current.data).toEqual({ id: 'b' }));
  });
});
