// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiRun } from '../../types/ai';
import type { AssistState } from '../../types/assist';

const http = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), post: vi.fn() }));
vi.mock('../../api/client', () => ({ client: http }));

import { ToastProvider } from '../Toast';
import { notReadyReason } from './AiFillPanel';
import { RetryLine } from './RunPanel';

afterEach(cleanup);

const wrap = (n: ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ToastProvider>{n}</ToastProvider>
  </QueryClientProvider>
);

const board = (o: Partial<AssistState['boardAi']>): AssistState['boardAi'] => ({
  state: 'unavailable',
  id: 'm1',
  name: 'Reviewer',
  provider: null,
  providerLabel: null,
  connection: 'local',
  metered: false,
  status: null,
  ...o,
});

describe('Ask AI to fill this in: why it cannot help', () => {
  it('names the real reason: no Board AI, paused for everyone, paused, offline', () => {
    expect(notReadyReason(undefined)).toContain('Choose a Board AI');
    expect(notReadyReason(board({ state: 'not_configured' }))).toContain('Choose a Board AI');
    expect(notReadyReason(board({ status: { code: 'paused_all', label: 'Paused', detail: null } }))).toBe(
      'Reviewer can’t help now: all AI is paused for this project.',
    );
    expect(notReadyReason(board({ status: { code: 'paused', label: 'Paused', detail: null } }))).toBe(
      'Reviewer can’t help now: it is paused.',
    );
    expect(
      notReadyReason(board({ status: { code: 'runner_missing', label: 'Offline', detail: 'CLI not found.' } })),
    ).toBe('Reviewer can’t help now (offline). CLI not found.');
  });
});

describe('A run the board tries again by itself', () => {
  const run = (o: Partial<AiRun>) =>
    ({
      id: 'r1',
      state: 'queued',
      retryAt: new Date(Date.now() + 120_000).toISOString(),
      retries: [{ at: '', kind: 'network', n: 2, of: 3, label: 'network', detail: 'ECONNRESET', delayS: 120 }],
      ...o,
    }) as AiRun;

  it('says what happened, when it tries again and which try, and stops on request', async () => {
    http.post.mockResolvedValue({ data: {} });
    render(wrap(<RetryLine run={run({})} />));
    expect(screen.getByTestId('run-retry-line').textContent).toBe(
      'Lost the connection. Trying again in 2 minutes — second of three.Stop trying',
    );
    fireEvent.click(screen.getByTestId('run-retry-stop'));
    await waitFor(() =>
      expect(http.post).toHaveBeenCalledWith('/ai/runs/r1/cancel', { reason: 'Stopped trying again' }),
    );
  });

  it('shows nothing once the wait is over or the run is not queued', () => {
    const { container } = render(
      wrap(
        <>
          <RetryLine run={run({ retryAt: new Date(Date.now() - 1000).toISOString() })} />
          <RetryLine run={run({ state: 'running' } as Partial<AiRun>)} />
        </>,
      ),
    );
    expect(container.querySelector('[data-testid="run-retry-line"]')).toBeNull();
  });
});
