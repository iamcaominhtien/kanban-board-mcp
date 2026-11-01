// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const c = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock('../../api/client', () => ({ client: c }));

import { FollowBell } from './FollowBell';

function state(level: string | null, until: string | null = null) {
  return { scope: 'ticket', scopeId: 'KAN-1', level, until, id: level ? 'f1' : null };
}

function setup(scope: 'ticket' | 'page' = 'ticket') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <FollowBell scope={scope} scopeId="KAN-1" projectId="p1" />
    </QueryClientProvider>,
  );
}

async function open() {
  const bell = await screen.findByTestId('follow-bell');
  await waitFor(() => expect(c.get).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 0));
  fireEvent.click(bell);
  return screen.getByRole('menu');
}

describe('FollowBell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    c.get.mockResolvedValue({ data: state(null) });
    c.put.mockImplementation(async (_u: string, b: { level: string | null }) => ({ data: state(b.level) }));
  });
  afterEach(cleanup);

  it('opens the menu and closes on Escape and outside click', async () => {
    setup();
    await open();
    expect(screen.getByText('This ticket')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    await open();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it.each([
    ['Follow', 'follow'],
    ['Everything', 'everything'],
    ['Only mentions and questions', 'mentions'],
    ['Muted', 'mute'],
  ])('%s PUTs level %s', async (name, level) => {
    setup();
    await open();
    fireEvent.click(screen.getByText(name));
    await waitFor(() =>
      expect(c.put).toHaveBeenCalledWith('/notifications/follow', {
        scope: 'ticket',
        scopeId: 'KAN-1',
        level,
        projectId: 'p1',
      }),
    );
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('mutes for one hour', async () => {
    setup('page');
    await open();
    expect(screen.getByText('This page')).toBeTruthy();
    fireEvent.click(screen.getByText('Mute for 1 hour'));
    await waitFor(() =>
      expect(c.put).toHaveBeenCalledWith(
        '/notifications/follow',
        expect.objectContaining({ scope: 'page', level: 'mute', minutes: 60 }),
      ),
    );
  });

  it('looks followed and offers to forget', async () => {
    c.get.mockResolvedValue({ data: state('follow') });
    setup();
    await waitFor(() => expect(screen.getByLabelText('Following this ticket')).toBeTruthy());
    fireEvent.click(screen.getByTestId('follow-bell'));
    expect(screen.getByText('Following')).toBeTruthy();
    expect(screen.getByText(/Because you started a run/)).toBeTruthy();
    fireEvent.click(screen.getByText('Following'));
    await waitFor(() =>
      expect(c.put).toHaveBeenCalledWith('/notifications/follow', expect.objectContaining({ level: null })),
    );
  });

  it('looks muted', async () => {
    c.get.mockResolvedValue({ data: state('mute') });
    setup();
    await waitFor(() => expect(screen.getByLabelText('Muted: notifications of this ticket')).toBeTruthy());
    expect(screen.getByTestId('follow-bell').getAttribute('title')).toBe('Muted');
  });

  it('shows a timed mute and clears it', async () => {
    c.get.mockResolvedValue({ data: state('mute', new Date(Date.now() + 3600_000).toISOString()) });
    setup();
    await waitFor(() => expect(screen.getByLabelText(/Muted/)).toBeTruthy());
    fireEvent.click(screen.getByTestId('follow-bell'));
    expect(screen.getByText(/^Until /)).toBeTruthy();
    fireEvent.click(screen.getByText('Mute for 1 hour'));
    await waitFor(() =>
      expect(c.put).toHaveBeenCalledWith('/notifications/follow', expect.objectContaining({ level: null })),
    );
  });

  it('shows an error when the change fails', async () => {
    c.put.mockRejectedValue(new Error('x'));
    setup();
    await open();
    fireEvent.click(screen.getByText('Everything'));
    await screen.findByText('Could not change this. Try again.');
  });
});
