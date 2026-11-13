// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceSwitchedNotice } from './WorkspaceSwitchedNotice';
import { client } from '../api/client';
import { workspacesKey } from '../api/workspaces';
import { forgetBoardOfWindow, reportRefused } from '../api/boardOfWindow';

vi.mock('../api/client', () => ({ client: { get: vi.fn() } }));
const get = (client as unknown as { get: ReturnType<typeof vi.fn> }).get;

const item = (id: string, name: string, active: boolean) => ({
  id,
  name,
  folder: `/f/${name}`,
  engine: 'sqlite',
  place: `/f/${name}`,
  active,
  hasBoard: true,
});
const overview = (items: ReturnType<typeof item>[], board: string) => ({
  data: { items, activeId: items.find((i) => i.active)?.id ?? null, switchable: true, reason: null, board },
});

describe('WorkspaceSwitchedNotice', () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  beforeEach(() => {
    queryClient.clear();
    get.mockReset();
    forgetBoardOfWindow();
  });
  afterEach(cleanup);

  const show = () =>
    render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceSwitchedNotice />
      </QueryClientProvider>,
    );
  // the window has shown the board it was opened on (a refetch before that would be taken for its first look)
  const opened = async () => {
    await waitFor(() => expect(queryClient.getQueryData(workspacesKey)).toBeTruthy());
    await act(async () => {});
  };
  const refetchWith = async (items: ReturnType<typeof item>[], board: string) => {
    get.mockResolvedValue(overview(items, board));
    await queryClient.invalidateQueries({ queryKey: workspacesKey });
  };

  it('is silent while the board is the one the window was opened on', async () => {
    get.mockResolvedValue(overview([item('a', 'Office', true), item('b', 'Home', false)], 'board-a'));
    show();
    await opened();
    await refetchWith([item('a', 'Office', true), item('b', 'Home', false)], 'board-a');
    expect(screen.queryByTestId('workspace-switched-notice')).toBeNull();
  });

  it('asks the person to reload when another board was opened elsewhere', async () => {
    get.mockResolvedValue(overview([item('a', 'Office', true), item('b', 'Home', false)], 'board-a'));
    show();
    await opened();
    await refetchWith([item('a', 'Office', false), item('b', 'Home', true)], 'board-b');
    const notice = await screen.findByTestId('workspace-switched-notice');
    expect(notice.textContent).toContain('Home is now the board in use');
    expect(screen.getByRole('button', { name: 'Show Home' })).toBeTruthy();
  });

  it('does not take the first workspace being added, or a rename, for a switch', async () => {
    // before any workspace was added the board in use is listed as "current"
    get.mockResolvedValue(overview([item('current', 'Default', true)], 'board-a'));
    show();
    await opened();
    // adding one gives the board in use its own entry (new id, same board)
    await refetchWith([item('x1', 'Default', true), item('x2', 'Home', false)], 'board-a');
    expect(screen.queryByTestId('workspace-switched-notice')).toBeNull();
    // and a rename changes the name only
    await refetchWith([item('x1', 'Office', true), item('x2', 'Home', false)], 'board-a');
    expect(screen.queryByTestId('workspace-switched-notice')).toBeNull();
  });

  it('notices a switch between two workspaces of the same name history', async () => {
    // the old id/name rule missed this: Office renamed to Old, Home renamed to Office, then Office (was Home) opened
    get.mockResolvedValue(overview([item('a', 'Office', true), item('b', 'Home', false)], 'board-a'));
    show();
    await opened();
    await refetchWith([item('a', 'Old', false), item('b', 'Office', true)], 'board-b');
    expect(await screen.findByTestId('workspace-switched-notice')).toBeTruthy();
  });

  it('shows as soon as the server refused a change of this window', async () => {
    get.mockResolvedValue(overview([item('a', 'Office', true)], 'board-a'));
    show();
    await opened();
    act(() => reportRefused());
    expect(await screen.findByTestId('workspace-switched-notice')).toBeTruthy();
  });
});
