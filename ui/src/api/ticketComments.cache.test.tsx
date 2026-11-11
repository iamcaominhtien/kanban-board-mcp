// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Ticket } from '../types';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock('./client', () => ({ client: http }));

import { ticketKeys, useAddComment } from './tickets';

const ticket = (id: string, comments: string[]) =>
  ({ id, projectId: 'p1', comments: comments.map((text, i) => ({ id: `c${i}`, text })) }) as unknown as Ticket;

describe('adding a comment', () => {
  it('puts the saved ticket in the project list at once, before the list comes back', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData([...ticketKeys.all('p1'), undefined], [ticket('KB-1', ['old']), ticket('KB-2', [])]);
    http.post.mockResolvedValueOnce({ data: ticket('KB-1', ['old', 'new one']) });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useAddComment(), { wrapper });
    await act(() => result.current.mutateAsync({ ticketId: 'KB-1', text: 'new one' }));
    const list = qc.getQueryData<Ticket[]>([...ticketKeys.all('p1'), undefined])!;
    expect(list[0].comments.map((c) => c.text)).toEqual(['old', 'new one']);
    expect(list[1].id).toBe('KB-2');
    expect(qc.getQueryData<Ticket>(ticketKeys.detail('KB-1'))!.comments).toHaveLength(2);
  });
});
