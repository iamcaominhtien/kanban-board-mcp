// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Worktree } from '../../../types/aiCode';

const http = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../../../api/client', () => ({ client: http }));

import { RepositoriesSection } from './RepositoriesSection';

const wt = (over: Partial<Worktree> = {}, uncommitted: string[] = []): Worktree => ({
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
});

interface Setup {
  ops?: Record<string, unknown> | 'error';
  worktrees?: Worktree[] | 'error';
  runs?: unknown[];
}
function setup({ ops = {}, worktrees = [], runs = [] }: Setup = {}) {
  http.get.mockImplementation((url: string) => {
    if (url.endsWith('/ai/settings'))
      return ops === 'error'
        ? Promise.reject({ response: { data: { detail: 'ops down' } } })
        : Promise.resolve({ data: { ops: { hangAfterMin: 5, ...ops } } });
    if (url.endsWith('/ai/worktrees'))
      return worktrees === 'error'
        ? Promise.reject({ response: { data: { detail: 'git down' } } })
        : Promise.resolve({ data: { worktrees, totalMb: 2048 } });
    if (url.endsWith('/ai/board'))
      return Promise.resolve({
        data: { tickets: Object.fromEntries((runs as { ticketId: string }[]).map((r) => [r.ticketId, r])) },
      });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
  http.patch.mockImplementation((_u: string, body: unknown) =>
    Promise.resolve({ data: { ops: { hangAfterMin: 5, ...((body as { ops: object }).ops ?? {}) } } }),
  );
  http.post.mockResolvedValue({ data: {} });
}
const renderIt = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RepositoriesSection projectId="p" />
    </QueryClientProvider>,
  );

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('RepositoriesSection settings', () => {
  it('sets the Checks commands without the scan wizard', async () => {
    setup({ ops: { commands: { test: 'npm test', lint: '', build: '' } } });
    renderIt();
    const test = (await screen.findByTestId('cmd-test')) as HTMLInputElement;
    expect(test.value).toBe('npm test');
    fireEvent.change(screen.getByTestId('cmd-lint'), { target: { value: ' npm run lint ' } });
    fireEvent.blur(screen.getByTestId('cmd-lint'));
    await waitFor(() =>
      expect(http.patch).toHaveBeenCalledWith('/projects/p/ai/settings', {
        ops: { commands: { lint: 'npm run lint' } },
      }),
    );
    fireEvent.change(screen.getByTestId('cmd-build'), { target: { value: 'npm run build' } });
    fireEvent.blur(screen.getByTestId('cmd-build'));
    await waitFor(() =>
      expect(http.patch).toHaveBeenCalledWith('/projects/p/ai/settings', {
        ops: { commands: { build: 'npm run build' } },
      }),
    );
  });

  it('turns a command off as a check, and back on, without losing the command', async () => {
    const ops = { commands: { test: 'npm test', lint: '', build: 'npm run build' }, checksOff: ['build'] };
    setup({ ops });
    http.patch.mockImplementation((_u: string, body: unknown) =>
      Promise.resolve({ data: { hangAfterMin: 5, ...ops, ...(body as object) } }),
    );
    renderIt();
    const test = (await screen.findByTestId('check-test')) as HTMLInputElement;
    const lint = screen.getByTestId('check-lint') as HTMLInputElement;
    const build = screen.getByTestId('check-build') as HTMLInputElement;
    expect([test.checked, build.checked]).toEqual([true, false]);
    expect(lint.disabled).toBe(true); // no lint command: nothing to switch
    fireEvent.click(test);
    await waitFor(() =>
      expect(http.patch).toHaveBeenCalledWith('/projects/p/ai/settings', { ops: { checksOff: ['build', 'test'] } }),
    );
    fireEvent.click(build);
    await waitFor(() =>
      expect(http.patch).toHaveBeenCalledWith('/projects/p/ai/settings', { ops: { checksOff: ['test'] } }),
    );
  });

  it('edits the folders put in front of the PATH', async () => {
    setup({ ops: { envPath: ['/opt/homebrew/bin'] } });
    http.patch.mockImplementation((_u: string, body: unknown) =>
      Promise.resolve({ data: { hangAfterMin: 5, envPath: ['/opt/homebrew/bin'], ...(body as object) } }),
    );
    renderIt();
    const toggle = await screen.findByTestId('env-toggle');
    expect(screen.getByTestId('env-summary').textContent).toContain('/opt/homebrew/bin');
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Add a folder' }));
    const add = screen.getByLabelText('New folder');
    fireEvent.change(add, { target: { value: '/Users/me/.nvm/versions/node/v22/bin' } });
    fireEvent.blur(add);
    await waitFor(() =>
      expect(http.patch).toHaveBeenCalledWith('/projects/p/ai/settings', {
        ops: {
          envPath: ['/opt/homebrew/bin', '/Users/me/.nvm/versions/node/v22/bin'],
        },
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove /opt/homebrew/bin' }));
    await waitFor(() =>
      expect(http.patch).toHaveBeenCalledWith('/projects/p/ai/settings', {
        ops: {
          envPath: ['/Users/me/.nvm/versions/node/v22/bin'],
        },
      }),
    );
    expect(screen.queryByLabelText('The app’s own PATH')).toBeNull(); // the settings page does not know it
  });

  it('shows a skeleton while loading, then the off note', async () => {
    setup({ ops: { worktrees: { on: false } } });
    renderIt();
    expect(screen.getByLabelText('Loading')).toBeTruthy();
    expect(await screen.findByTestId('wt-off-note')).toBeTruthy();
    expect(
      screen.getByText(/Worktrees are off: every member of the project shares the member’s working folder/),
    ).toBeTruthy();
    expect(screen.queryByTestId('worktree-list')).toBeNull();
  });

  it('offers Try again when the settings fail to load', async () => {
    setup({ ops: 'error' });
    renderIt();
    expect(await screen.findByText(/Couldn't load the repository settings: ops down/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(http.get.mock.calls.filter((c) => String(c[0]).endsWith('/ai/settings')).length).toBe(2),
    );
  });

  it('turns worktrees on with a PATCH', async () => {
    setup({ ops: { worktrees: { on: false } } });
    renderIt();
    fireEvent.click(await screen.findByTestId('wt-on'));
    await waitFor(() =>
      expect(http.patch).toHaveBeenCalledWith('/projects/p/ai/settings', { ops: { worktrees: { on: true } } }),
    );
    expect(await screen.findByTestId('worktree-list')).toBeTruthy();
  });

  it('saves a text field on blur only when it changed, and trims the repository path', async () => {
    setup({ ops: { worktrees: { on: false, repo: '/code/kan', prepare: 'npm ci' } } });
    renderIt();
    const repo = (await screen.findByTestId('wt-repo')) as HTMLInputElement;
    fireEvent.blur(repo);
    expect(http.patch).not.toHaveBeenCalled();
    fireEvent.change(repo, { target: { value: '  /code/other  ' } });
    fireEvent.blur(repo);
    await waitFor(() =>
      expect(http.patch).toHaveBeenCalledWith('/projects/p/ai/settings', {
        ops: { worktrees: { repo: '/code/other' } },
      }),
    );
    fireEvent.change(screen.getByTestId('wt-repo'), { target: { value: '   ' } });
    fireEvent.blur(screen.getByTestId('wt-repo'));
    await waitFor(() =>
      expect(http.patch).toHaveBeenLastCalledWith('/projects/p/ai/settings', { ops: { worktrees: { repo: null } } }),
    );
  });

  it('saves base branch and prepare command; Enter blurs the field', async () => {
    setup({ ops: { worktrees: { on: false } } });
    renderIt();
    const base = await screen.findByTestId('wt-base-branch');
    fireEvent.change(base, { target: { value: 'develop' } });
    fireEvent.keyDown(base, { key: 'Enter' });
    fireEvent.blur(base);
    await waitFor(() =>
      expect(http.patch).toHaveBeenCalledWith('/projects/p/ai/settings', {
        ops: { worktrees: { baseBranch: 'develop' } },
      }),
    );
    const prep = screen.getByTestId('wt-prepare');
    fireEvent.change(prep, { target: { value: 'make setup' } });
    fireEvent.blur(prep);
    await waitFor(() =>
      expect(http.patch).toHaveBeenCalledWith('/projects/p/ai/settings', {
        ops: { worktrees: { prepare: 'make setup' } },
      }),
    );
  });

  it('validates the first port, then saves a good one', async () => {
    setup({ ops: { worktrees: { on: false, basePort: 5200 } } });
    renderIt();
    expect(await screen.findByText('5200-5219')).toBeTruthy();
    const port = screen.getByTestId('wt-base-port');
    fireEvent.change(port, { target: { value: '80' } });
    fireEvent.blur(port);
    expect(await screen.findByText('The first port must be between 1024 and 65515.')).toBeTruthy();
    expect(http.patch).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('wt-base-port'), { target: { value: '6000' } });
    fireEvent.blur(screen.getByTestId('wt-base-port'));
    await waitFor(() =>
      expect(http.patch).toHaveBeenCalledWith('/projects/p/ai/settings', { ops: { worktrees: { basePort: 6000 } } }),
    );
  });

  it('changes the hand-over route and describes it', async () => {
    setup({ ops: { worktrees: { on: false, handover: 'branch' } } });
    renderIt();
    expect(await screen.findByText(/The branch is pushed and you open whatever your host calls/)).toBeTruthy();
    fireEvent.change(screen.getByTestId('wt-handover'), { target: { value: 'local' } });
    await waitFor(() =>
      expect(http.patch).toHaveBeenCalledWith('/projects/p/ai/settings', { ops: { worktrees: { handover: 'local' } } }),
    );
  });

  it('toggles per-run configuration when worktrees are off, and locks it on when they are on', async () => {
    setup({ ops: { worktrees: { on: false }, perRunConfig: false } });
    const { unmount } = renderIt();
    const sw = await screen.findByTestId('wt-per-run');
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw);
    await waitFor(() =>
      expect(http.patch).toHaveBeenCalledWith('/projects/p/ai/settings', { ops: { perRunConfig: true } }),
    );
    unmount();
    setup({ ops: { worktrees: { on: true } } });
    renderIt();
    const locked = await screen.findByTestId('wt-per-run');
    expect(locked.getAttribute('aria-checked')).toBe('true');
    expect((locked as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Always on while worktrees are on/)).toBeTruthy();
  });

  it('shows the error when a save fails', async () => {
    setup({ ops: { worktrees: { on: false } } });
    http.patch.mockRejectedValue({ response: { data: { detail: 'read-only' } } });
    renderIt();
    fireEvent.click(await screen.findByTestId('wt-on'));
    expect((await screen.findByRole('alert')).textContent).toBe('read-only');
  });
});

describe('RepositoriesSection worktree list', () => {
  const on = { worktrees: { on: true, repo: '/r' } };

  it('says there is no worktree yet and disables Clean up finished', async () => {
    setup({ ops: on });
    renderIt();
    expect(await screen.findByTestId('wt-empty')).toBeTruthy();
    expect((screen.getByTestId('wt-cleanup') as HTMLButtonElement).disabled).toBe(true);
    expect(await screen.findByText(/0 worktrees · 2.0 GB/)).toBeTruthy();
  });

  it('offers Try again when the list fails', async () => {
    setup({ ops: on, worktrees: 'error' });
    renderIt();
    expect(await screen.findByText(/Couldn't load the worktrees: git down/)).toBeTruthy();
  });

  it('lists worktrees and runs Open folder, Keep, Remove and Copy path', async () => {
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    setup({ ops: on, worktrees: [wt()] });
    renderIt();
    expect(await screen.findByText(/1 worktree ·/)).toBeTruthy();
    expect(screen.getByText('ai/KAN-1-x')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open folder' }));
    await waitFor(() => expect(http.post).toHaveBeenCalledWith('/tickets/KAN-1/ai/worktree/open'));
    fireEvent.click(screen.getByRole('button', { name: 'Copy path' }));
    expect(writeText).toHaveBeenCalledWith('/r.worktrees/KAN-1');
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    await waitFor(() => expect(http.post).toHaveBeenCalledWith('/tickets/KAN-1/ai/worktree/keep'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(http.post).toHaveBeenCalledWith('/tickets/KAN-1/ai/worktree/remove', { force: false }));
  });

  it('stops the running run from the row', async () => {
    setup({
      ops: on,
      worktrees: [wt()],
      runs: [{ runId: 'run9', ticketId: 'KAN-1', memberId: 'm1', state: 'running' }],
    });
    renderIt();
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(http.post).toHaveBeenCalledWith('/ai/runs/run9/cancel'));
  });

  it('cleans up finished worktrees and reports what was removed and kept', async () => {
    setup({ ops: on, worktrees: [wt()] });
    http.post.mockResolvedValue({
      data: { removed: ['KAN-2', 'KAN-3'], kept: [{ ticketId: 'KAN-4', why: 'uncommitted' }] },
    });
    renderIt();
    const btn = await screen.findByTestId('wt-cleanup');
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(btn);
    expect(await screen.findByText('Removed 2; kept KAN-4 (uncommitted).')).toBeTruthy();
    expect(http.post).toHaveBeenCalledWith('/projects/p/ai/worktrees/cleanup');
  });

  it('shows the error when a row action fails', async () => {
    setup({ ops: on, worktrees: [wt()] });
    http.post.mockRejectedValue({ response: { data: { detail: 'no editor' } } });
    renderIt();
    fireEvent.click(await screen.findByRole('button', { name: 'Open folder' }));
    expect((await screen.findByRole('alert')).textContent).toBe('no editor');
  });
});
