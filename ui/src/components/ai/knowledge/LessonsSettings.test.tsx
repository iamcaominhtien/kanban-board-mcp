// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const http = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../../../api/client', () => ({ client: http }));

import { LessonsSettings } from './LessonsSettings';

const ops = { hangAfterMin: 10, proposeLessons: true, lessonsInPrompt: 20 };

beforeEach(() => {
  vi.clearAllMocks();
  http.get.mockResolvedValue({ data: ops });
  http.patch.mockImplementation((_u: string, b: object) => Promise.resolve({ data: { ...ops, ...b } }));
});
afterEach(cleanup);

describe('LessonsSettings', () => {
  it('switches proposals and sets how many lessons go in a prompt', async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <LessonsSettings projectId="p1" />
      </QueryClientProvider>,
    );
    const sw = await screen.findByTestId('ops-propose-lessons');
    expect(sw.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(sw);
    await waitFor(() => expect(http.patch).toHaveBeenCalledWith('/projects/p1/ai/ops', { proposeLessons: false }));
    const n = screen.getByTestId('ops-lessons-in-prompt') as HTMLInputElement;
    expect(n.value).toBe('20');
    fireEvent.change(n, { target: { value: '8' } });
    fireEvent.blur(n);
    await waitFor(() => expect(http.patch).toHaveBeenCalledWith('/projects/p1/ai/ops', { lessonsInPrompt: 8 }));
  });
});
