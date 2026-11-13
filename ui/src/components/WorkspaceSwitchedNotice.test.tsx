// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceSwitchedNotice } from './WorkspaceSwitchedNotice';
import { client } from '../api/client';
import { workspacesKey } from '../api/workspaces';

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
const overview = (items: ReturnType<typeof item>[]) => ({
  data: { items, activeId: items.find((i) => i.active)?.id ?? null, switchable: true, reason: null },
});

describe('WorkspaceSwitchedNotice', () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  beforeEach(() => {
    queryClient.clear();
    get.mockReset();
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
  const refetchWith = async (items: ReturnType<typeof item>[]) => {
    get.mockResolvedValue(overview(items));
    await queryClient.invalidateQueries({ queryKey: workspacesKey });
  };

  it('is silent while the board is the one the window was opened on', async () => {
    get.mockResolvedValue(overview([item('a', 'Office', true), item('b', 'Home', false)]));
    show();
    await opened();
    await refetchWith([item('a', 'Office', true), item('b', 'Home', false)]);
    expect(screen.queryByTestId('workspace-switched-notice')).toBeNull();
  });

  it('asks the person to reload when another window switched the board', async () => {
    get.mockResolvedValue(overview([item('a', 'Office', true), item('b', 'Home', false)]));
    show();
    await opened();
    await refetchWith([item('a', 'Office', false), item('b', 'Home', true)]);
    const notice = await screen.findByTestId('workspace-switched-notice');
    expect(notice.textContent).toContain('Home');
  });

  it('does not take the first workspace being added, or a rename, for a switch', async () => {
    // before any workspace was added the board in use is listed as "current"
    get.mockResolvedValue(overview([item('current', 'Default', true)]));
    show();
    await opened();
    // adding one gives the board in use its own entry (same name, new id)
    await refetchWith([item('x1', 'Default', true), item('x2', 'Home', false)]);
    expect(screen.queryByTestId('workspace-switched-notice')).toBeNull();
    // and a rename changes the name only
    await refetchWith([item('x1', 'Office', true), item('x2', 'Home', false)]);
    expect(screen.queryByTestId('workspace-switched-notice')).toBeNull();
  });
});
