// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../../../api/client', () => ({ client: http }));
import { PullStatus } from './PullStatus';

const pull = {
  ticketId: 'KAN-1',
  number: 318,
  url: 'https://g/pull/318',
  branch: 'b',
  state: 'open',
  ci: 'red',
  red: { check: 'lint', url: null, at: null, blamed: true, base: 'main', handledAt: null, runId: null },
  pendingComments: [{ id: 'c1', author: 'Rin', body: 'Stream it?', path: 'a.py', line: 3 }],
  checkedAt: null,
  lastError: null,
};
function wire(pulls: unknown[]) {
  http.get.mockImplementation((url: string) => {
    if (url.startsWith('/tickets/')) return Promise.resolve({ data: { id: 'KAN-1', projectId: 'p1', assignee: null } });
    if (url.endsWith('/ai/pulls')) return Promise.resolve({ data: pulls });
    return Promise.resolve({ data: {} });
  });
}
const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PullStatus ticketId="KAN-1" />
    </QueryClientProvider>,
  );
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PullStatus', () => {
  it('renders nothing without a watched pull request', async () => {
    wire([]);
    const { container } = mount();
    await waitFor(() => expect(http.get).toHaveBeenCalledWith(expect.stringMatching(/ai\/pulls/)));
    expect(container.textContent).toBe('');
  });

  it('gives red CI and the comments back, and shows a 409 message', async () => {
    wire([pull]);
    http.post.mockRejectedValueOnce({ response: { data: { detail: 'Nothing to hand back.' } } });
    http.post.mockResolvedValueOnce({ data: { runId: 'r1' } });
    mount();
    fireEvent.click(await screen.findByText(/Give it back to/));
    expect(await screen.findByText('Nothing to hand back.')).toBeTruthy();
    fireEvent.click(screen.getByText(/Hand the comment to/));
    await waitFor(() => expect(http.post).toHaveBeenCalledWith('/tickets/KAN-1/ai/pull/comments-to-dev'));
  });

  it('does not send anyone back when the base is red too', async () => {
    wire([{ ...pull, red: { ...pull.red, blamed: false } }]);
    mount();
    expect(await screen.findByTestId('pull-not-ours')).toBeTruthy();
    expect((screen.getByText(/Give it back to/).closest('button') as HTMLButtonElement).disabled).toBe(true);
  });
});
