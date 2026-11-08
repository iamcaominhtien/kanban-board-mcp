// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const http = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../../../api/client', () => ({ client: http }));

import { LessonsSettings } from './LessonsSettings';

const settings = { projectId: 'p1', lessonsMode: 'auto', lessonsMax: 20 };

beforeEach(() => {
  vi.clearAllMocks();
  http.get.mockResolvedValue({ data: settings });
  http.patch.mockImplementation((_u: string, b: object) => Promise.resolve({ data: { ...settings, ...b } }));
});
afterEach(cleanup);

describe('LessonsSettings', () => {
  it('switches between keeping at once and review, and sets how many lessons go in a prompt', async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <LessonsSettings projectId="p1" />
      </QueryClientProvider>,
    );
    const sw = await screen.findByTestId('lessons-auto');
    expect(sw.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(sw);
    await waitFor(() => expect(http.patch).toHaveBeenCalledWith('/projects/p1/ai/settings', { lessonsMode: 'review' }));
    const n = screen.getByTestId('lessons-max') as HTMLInputElement;
    expect(n.value).toBe('20');
    fireEvent.change(n, { target: { value: '8' } });
    fireEvent.blur(n);
    await waitFor(() => expect(http.patch).toHaveBeenCalledWith('/projects/p1/ai/settings', { lessonsMax: 8 }));
  });
});
