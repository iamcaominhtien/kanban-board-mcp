// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const http = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../api/client', () => ({ client: http }));
// The AI lines of a ticket card have their own tests and their own queries
vi.mock('./ai/RunPanel', () => ({ CardAiFooter: () => null }));
vi.mock('./workflowBoard/WorkflowBoardContext', () => ({ WorkflowCardChip: () => null }));
vi.mock('./schedules/ScheduleTicketBlock', () => ({ ScheduleCardChip: () => null }));
vi.mock('./assist/BoardHealth', () => ({ CardInsightChip: () => null }));

import { TicketCard } from './TicketCard';
import { footerParts } from './TestCasesSection';
import type { Member, TestCase, Ticket } from '../types';

const wrap = (ui: ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {ui}
  </QueryClientProvider>
);
const ticket = (o: Partial<Ticket>): Ticket =>
  ({
    id: 'KAN-156',
    projectId: 'p1',
    title: 'Keyboard reorder support for columns',
    description: '',
    type: 'feature',
    status: 'review',
    priority: 'medium',
    tags: [],
    comments: [],
    acceptanceCriteria: [],
    subTasks: [],
    activityLog: [],
    workLog: [],
    testCases: [],
    blocks: [],
    blockedBy: [],
    createdAt: '',
    updatedAt: '',
    ...o,
  }) as Ticket;
const ha = { id: 'm-ha', name: 'Ha My', kind: 'person', color: '#5B5FA8' } as unknown as Member;
const members = new Map([[ha.id, ha]]);

afterEach(cleanup);

describe('A Review card names whose review it waits for (Main Board, Review column; issue #269)', () => {
  it('shows "Review requested — Name" with the member', () => {
    render(wrap(<TicketCard ticket={ticket({ reviewRequestedFrom: 'm-ha' })} memberMap={members} />));
    expect(screen.getByTestId('card-review-requested').textContent).toContain('Review requested — Ha My');
  });

  it('shows nothing outside Review or when nobody is asked', () => {
    render(
      wrap(<TicketCard ticket={ticket({ status: 'in-progress', reviewRequestedFrom: 'm-ha' })} memberMap={members} />),
    );
    expect(screen.queryByTestId('card-review-requested')).toBeNull();
    cleanup();
    render(wrap(<TicketCard ticket={ticket({})} memberMap={members} />));
    expect(screen.queryByTestId('card-review-requested')).toBeNull();
  });
});

describe('A test case footer says who (TestCases design; issue #269)', () => {
  const ago = new Date(Date.now() - 4 * 60_000).toISOString();
  const tc = (o: Partial<TestCase>): TestCase => ({ id: 't', title: 'x', status: 'running', ...o }) as TestCase;

  it('reads "Started 4m ago by Ha My" while running', () => {
    expect(footerParts(tc({ startedAt: ago, startedBy: 'Ha My' }))[0]).toMatch(/^Started 4m ago by Ha My$/);
  });

  it('reads "Failed … by" once failed, and keeps the last edit', () => {
    const parts = footerParts(tc({ status: 'fail', statusAt: ago, statusBy: 'Ha My', updatedAt: ago }));
    expect(parts[0]).toMatch(/^Failed 4m ago by Ha My$/);
    expect(parts[1]).toMatch(/^Last edited/);
  });

  it('never names the anonymous "user"', () => {
    expect(footerParts(tc({ startedAt: ago, startedBy: 'user' }))[0]).toMatch(/^Started 4m ago$/);
  });
});
