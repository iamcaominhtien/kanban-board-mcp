// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CapNeed, CapStop } from '../../api/aiTeam';
import type { NeedsItem, TeamCard, TeamNow } from '../../types/aiTeam';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../api/client', () => ({ client: http }));

import { ToastProvider } from '../Toast';
import { NowTab, type NowActions } from './NowTab';

const capStop: CapStop = {
  ticketId: 'KAN-305',
  ticketTitle: 'Save favourite cities',
  used: 412_380,
  cap: 400_000,
  step: { n: 3, total: 7, label: 'Build' },
  stoppedAt: new Date(Date.now() - 14 * 60_000).toISOString(),
  runId: null,
  next: { ticketId: 'KAN-306', waitsFor: 'KAN-305' },
};

const card = {
  id: 'm1',
  name: 'Dev Khoa',
  color: '#2E6F40',
  glyph: null,
  provider: 'claude',
  providerLabel: 'Claude Code',
  connection: 'local',
  model: 'Sonnet',
  state: 'idle',
  status: { code: 'idle', label: 'Idle', detail: null },
  connectionUnknown: false,
  paused: false,
  pause: null,
  current: null,
  queued: [],
  assigned: [],
  last: null,
  usage: { runs: 0, ok: 0, failed: 0, metered: false },
  spark: [0, 0],
  capStop,
} as unknown as TeamCard;

const need: CapNeed = {
  kind: 'quota_cap',
  since: capStop.stoppedAt,
  waitingS: 14 * 60,
  memberId: 'm1',
  memberName: 'Dev Khoa',
  ticketId: 'KAN-305',
  ticketTitle: 'Save favourite cities',
  used: 412_380,
  cap: 400_000,
  waitedBy: ['KAN-306'],
  storyId: 'KAN-301',
};

const data = {
  range: 'today',
  since: '',
  generatedAt: '',
  pausedAll: false,
  members: [card],
  counts: { idle: 1 },
  needsYou: [need as unknown as NeedsItem],
  restartedRuns: 0,
  handoffs: [],
  totals: {
    runs: 0,
    ok: 0,
    failed: 0,
    running: 0,
    spentUsd: 0,
    dailyCap: null,
    touches: 0,
    autopilot: { on: false, delegate: null, graceMin: 5, decided: 0 },
  },
  docsProposalsHeld: false,
} as TeamNow;

let actions: NowActions;
beforeEach(() => {
  vi.clearAllMocks();
  http.post.mockResolvedValue({ data: {} });
  actions = {
    onOpenTicket: vi.fn(),
    onOpenMember: vi.fn(),
    onOpenDocsPage: vi.fn(),
    onSeeFlow: vi.fn(),
    onSeeResources: vi.fn(),
  };
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <NowTab data={data} range="today" actions={actions} />
      </ToastProvider>
    </QueryClientProvider>,
  );
});
afterEach(cleanup);

describe('Now: a ticket stopped at its token cap (O)', () => {
  it('shows the Needs you row with Resume and Open ticket', async () => {
    const row = screen.getByTestId('needs-quota_cap');
    expect(row.textContent).toContain('KAN-305 reached its token cap');
    expect(row.textContent).toContain('Dev Khoa used 412,380 of 400,000 tokens on Save favourite cities');
    expect(row.textContent).toContain('waiting 14 min · KAN-306 waits for it · Story KAN-301');
    fireEvent.click(within(row).getByText('Open ticket'));
    expect(actions.onOpenTicket).toHaveBeenCalledWith('KAN-305');
    fireEvent.click(within(row).getByText('Resume'));
    await waitFor(() => expect(http.post.mock.calls[0][0]).toBe('/tickets/KAN-305/ai/workflow/resume'));
  });

  it('shows the AI as Stopped at cap, with what is next in line', () => {
    expect(screen.getByTestId('capped-count').textContent).toContain('Stopped at a limit 1');
    const c = screen.getByTestId('team-card-idle');
    expect(within(c).getByTestId('stopped-at-cap')).toBeTruthy();
    expect(c.textContent).toContain('Build, step 3 of 7 · stopped 14 min ago');
    expect(c.textContent).toContain('412k of 400k tokens for this ticket');
    expect(c.textContent).toContain('Next in line: KAN-306 (waits for KAN-305)');
    fireEvent.click(within(c).getByText('Open run'));
    expect(actions.onOpenTicket).toHaveBeenCalledWith('KAN-305');
  });
});
