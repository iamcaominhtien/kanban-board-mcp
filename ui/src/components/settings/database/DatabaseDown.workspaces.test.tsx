// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseDownScreen } from './DatabaseDown';
import { client } from '../../../api/client';

vi.mock('../../../api/client', () => ({ client: { get: vi.fn(), post: vi.fn() } }));
const mocked = client as unknown as Record<'get' | 'post', ReturnType<typeof vi.fn>>;

const down = {
  since: Date.now() / 1000 - 40,
  error: 'TimeoutError',
  target: { engine: 'postgresql', label: 'PostgreSQL', host: 'db.office.example', port: 5432 },
};
const workspaces = (switchable = true) => ({
  data: {
    items: [
      {
        id: 'o',
        name: 'Office',
        folder: '/f',
        engine: 'postgresql',
        place: 'db.office.example:5432/kanban',
        active: true,
        hasBoard: true,
      },
      { id: 'h', name: 'Home', folder: '/g', engine: 'sqlite', place: '/g', active: false, hasBoard: true },
    ],
    activeId: 'o',
    switchable,
    reason: null,
  },
});

function show() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <DatabaseDownScreen down={down} />
    </QueryClientProvider>,
  );
}

describe('the reconnect screen offers the other boards of this computer', () => {
  beforeEach(() => {
    mocked.get.mockReset();
    mocked.post.mockReset();
  });
  afterEach(cleanup);

  it('lists the workspaces that are not the unreachable one, and opens one', async () => {
    mocked.get.mockImplementation(async (url: string) =>
      url === '/workspaces' ? workspaces() : Promise.reject(new Error('x')),
    );
    mocked.post.mockResolvedValue({ data: {} });
    show();
    const box = await screen.findByTestId('down-workspaces');
    expect(box.textContent).toContain('Home');
    expect(box.textContent).not.toContain('Office');
    fireEvent.click(screen.getByRole('button', { name: 'Home' }));
    await waitFor(() => expect(mocked.post).toHaveBeenCalledWith('/workspaces/h/switch'));
  });

  it('offers nothing while the environment decides the database', async () => {
    mocked.get.mockImplementation(async (url: string) =>
      url === '/workspaces' ? workspaces(false) : Promise.reject(new Error('x')),
    );
    show();
    await waitFor(() => expect(mocked.get).toHaveBeenCalledWith('/workspaces'));
    expect(screen.queryByTestId('down-workspaces')).toBeNull();
  });
});
