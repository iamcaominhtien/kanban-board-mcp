// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const http = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../../api/client', () => ({ client: http }));

import type { IdeaAdvice, IdeaAiStatus } from '../../api/ideaAi';
import type { Idea } from '../../types/idea';
import { ToastProvider } from '../Toast';
import { AdviceBar, AskPanel, RowAdvice } from './IdeaAiExtras';
import { ShapePanel } from './IdeaAiPanel';
import { KeepDialog } from './TriageDialogs';

const ok = (data: unknown) => Promise.resolve({ data });

const status = (state: IdeaAiStatus['state'] = 'on'): IdeaAiStatus => ({
  state,
  message: '',
  settings: {
    enabled: state !== 'off',
    triageAdvice: true,
    weeklyGrooming: true,
    ask: true,
    readDocs: true,
    readRepo: false,
    dailyCap: 1,
  },
  member: 'Claude Code',
  spentToday: 0,
  cap: 1,
  limited: false,
  hints: { advice: 0.002, shape: 0.01, exists: 0.01, grooming: 0.01, ask: 0.01, ticket: 0.01 },
});

const idea = (over: Partial<Idea> = {}): Idea =>
  ({
    id: 'IDEA-1',
    projectId: 'p1',
    title: 'Show cost on the run card',
    description: '',
    stage: 'inbox',
    body: '',
    tags: [],
    assumptions: [],
    commentCount: 0,
    ...over,
  }) as Idea;

const advice = (over: Partial<IdeaAdvice>): IdeaAdvice => ({
  id: `adv-${over.ideaId}`,
  ideaId: 'IDEA-1',
  action: 'keep',
  reason: 'Clear and small',
  confidence: 'high',
  targetId: null,
  targetTitle: null,
  archiveReason: null,
  parkDays: null,
  cost: 0.001,
  createdAt: '2026-11-02T00:00:00Z',
  stale: false,
  ...over,
});

let aiState: IdeaAiStatus['state'] = 'on';
let adviceRows: IdeaAdvice[] = [];

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>{node}</ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  aiState = 'on';
  adviceRows = [];
  for (const f of Object.values(http)) f.mockReset();
  http.get.mockImplementation((url: string) => {
    if (url.endsWith('/status')) return ok(status(aiState));
    if (url.endsWith('/advice')) return ok(adviceRows);
    if (url === '/projects') return ok([{ id: 'p1', name: 'Kanban Board', prefix: 'KAN', color: '#2E6F40' }]);
    return ok([]);
  });
});
afterEach(cleanup);

describe('Keep: ask an AI member for a problem statement and assumptions (ICT-5)', () => {
  it('is hidden while AI help is off', async () => {
    aiState = 'off';
    wrap(<KeepDialog idea={idea()} onClose={() => {}} onDone={() => {}} />);
    await waitFor(() => expect(http.get).toHaveBeenCalledWith('/api/idea-ai/status', expect.anything()));
    expect(screen.queryByTestId('keep-suggest')).toBeNull();
  });

  it('is off by default: Keep moves the idea and asks nothing', async () => {
    http.post.mockImplementation(() => ok(idea({ stage: 'exploring' })));
    const done = vi.fn();
    wrap(<KeepDialog idea={idea()} onClose={() => {}} onDone={done} />);
    const sw = (await screen.findByTestId('keep-suggest')) as HTMLInputElement;
    expect(sw.checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(http.post.mock.calls.map((c) => c[0])).toEqual(['/api/idea-tickets/IDEA-1/stage']);
  });

  it('when on, Keep starts the same Shape requests as Shape with AI', async () => {
    http.post.mockImplementation((url: string, body: { kind?: string }) =>
      url.endsWith('/shape')
        ? ok({ kind: body.kind, ai: true, member: 'Claude Code', memberId: 'm', cost: 0.01, problem: 'P', idea: 'I' })
        : ok(idea({ stage: 'exploring' })),
    );
    wrap(<KeepDialog idea={idea()} onClose={() => {}} onDone={() => {}} />);
    fireEvent.click(await screen.findByTestId('keep-suggest'));
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    await waitFor(() => expect(http.post.mock.calls.filter((c) => c[0].endsWith('/shape'))).toHaveLength(2));
    const kinds = http.post.mock.calls.filter((c) => c[0] === '/api/idea-ai/shape').map((c) => c[1].kind);
    expect(kinds).toEqual(['problem', 'assumptions']);
    expect(await screen.findByText(/Suggestions ready/)).toBeTruthy();
  });

  it('says so when the suggestion could not be made, and the idea stays kept', async () => {
    http.post.mockImplementation((url: string) =>
      url.endsWith('/shape')
        ? Promise.reject({ response: { status: 409, data: { detail: { code: 'failed', message: 'No answer' } } } })
        : ok(idea({ stage: 'exploring' })),
    );
    wrap(<KeepDialog idea={idea()} onClose={() => {}} onDone={() => {}} />);
    fireEvent.click(await screen.findByTestId('keep-suggest'));
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(await screen.findByText('The AI suggestion could not be made')).toBeTruthy();
    expect(screen.getByText(/kept as Exploring without a suggestion/)).toBeTruthy();
  });
});

describe('Shape with AI: Stop (IP-16)', () => {
  it('a request can be stopped; nothing is drafted and it can be tried again', async () => {
    let fail: (e: unknown) => void = () => {};
    http.post.mockImplementation((url: string) => {
      if (url.endsWith('/stop')) {
        fail({
          response: {
            status: 409,
            data: { detail: { code: 'stopped', message: 'Stopped. Nothing was drafted or changed.' } },
          },
        });
        return ok({ stopped: true });
      }
      return new Promise((_r, reject) => (fail = reject));
    });
    wrap(
      <ShapePanel
        idea={idea({ stage: 'exploring' })}
        onClose={() => {}}
        onOpenIdea={() => {}}
        onOpenTicket={() => {}}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Draft the problem and the idea/ }));
    await waitFor(() => expect(http.post.mock.calls.some((c) => c[0] === '/api/idea-ai/shape')).toBe(true));
    const shapeCall = http.post.mock.calls.find((c) => c[0] === '/api/idea-ai/shape');
    const requestId = shapeCall?.[1].requestId as string;
    expect(requestId).toMatch(/^shape-/);
    fireEvent.click(await screen.findByTestId('shape-stop'));
    await waitFor(() => expect(http.post).toHaveBeenCalledWith(`/api/idea-ai/shape/${requestId}/stop`));
    expect((await screen.findByTestId('shape-stopped')).textContent).toContain('Stopped');
    expect(within(screen.getByTestId('shape-stopped')).getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('Triage advice (IAI-1)', () => {
  it('shows "No suggestion: not sure" for an idea the AI was not sure about', async () => {
    adviceRows = [advice({ ideaId: 'IDEA-2', action: 'none', reason: 'Too little to go on', confidence: 'low' })];
    wrap(<RowAdvice projectId="p1" ideaId="IDEA-2" ideaIds={['IDEA-2']} onAccept={() => {}} />);
    expect((await screen.findByTestId('row-not-sure-IDEA-2')).textContent).toBe('No suggestion: not sure');
    expect(screen.queryByRole('button', { name: /Accept/ })).toBeNull();
    const get = http.get.mock.calls.find((c) => c[0] === '/api/idea-ai/advice');
    expect(get?.[1].params.include_none).toBe(true);
  });

  it('"Accept Merge and Park" lists every move in one confirmation, then makes each', async () => {
    adviceRows = [
      advice({ ideaId: 'IDEA-1', action: 'merge', targetId: 'IDEA-9', targetTitle: 'Show cost on every run card' }),
      advice({ ideaId: 'IDEA-2', action: 'park', parkDays: 30 }),
      advice({ ideaId: 'IDEA-3', action: 'archive', archiveReason: 'already_exists' }),
      advice({ ideaId: 'IDEA-4', action: 'none' }),
    ];
    http.post.mockImplementation(() => ok(idea()));
    wrap(
      <AdviceBar
        projectId="p1"
        ideaIds={['IDEA-1', 'IDEA-2', 'IDEA-3', 'IDEA-4']}
        titles={{ 'IDEA-1': 'Cost on the card', 'IDEA-2': 'Voice notes' }}
      />,
    );
    const bulk = await screen.findByTestId('bulk-accept');
    expect(bulk.textContent).toContain('Accept Merge and Park');
    expect(screen.getByText(/3 suggestions/)).toBeTruthy();
    fireEvent.click(bulk);
    const moves = screen.getByTestId('bulk-accept-moves');
    expect(moves.textContent).toContain('Merge “Cost on the card” into “Show cost on every run card”');
    expect(moves.textContent).toContain('Park “Voice notes” until');
    expect(moves.textContent).not.toContain('IDEA-3'); // archive is one by one
    expect(http.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('bulk-accept-confirm'));
    await waitFor(() => expect(http.post).toHaveBeenCalledWith('/api/idea-tickets/IDEA-1/merge', { intoId: 'IDEA-9' }));
    await waitFor(() =>
      expect(http.post).toHaveBeenCalledWith(
        '/api/idea-tickets/IDEA-2/stage',
        expect.objectContaining({ to: 'parked', via: 'Park' }),
      ),
    );
  });
});

describe('Ask about ideas: answer actions (IAI-3)', () => {
  it('"Create test ticket" opens the create dialog filled in, and creates only on Create', async () => {
    const onOpenIdea = vi.fn();
    http.post.mockImplementation((url: string) => {
      if (url === '/api/idea-ai/ask')
        return ok({
          answer: 'Test the price table next.',
          sources: [],
          ideasRead: 3,
          member: 'Claude Code',
          cost: 0.01,
          actions: [
            {
              kind: 'create_test_ticket',
              ideaId: 'IDEA-1',
              ideaTitle: 'Show cost',
              assumptionId: 'as1',
              assumptionText: 'The price table can be kept up to date',
              title: 'Test: price table',
            },
            { kind: 'open_idea', ideaId: 'IDEA-1', ideaTitle: 'Show cost' },
          ],
        });
      return ok({ idea: idea(), ticket: { id: 'KAN-9' } });
    });
    wrap(<AskPanel projectId="p1" scope="project" onClose={() => {}} onOpenIdea={onOpenIdea} />);
    fireEvent.click(await screen.findByRole('button', { name: 'What should we test next?' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open the idea' }));
    expect(onOpenIdea).toHaveBeenCalledWith('IDEA-1');
    fireEvent.click(screen.getByRole('button', { name: 'Create test ticket' }));
    const dialog = screen.getByRole('dialog', { name: 'Create a test ticket' });
    expect((within(dialog).getByLabelText('Title') as HTMLInputElement).value).toBe('Test: price table');
    expect(http.post.mock.calls.some((c) => String(c[0]).includes('test-ticket'))).toBe(false);
    fireEvent.click(within(dialog).getByTestId('create-test-confirm'));
    await waitFor(() =>
      expect(http.post).toHaveBeenCalledWith('/api/idea-tickets/IDEA-1/assumption-records/as1/test-ticket', {
        title: 'Test: price table',
        assignee: undefined,
      }),
    );
  });

  it('an answer from before has no action buttons', async () => {
    http.post.mockImplementation(() =>
      ok({ answer: 'Nothing to add.', sources: [], ideasRead: 1, member: 'Claude Code', cost: 0 }),
    );
    wrap(<AskPanel projectId="p1" scope="project" onClose={() => {}} onOpenIdea={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'What should we test next?' }));
    expect(await screen.findByText('Nothing to add.')).toBeTruthy();
    expect(screen.queryByTestId('ask-actions')).toBeNull();
  });
});
