// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorkspacesCard } from './WorkspacesCard';
import { client } from '../../api/client';

vi.mock('../../api/client', () => ({
  client: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const mocked = client as unknown as Record<'get' | 'post' | 'patch' | 'delete', ReturnType<typeof vi.fn>>;

const overview = (switchable = true) => ({
  data: {
    items: [
      { id: 'a1', name: 'Office', folder: '/home/me/office', active: true, hasBoard: true },
      { id: 'b2', name: 'Home', folder: '/home/me/home', active: false, hasBoard: false },
    ],
    activeId: 'a1',
    switchable,
    reason: switchable ? null : 'Workspaces are SQLite folders; this board runs on a database server.',
  },
});

function renderCard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <WorkspacesCard />
    </QueryClientProvider>,
  );
}

describe('WorkspacesCard', () => {
  afterEach(cleanup);

  beforeEach(() => {
    Object.values(mocked).forEach((fn) => fn.mockReset());
  });

  it('lists the workspaces, marks the one in use and offers Switch only for the others', async () => {
    mocked.get.mockResolvedValue(overview());
    renderCard();
    expect(await screen.findByText('Office')).toBeTruthy();
    expect(screen.getByText('In use')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Switch' })).toHaveLength(1);
    expect(screen.getByText('Empty: a new board starts here.')).toBeTruthy();
  });

  it('disables Switch and says why while the board runs on a database server', async () => {
    mocked.get.mockResolvedValue(overview(false));
    renderCard();
    expect(await screen.findByText(/this board runs on a database server/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Switch' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('adds a workspace by name and shows the server reason when it is refused', async () => {
    mocked.get.mockResolvedValue(overview());
    mocked.post.mockRejectedValue({ response: { data: { detail: 'A workspace named "Home" already exists' } } });
    renderCard();
    await screen.findByText('Office');
    fireEvent.change(screen.getByPlaceholderText(/Name, for example/), { target: { value: 'Home' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add workspace' }));
    expect(await screen.findByText('A workspace named "Home" already exists')).toBeTruthy();
    expect(mocked.post).toHaveBeenCalledWith('/workspaces', { name: 'Home' });
  });

  it('asks before removing and forgets only the entry', async () => {
    mocked.get.mockResolvedValue(overview());
    mocked.delete.mockResolvedValue({ data: {} });
    renderCard();
    await screen.findByText('Home');
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByText(/The folder and its data stay on disk/)).toBeTruthy();
    expect(mocked.delete).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]);
    await waitFor(() => expect(mocked.delete).toHaveBeenCalledWith('/workspaces/b2'));
  });
});
