// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ticket } from '../../../types';
import type { Worktree } from '../../../types/aiCode';

const http = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../../../api/client', () => ({ client: http }));

import { TicketHandover } from './TicketHandover';
import { AiBoardContext } from '../aiUi';

const wt = (over: Partial<Worktree & { route: string }> = {}, uncommitted: string[] = []): Worktree =>
  ({
    ticketId: 'KAN-1',
    projectId: 'p',
    repo: '/r',
    path: '/r.worktrees/KAN-1',
    branch: 'ai/KAN-1-x',
    base: 'main',
    port: 5181,
    state: 'active',
    handover: null,
    prUrl: null,
    prNumber: null,
    conflictFiles: [],
    preparedAt: null,
    prepareS: null,
    createdAt: '',
    lastUsedAt: null,
    mergedAt: null,
    live: { uncommitted, sizeMb: 420, exists: true, ahead: 1 },
    ...over,
  }) as Worktree;

function setup(worktree: Worktree | null, flags: unknown[] = []) {
  http.get.mockImplementation((url: string) => {
    if (url.endsWith('/ai/worktree')) return Promise.resolve({ data: worktree });
    if (url.endsWith('/ai/ticket-flags')) return Promise.resolve({ data: flags });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}
const ticket = { id: 'KAN-1', assignee: 'dev1' } as unknown as Ticket;
const renderIt = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AiBoardContext.Provider
        value={{
          projectId: 'p',
          members: new Map([['dev1', { id: 'dev1', kind: 'ai', name: 'Dev An' }]]) as never,
          runsByTicket: new Map(),
          settings: null,
        }}
      >
        <TicketHandover ticket={ticket} />
      </AiBoardContext.Provider>
    </QueryClientProvider>,
  );

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('TicketHandover', () => {
  it('renders nothing without a worktree or after it is removed', async () => {
    setup(null);
    const { container, unmount } = renderIt();
    await waitFor(() => expect(http.get).toHaveBeenCalled());
    expect(container.textContent).toBe('');
    unmount();
    setup(wt({ state: 'removed' }));
    const second = renderIt();
    await waitFor(() => expect(http.get).toHaveBeenCalled());
    expect(second.container.textContent).toBe('');
  });

  it('by default hands over by pull request and offers Merge here instead', async () => {
    setup(wt({ prUrl: 'https://x/pr/7', prNumber: 7 }, ['a.ts', 'b.ts']));
    http.patch.mockResolvedValue({ data: wt() });
    renderIt();
    expect(await screen.findByTestId('ready-to-hand-over')).toBeTruthy();
    expect(screen.getByText('open a pull request')).toBeTruthy();
    expect(screen.getByText(/2 files changed, not committed/)).toBeTruthy();
    expect(screen.getByTestId('handover-pr').textContent).toBe('Pull request #7');
    expect(screen.queryByTestId('merge-btn')).toBeNull();
    fireEvent.click(screen.getByTestId('merge-here'));
    await waitFor(() => expect(http.patch).toHaveBeenCalledWith('/tickets/KAN-1/ai/handover', { route: 'local' }));
  });

  it('shows the branch route text and still offers Merge here', async () => {
    setup(wt({ route: 'branch' } as never));
    renderIt();
    expect(await screen.findByText('leave the branch')).toBeTruthy();
    expect(screen.getByTestId('merge-here')).toBeTruthy();
  });

  it('merges on this machine, and reports success and a PR link', async () => {
    setup(wt({ route: 'local' } as never));
    http.post.mockResolvedValue({ data: { merged: true, prUrl: 'https://x/pr/9' } });
    renderIt();
    const btn = await screen.findByTestId('merge-btn');
    expect(screen.getByText(/Merging also removes the worktree/)).toBeTruthy();
    fireEvent.click(btn);
    expect(await screen.findByText('Merged.')).toBeTruthy();
    expect(http.post).toHaveBeenCalledWith('/tickets/KAN-1/ai/merge');
    expect(screen.getByText('Pull request').getAttribute('href')).toBe('https://x/pr/9');
  });

  it('disables Merge while something is uncommitted', async () => {
    setup(wt({ route: 'local' } as never, ['a.ts']));
    renderIt();
    const btn = (await screen.findByTestId('merge-btn')) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe('Commit or keep the changes in the worktree first');
  });

  it('shows why a merge was refused', async () => {
    setup(wt({ route: 'local' } as never));
    http.post.mockResolvedValue({ data: { merged: false, refused: 'The main checkout is dirty' } });
    renderIt();
    fireEvent.click(await screen.findByTestId('merge-btn'));
    expect((await screen.findByTestId('merge-refused')).textContent).toBe('The main checkout is dirty');
  });

  it('shows the error when the merge call fails', async () => {
    setup(wt({ route: 'local' } as never));
    http.post.mockRejectedValue({ response: { data: { detail: 'git exploded' } } });
    renderIt();
    fireEvent.click(await screen.findByTestId('merge-btn'));
    expect(await screen.findByText('git exploded')).toBeTruthy();
  });

  it('says a merged worktree is gone', async () => {
    setup(wt({ state: 'merged' }));
    renderIt();
    expect(await screen.findByText(/Merged\. The worktree is removed and its port is given back\./)).toBeTruthy();
    expect(screen.queryByTestId('ready-to-hand-over')).toBeNull();
  });

  it('shows the conflict card and gives it to the AI, to me, or for later', async () => {
    setup(wt({ state: 'conflict', conflictFiles: ['a.py', 'b.py'] }));
    http.post.mockResolvedValue({ data: { ok: true } });
    renderIt();
    expect(await screen.findByTestId('conflict-card')).toBeTruthy();
    expect(screen.getByText(/2 files differ from main: a\.py, b\.py/)).toBeTruthy();
    await screen.findByRole('button', { name: 'Give it to Dev An' });
    fireEvent.click(screen.getByRole('button', { name: 'Give it to Dev An' }));
    await waitFor(() =>
      expect(http.post).toHaveBeenCalledWith('/tickets/KAN-1/ai/conflict', { choice: 'ai', memberId: 'dev1' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'I will do it' }));
    await waitFor(() => expect(http.post).toHaveBeenCalledWith('/tickets/KAN-1/ai/conflict', { choice: 'me' }));
  });

  it('treats an open merge_conflict flag as a conflict', async () => {
    setup(wt(), [{ id: 'f1', kind: 'merge_conflict', data: {}, open: true }]);
    renderIt();
    expect(await screen.findByTestId('conflict-card')).toBeTruthy();
  });

  it('says what keeps the worktree and lets a person move the outputs, commit the code or discard', async () => {
    const w = wt({}, ['src/a.ts', 'qa/evidence/TC-1.png']);
    w.live = { ...w.live!, outputs: ['qa/evidence/TC-1.png'] };
    setup(w);
    http.post.mockImplementation((url: string) => {
      if (url.endsWith('/outputs'))
        return Promise.resolve({ data: { moved: ['qa/evidence/TC-1.png'], to: '/ws/KAN-1/from-worktree/x' } });
      if (url.endsWith('/commit')) return Promise.resolve({ data: { committed: true, left: [] } });
      return Promise.resolve({ data: wt({ state: 'removed' }) });
    });
    renderIt();
    const box = await screen.findByTestId('worktree-not-committed');
    expect(box.textContent).toContain('2 files not committed');
    expect(box.textContent).toContain('qa/evidence/TC-1.png · output');
    fireEvent.click(screen.getByTestId('move-outputs'));
    await waitFor(() => expect(http.post).toHaveBeenCalledWith('/tickets/KAN-1/ai/worktree/outputs'));
    expect((await screen.findByTestId('tidy-note')).textContent).toContain('/ws/KAN-1/from-worktree/x');
    fireEvent.click(screen.getByTestId('commit-leftovers'));
    await waitFor(() => expect(http.post).toHaveBeenCalledWith('/tickets/KAN-1/ai/worktree/commit'));
    // discarding asks first
    fireEvent.click(screen.getByTestId('discard-worktree'));
    expect(http.post).not.toHaveBeenCalledWith('/tickets/KAN-1/ai/worktree/remove', { force: true });
    expect(screen.getByTestId('discard-worktree').textContent).toBe('Discard 2 files and remove');
    fireEvent.click(screen.getByTestId('discard-worktree'));
    await waitFor(() => expect(http.post).toHaveBeenCalledWith('/tickets/KAN-1/ai/worktree/remove', { force: true }));
  });
});
