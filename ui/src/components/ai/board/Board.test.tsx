// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const http = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../../../api/client', () => ({ client: http }));

import { BoardAiSection } from './BoardAiSection';
import { SignalCards } from './SignalCards';
import { AiBoardContext, type AiBoardState } from '../aiUi';
import { AsksFirst, DoneReceipt, appliedWords } from '../../assist/DoneReceipt';
import type { AssistDraft } from '../../../types/assist';

const emptyBoard: AiBoardState = { projectId: 'p1', members: new Map(), runsByTicket: new Map(), settings: null };
const wrap = (ui: ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {ui}
  </QueryClientProvider>
);
const ok = (data: unknown) => Promise.resolve({ data });
const view = {
  acts: true,
  tiers: [
    { op: 'status', tier: 'undo', default: 'undo', locked: false },
    { op: 'comment', tier: 'free', default: 'undo', locked: false },
    { op: 'done', tier: 'ask', default: 'ask', locked: true },
  ],
  locked: ['done'],
  bulkTickets: 3,
};

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('BoardAiSection', () => {
  it('shows the tiers, greys the locked one and lowers a middle-tier action', async () => {
    http.get.mockReturnValue(ok(view));
    http.patch.mockReturnValue(ok(view));
    render(wrap(<BoardAiSection projectId="p1" />));
    await screen.findByTestId('board-ai-table');
    expect(screen.getByTestId('tier-row-done').getAttribute('data-locked')).toBe('true');
    expect(screen.getByTestId('tier-row-done').textContent).toContain('Fixed in the last tier');
    fireEvent.change(screen.getByLabelText('Tier of: Move a ticket to another column'), { target: { value: 'free' } });
    await waitFor(() =>
      expect(http.patch).toHaveBeenCalledWith('/projects/p1/ai/board-ai', { tiers: { status: 'free' } }),
    );
    fireEvent.click(screen.getByTestId('board-ai-acts'));
    await waitFor(() => expect(http.patch).toHaveBeenCalledWith('/projects/p1/ai/board-ai', { acts: false }));
  });

  it('says why a change was refused', async () => {
    http.get.mockReturnValue(ok(view));
    http.patch.mockRejectedValue({ response: { data: { detail: 'Done stays in the last tier.' } } });
    render(wrap(<BoardAiSection projectId="p1" />));
    fireEvent.click(await screen.findByTestId('board-ai-acts'));
    await screen.findByTestId('board-ai-error');
  });
});

describe('SignalCards', () => {
  const sig = (o: object) => ({
    kind: 'ai_failing',
    key: 'k1',
    ticketId: 'KAN-1',
    runId: 'r1',
    title: 'Three runs failed',
    detail: 'Same step',
    data: {},
    score: 1,
    action: 'Run it again',
    ...o,
  });

  it('retries a failing run', async () => {
    http.get.mockReturnValue(ok([sig({})]));
    http.post.mockReturnValue(ok({}));
    render(wrap(<SignalCards projectId="p1" />));
    fireEvent.click(await screen.findByText('Run it again'));
    await waitFor(() => expect(http.post).toHaveBeenCalledWith('/ai/runs/r1/retry', undefined));
  });

  it('answers a hung AI with the first action the diagnosis allows', async () => {
    http.get.mockReturnValue(
      ok([sig({ kind: 'ai_hang', action: 'Stop that command', data: { actions: ['stop_child', 'wait'] } })]),
    );
    http.post.mockReturnValue(ok({ done: true, text: 'Stopped.' }));
    render(wrap(<SignalCards projectId="p1" />));
    fireEvent.click(await screen.findByText('Stop that command'));
    await waitFor(() =>
      expect(http.post).toHaveBeenCalledWith('/ai/runs/r1/trouble', { action: 'stop_child', note: undefined }),
    );
    await screen.findByTestId('signal-note');
  });

  it('opens the accounts page from the quota card, and Leave it puts the card away', async () => {
    const openAiTab = vi.fn();
    http.get.mockReturnValue(
      ok([sig({ kind: 'quota_near', key: 'q1', ticketId: null, runId: null, action: 'Hold low-priority work' })]),
    );
    render(
      wrap(
        <AiBoardContext.Provider value={{ ...emptyBoard, openAiTab }}>
          <SignalCards projectId="p1" />
        </AiBoardContext.Provider>,
      ),
    );
    fireEvent.click(await screen.findByText('Open AI accounts'));
    expect(openAiTab).toHaveBeenCalledWith('accounts');
    fireEvent.click(screen.getByText('Leave it'));
    await waitFor(() => expect(screen.queryByTestId('signal-quota_near')).toBeNull());
  });

  it('offers the run and pausing the AI on a failing card', async () => {
    const members = new Map([['m1', { id: 'm1', name: 'Reviewer Rin' }]]);
    http.get.mockReturnValue(ok([sig({ memberId: 'm1' })]));
    http.post.mockReturnValue(ok({}));
    render(
      wrap(
        <AiBoardContext.Provider value={{ ...emptyBoard, members: members as never }}>
          <SignalCards projectId="p1" />
        </AiBoardContext.Provider>,
      ),
    );
    expect(await screen.findByText('Open the last run')).toBeTruthy();
    fireEvent.click(screen.getByText('Pause Reviewer Rin'));
    await waitFor(() => expect(http.post).toHaveBeenCalledWith('/ai/members/m1/pause', expect.anything()));
  });

  it('shows nothing when there are no signals', async () => {
    http.get.mockReturnValue(ok([]));
    render(wrap(<SignalCards projectId="p1" />));
    await waitFor(() => expect(screen.getByTestId('signal-cards').getAttribute('data-empty')).toBe('true'));
  });
});

describe('DoneReceipt', () => {
  it('lists the changes with Undo all', () => {
    const undo = vi.fn();
    const draft = {
      status: 'applied',
      appliedBy: 'An Nguyen',
      result: {
        count: 2,
        applied: [
          { i: 0, op: 'status', ticket: 'KAN-220', before: 'todo', after: 'in-progress' },
          { i: 1, op: 'depth', ticket: 'KAN-223', before: 'normal', after: 'deep' },
        ],
      },
    } as unknown as AssistDraft;
    render(<DoneReceipt draft={draft} busy={false} onUndo={undo} />);
    expect(screen.getByText('Done — 2 changes')).toBeTruthy();
    expect(screen.getAllByTestId('done-row')).toHaveLength(2);
    fireEvent.click(screen.getByText('Undo all 2'));
    expect(undo).toHaveBeenCalled();
    expect(appliedWords({ op: 'status', after: 'in-progress' })).toBe('moved to In Progress');
  });

  it('says which change was refused and why, and offers to undo the rest', () => {
    const draft = {
      status: 'applied',
      appliedBy: 'An Nguyen',
      result: {
        count: 1,
        applied: [{ i: 0, op: 'status', ticket: 'KAN-220', before: 'todo', after: 'in-progress' }],
        errors: [{ i: 1, ticket: 'KAN-219', message: 'Done asks first.' }],
      },
    } as unknown as AssistDraft;
    render(<DoneReceipt draft={draft} busy={false} onUndo={vi.fn()} />);
    const t = screen.getByTestId('done-refused').textContent ?? '';
    expect(t).toContain('1 of 2 went through.');
    expect(t).toContain('was refused: Done asks first.');
    expect(t).toContain('Undo puts it back.');
  });

  it('names the ask-first card the way the design does', () => {
    render(<AsksFirst reasons={['Moving KAN-219 to Done asks first']} />);
    expect(screen.getByText('One thing I will not do without you')).toBeTruthy();
  });
});
