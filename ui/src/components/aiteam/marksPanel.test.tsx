// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../../api/client', () => ({ client: http }));
import { MarksPanel } from './MarksPanel';

const suites = [
  { key: 'board', name: 'Board', tasks: 4, runnable: true },
  { key: 'recovery', name: 'Recovery', tasks: 3, runnable: false },
];
const mark = {
  id: 'm1',
  suite: 'board',
  memberId: 'a1',
  model: 'haiku',
  state: 'done',
  score: 0.9,
  details: [],
  createdAt: '2026-10-01T10:00:00Z',
  endedAt: '2026-10-01T10:05:00Z',
};
function wire(marks: unknown[]) {
  http.get.mockImplementation((url: string) => {
    if (url === '/ai/evals/suites') return Promise.resolve({ data: suites });
    if (url === '/ai/evals/marks') return Promise.resolve({ data: marks });
    return Promise.resolve({
      data: { members: [{ id: 'a1', name: 'Dev An', kind: 'ai', model: 'sonnet' }], settings: {}, summary: {} },
    });
  });
}
const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MarksPanel projectId="p1" />
    </QueryClientProvider>,
  );
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('MarksPanel', () => {
  it('says never run, and marks a suite that cannot run from here', async () => {
    wire([]);
    mount();
    expect((await screen.findAllByTestId('mark-never')).length).toBeTruthy();
    expect(screen.getByText('Not runnable yet')).toBeTruthy();
    expect(screen.getByText(/Marks run on a sandbox/)).toBeTruthy();
  });

  it('shows the last score and runs a suite with the chosen member', async () => {
    wire([mark]);
    http.post.mockResolvedValue({ data: { markId: 'm2', suite: 'board', runs: 1 } });
    mount();
    expect(await screen.findByText('90%')).toBeTruthy();
    expect(await screen.findByTestId('marks-light-hint')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Run Board tools'));
    await waitFor(() => expect(http.post).toHaveBeenCalledWith('/ai/evals/run', { suite: 'board', memberId: 'a1' }));
  });
});
