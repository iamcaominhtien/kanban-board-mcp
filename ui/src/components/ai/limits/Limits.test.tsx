// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ticket } from '../../../types';
import type { AiRun } from '../../../types/ai';
import type { ViewStep, WorkflowView } from '../../../types/aiWorkflow';
import type { WorkflowBoardRow } from '../../../types/aiWorkflowBoard';

const http = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../../../api/client', () => ({ client: http }));

import { workflowBoardKeys } from '../../../api/aiWorkflowBoard';
import { AiBoardContext } from '../aiUi';
import { CapStoppedCard } from './CapStoppedCard';
import { CardCapLine, WaitsFor, WaitsForStopped } from './CardLimits';
import { kTokens, parseCapDetail, tokensPerStep } from './capModel';

const ok = (data: unknown) => Promise.resolve({ data });
const DETAIL = 'Used 412,380 tokens; the cap for one ticket is 400,000.';

const vs = (o: Partial<ViewStep> & { key: string; idx: number }): ViewStep => ({
  id: `s${o.idx}`,
  label: o.key,
  kind: 'ai',
  role: 'dev',
  state: 'done',
  attempt: 1,
  memberId: null,
  memberName: null,
  runId: null,
  note: null,
  noteIn: null,
  outcome: null,
  result: null,
  startedAt: null,
  endedAt: null,
  ...o,
});

const stopped: WorkflowView = {
  ticketId: 'KAN-305',
  templateKey: 'standard',
  templateName: 'Standard feature',
  templateVersion: 1,
  state: 'stopped',
  stopReason: 'quota_cap',
  stopDetail: DETAIL,
  reviewDepth: null,
  depthBy: null,
  depthNote: null,
  rounds: {},
  split: [],
  rulings: [],
  objections: [],
  steps: [
    vs({ key: 'triage', idx: 0, label: 'Triage', role: 'triage', runId: 'r0' }),
    vs({ key: 'build', idx: 1, label: 'Build', state: 'active', memberName: 'Dev Khoa', runId: 'r1' }),
    vs({ key: 'done', idx: 2, label: 'Done', kind: 'person', role: null, state: 'pending' }),
  ],
};
const runs = [
  { id: 'r0', mode: 'work', tokensIn: 8000, tokensOut: 1200 },
  { id: 'r1', mode: 'work', tokensIn: 350000, tokensOut: 12000 },
] as unknown as AiRun[];
const ticket = { id: 'KAN-305', projectId: 'p1', status: 'in-progress', parentId: 'KAN-301' } as unknown as Ticket;
const row = (o: Partial<WorkflowBoardRow>): WorkflowBoardRow => ({
  ticketId: 'KAN-305',
  templateKey: 'standard',
  templateName: 'Standard feature',
  state: 'active',
  stopReason: null,
  reviewDepth: null,
  step: 'Build',
  stepKind: 'ai',
  role: 'dev',
  holderId: null,
  holderName: null,
  waitsForPerson: false,
  ...o,
});

let openTicket: ReturnType<typeof vi.fn>;

function mount(ui: ReactNode, rows: WorkflowBoardRow[] = []) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(workflowBoardKeys.board('p1'), rows);
  return render(
    <QueryClientProvider client={qc}>
      <AiBoardContext.Provider
        value={{ projectId: 'p1', members: new Map(), runsByTicket: new Map(), settings: null, openTicket }}
      >
        {ui}
      </AiBoardContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  openTicket = vi.fn();
  http.get.mockImplementation((url: string) => {
    if (url.endsWith('/ai/workflow')) return ok(stopped);
    if (url.endsWith('/ai/runs')) return ok(runs);
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
  http.post.mockImplementation(() => ok(stopped));
  http.delete.mockImplementation(() => ok(null));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the cap model', () => {
  it('reads used and cap from the stop sentence and writes them short', () => {
    expect(parseCapDetail(DETAIL)).toEqual({ used: 412380, cap: 400000 });
    expect(parseCapDetail('Something else')).toBeNull();
    expect(kTokens(412380)).toBe('412k');
    expect(kTokens(9100)).toBe('9k');
    expect(kTokens(2_000_000)).toBe('2M');
    expect(kTokens(850)).toBe('850');
  });

  it('adds the tokens of each step from its runs', () => {
    expect(tokensPerStep(stopped, runs)).toEqual([
      { label: 'Triage', tokens: 9200 },
      { label: 'Build', tokens: 362000 },
    ]);
  });
});

describe('the card in the ticket', () => {
  it('says what it used, who held it, and the facts beside', async () => {
    mount(<CapStoppedCard ticket={ticket} view={stopped} story={{ id: 'KAN-301', title: 'Weather app' }} />);
    const card = screen.getByTestId('cap-stopped-card');
    expect(card.textContent).toContain('Stopped at its token cap');
    expect(card.textContent).toContain(DETAIL);
    expect(card.textContent).toContain('Dev Khoa stopped at the end of its turn');
    expect(card.textContent).toContain('the ticket sits in In Progress');
    expect(within(card).getByTestId('cap-tokens').textContent).toContain('412,380');
    await waitFor(() => expect(within(card).getByTestId('cap-tokens').textContent).toContain('Triage 9k, Build 362k'));
    fireEvent.click(within(card).getByRole('button', { name: /KAN-301/ }));
    expect(openTicket).toHaveBeenCalledWith('KAN-301');
  });

  it('resumes with the same cap', async () => {
    mount(<CapStoppedCard ticket={ticket} view={stopped} />);
    fireEvent.click(screen.getByTestId('cap-resume'));
    await waitFor(() => expect(http.post).toHaveBeenCalledWith('/tickets/KAN-305/ai/workflow/resume'));
  });

  it('raises the cap only above what it used', async () => {
    mount(<CapStoppedCard ticket={ticket} view={stopped} />);
    fireEvent.click(screen.getByTestId('cap-raise-open'));
    const form = screen.getByTestId('cap-raise');
    const input = within(form).getByRole('textbox');
    const go = within(form).getByRole('button', { name: 'Raise and resume' });
    fireEvent.change(input, { target: { value: '400,000' } });
    expect(go).toHaveProperty('disabled', true);
    expect(form.textContent).toContain('Set a cap above what it already used (412,380)');
    fireEvent.change(input, { target: { value: '600,000' } });
    fireEvent.click(go);
    await waitFor(() => expect(http.post).toHaveBeenCalledWith('/tickets/KAN-305/ai/workflow/resume', { cap: 600000 }));
  });

  it('stops the ticket after a confirmation', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    mount(<CapStoppedCard ticket={ticket} view={stopped} />);
    fireEvent.click(screen.getByTestId('cap-stop'));
    expect(http.delete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('cap-stop'));
    await waitFor(() => expect(http.delete).toHaveBeenCalledWith('/tickets/KAN-305/ai/workflow'));
    confirm.mockRestore();
  });
});

describe('on the board card', () => {
  it('shows a ticket stopped at its cap with its numbers and Resume', async () => {
    const onCard = vi.fn();
    mount(
      <div onClick={onCard}>
        <CardCapLine ticketId="KAN-305" />
      </div>,
      [row({ state: 'stopped', stopReason: 'quota_cap' })],
    );
    expect(screen.getByTestId('card-cap-stopped').textContent).toContain('Stopped at its token cap');
    expect((await screen.findByTestId('card-cap-numbers')).textContent).toBe('412k of 400k');
    fireEvent.click(screen.getByTestId('card-cap-resume'));
    expect(onCard).not.toHaveBeenCalled();
    await waitFor(() => expect(http.post).toHaveBeenCalledWith('/tickets/KAN-305/ai/workflow/resume'));
  });

  it('draws nothing for a ticket that did not stop at its cap', () => {
    const { container } = mount(<CardCapLine ticketId="KAN-305" />, [row({ state: 'stopped', stopReason: 'split' })]);
    expect(container.textContent).toBe('');
  });

  it('says a ticket waits for one that is stopped, with a click to it', () => {
    mount(
      <>
        <WaitsFor ids={['KAN-305', 'KAN-307']} />
        <WaitsForStopped ids={['KAN-305', 'KAN-307']} />
      </>,
      [row({ state: 'stopped', stopReason: 'quota_cap' }), row({ ticketId: 'KAN-307' })],
    );
    expect(document.body.textContent).toContain('waits for KAN-305, which is stopped, KAN-307');
    expect(screen.getAllByTestId('card-waits-for-stopped')).toHaveLength(1);
    fireEvent.click(screen.getAllByRole('button', { name: 'KAN-305' })[0]);
    expect(openTicket).toHaveBeenCalledWith('KAN-305');
  });
});
