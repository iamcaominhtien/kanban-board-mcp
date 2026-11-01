// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const c = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock('../../api/client', () => ({ client: c }));

import { useDocsFollow } from './useDocsFollow';

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('useDocsFollow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    c.put.mockResolvedValue({});
  });
  afterEach(cleanup);

  it('reads the follow state of the space', async () => {
    c.get.mockResolvedValue({ data: { level: 'follow' } });
    const { result } = renderHook(() => useDocsFollow('p1'), { wrapper: wrap() });
    await waitFor(() => expect(result.current[0]).toBe(true));
    expect(c.get).toHaveBeenCalledWith('/notifications/follow', { params: { scope: 'space', scope_id: 'p1' } });
  });

  it('treats mute as not following', async () => {
    c.get.mockResolvedValue({ data: { level: 'mute' } });
    const { result } = renderHook(() => useDocsFollow('p1'), { wrapper: wrap() });
    await waitFor(() => expect(c.get).toHaveBeenCalled());
    expect(result.current[0]).toBe(false);
  });

  it('toggling calls PUT docs/follow', async () => {
    let level: string | null = null;
    c.get.mockImplementation(async () => ({ data: { level } }));
    c.put.mockImplementation(async () => {
      level = 'follow';
      return {};
    });
    const { result } = renderHook(() => useDocsFollow('p1'), { wrapper: wrap() });
    await waitFor(() => expect(c.get).toHaveBeenCalled());
    act(() => result.current[1](true));
    await waitFor(() => expect(c.put).toHaveBeenCalledWith('/projects/p1/docs/follow', { on: true }));
    await waitFor(() => expect(result.current[0]).toBe(true));
  });

  it('does not query without a project', () => {
    renderHook(() => useDocsFollow(''), { wrapper: wrap() });
    expect(c.get).not.toHaveBeenCalled();
  });
});
