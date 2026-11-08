// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardRun } from '../../../types/ai';

const http = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../../../api/client', () => ({ client: http }));
const runLink = vi.hoisted(() => ({ openRun: vi.fn() }));
vi.mock('../../aiteam/runLink', () => runLink);

import { AiBoardContext } from '../aiUi';
import { KeepAwakeChip } from './KeepAwakeChip';

const ok = (data: unknown) => Promise.resolve({ data });
let active: number;
let awake: boolean;
const setKeepAwake = vi.fn(async (on: boolean) => {
  awake = on;
  return on;
});

const run = (runId: string, memberId: string, ticketId: string, state = 'running') =>
  ({ runId, memberId, ticketId, state }) as unknown as BoardRun;
const team = (id: string, name: string) => [id, { id, name, kind: 'ai' }] as const;

beforeEach(() => {
  vi.clearAllMocks();
  active = 2;
  awake = true;
  http.get.mockImplementation((url: string) =>
    url === '/ai/power' ? ok({ active }) : Promise.reject(new Error(`unexpected GET ${url}`)),
  );
  window.electronAPI = {
    getBackendPort: async () => 8000,
    platform: 'darwin',
    getKeepAwake: async () => awake,
    setKeepAwake,
  };
});
afterEach(() => {
  cleanup();
  delete window.electronAPI;
});

const mount = (props: { onSeeRunHistory?: () => void } = {}) => {
  const runsByTicket = new Map([
    ['KAN-305', run('r1', 'm1', 'KAN-305')],
    ['KAN-304', run('r2', 'm2', 'KAN-304', 'starting')],
    ['KAN-300', run('r3', 'm3', 'KAN-300', 'finished')],
  ]);
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AiBoardContext.Provider
        value={{
          projectId: 'p1',
          members: new Map([team('m1', 'Dev Khoa'), team('m2', 'Reviewer Binh'), team('m3', 'QA Mai')]) as never,
          runsByTicket,
          settings: null,
        }}
      >
        <KeepAwakeChip {...props} />
      </AiBoardContext.Provider>
    </QueryClientProvider>,
  );
};

describe('KeepAwakeChip', () => {
  it('is quiet green with the number of runs while it holds the computer awake', async () => {
    mount();
    const chip = await screen.findByTestId('keep-awake-chip');
    expect(chip.textContent).toBe('Awake · 2 runs');
    expect(chip.className).toContain('ka-on');
  });

  it('is amber when the switch is off and a run is going', async () => {
    awake = false;
    mount();
    const chip = await screen.findByTestId('keep-awake-chip');
    expect(chip.textContent).toBe('Keep awake is off');
    expect(chip.className).toContain('ka-off');
  });

  it('draws nothing when nothing runs', async () => {
    active = 0;
    const { container } = mount();
    await waitFor(() => expect(http.get).toHaveBeenCalledWith('/ai/power'));
    await act(async () => {});
    expect(container.textContent).toBe('');
  });

  it('draws nothing in the web build, and does not ask the server', async () => {
    delete window.electronAPI;
    const { container } = mount();
    await act(async () => {});
    expect(container.textContent).toBe('');
    expect(http.get).not.toHaveBeenCalled();
  });

  it('opens the runs and the switch, which turns Keep awake off', async () => {
    mount();
    fireEvent.click(await screen.findByTestId('keep-awake-chip'));
    const pop = screen.getByTestId('keep-awake-pop');
    expect(pop.textContent).toContain('Keeping this computer awake');
    expect(pop.textContent).toContain('2 AI runs are going: Dev Khoa on KAN-305, Reviewer Binh on KAN-304.');
    const sw = screen.getByTestId('keep-awake-switch');
    expect(sw.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(sw);
    await waitFor(() => expect(setKeepAwake).toHaveBeenCalledWith(false));
    await waitFor(() => expect(screen.getByTestId('keep-awake-chip').textContent).toBe('Keep awake is off'));
  });

  it('goes to Run history', async () => {
    const see = vi.fn();
    mount({ onSeeRunHistory: see });
    fireEvent.click(await screen.findByTestId('keep-awake-chip'));
    fireEvent.click(screen.getByRole('button', { name: 'See Run history' }));
    expect(see).toHaveBeenCalled();
    expect(screen.queryByTestId('keep-awake-pop')).toBeNull();
  });

  it('opens a running run in Run history when no handler is given', async () => {
    mount();
    fireEvent.click(await screen.findByTestId('keep-awake-chip'));
    fireEvent.click(screen.getByRole('button', { name: 'See Run history' }));
    expect(runLink.openRun).toHaveBeenCalledWith('r1');
  });

  it('closes on Escape', async () => {
    mount();
    fireEvent.click(await screen.findByTestId('keep-awake-chip'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('keep-awake-pop')).toBeNull();
  });
});
