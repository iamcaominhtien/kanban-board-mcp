// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ticket } from '../../../types';
import type { AiMember } from '../../../types/ai';
import type { ViewStep, WorkflowStep, WorkflowTemplate, WorkflowView } from '../../../types/aiWorkflow';

const http = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../../../api/client', () => ({ client: http }));

import { AiBoardContext } from '../aiUi';
import { TicketWorkflow } from './TicketWorkflow';
import { missingRoles } from './WorkflowPicker';

const ok = (data: unknown) => Promise.resolve({ data });
const ticket = { id: 'KAN-319', projectId: 'p1', title: 'Bump the version' } as unknown as Ticket;
const ai = (id: string, name: string, role: string) =>
  ({ id, name, kind: 'ai', config: { role } }) as unknown as AiMember;

const vs = (o: Partial<ViewStep> & { key: string; idx: number }): ViewStep => ({
  id: `s${o.idx}`,
  label: o.key,
  kind: 'ai',
  role: 'dev',
  state: 'pending',
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
const step = (s: Partial<WorkflowStep>): WorkflowStep => ({
  key: 'x',
  label: 'X',
  kind: 'ai',
  role: 'dev',
  handsIn: '',
  gives: ['ticket'],
  model: null,
  effort: null,
  retryModel: null,
  depth: null,
  ...s,
});
const templates: WorkflowTemplate[] = [
  {
    key: 'quick_fix',
    name: 'Quick fix',
    description: 'A bug with an obvious cause',
    version: 1,
    builtin: true,
    personStops: 1,
    warning: null,
    steps: [
      step({ key: 'triage', label: 'Triage', role: 'triage' }),
      step({ key: 'fix', label: 'Fix' }),
      step({ key: 'checks', label: 'Checks', kind: 'code', role: null }),
      step({ key: 'review', label: 'Review', role: 'reviewer', depth: 'light' }),
      step({ key: 'done', label: 'Done', kind: 'person', role: null }),
    ],
  },
  {
    key: 'feature_ui',
    name: 'Feature with a UI',
    description: 'Anything a person will look at',
    version: 1,
    builtin: true,
    personStops: 2,
    warning: null,
    steps: [
      step({ key: 'triage', label: 'Triage', role: 'triage' }),
      step({ key: 'design', label: 'Design', role: 'designer' }),
      step({ key: 'approve', label: 'You approve', kind: 'person', role: null }),
      step({ key: 'build', label: 'Build' }),
      step({ key: 'try', label: 'Try it', role: 'user_tester' }),
      step({ key: 'done', label: 'Done', kind: 'person', role: null }),
    ],
  },
  {
    key: 'chore',
    name: 'Chore',
    description: 'A change with no behaviour to test',
    version: 1,
    builtin: true,
    personStops: 1,
    warning: null,
    steps: [
      step({ key: 'triage', label: 'Triage', role: 'triage' }),
      step({ key: 'do', label: 'Do it' }),
      step({ key: 'done', label: 'Done', kind: 'person', role: null }),
    ],
  },
];
let wf: WorkflowView;

beforeEach(() => {
  wf = {
    ticketId: 'KAN-319',
    templateKey: 'chore',
    templateName: 'Chore',
    templateVersion: 1,
    state: 'active',
    stopReason: null,
    stopDetail: null,
    reviewDepth: null,
    depthBy: null,
    depthNote: null,
    rounds: {},
    split: [],
    rulings: [],
    objections: [],
    steps: [
      vs({ key: 'triage', idx: 0, label: 'Triage', role: 'triage', state: 'done' }),
      vs({ key: 'do', idx: 1, label: 'Do it', state: 'active' }),
      vs({ key: 'done', idx: 2, label: 'Done', kind: 'person', role: null }),
    ],
  };
  http.get.mockImplementation((url: string) => {
    if (url.endsWith('/ai/workflow')) return ok(wf);
    if (url.endsWith('/ai/workflows')) return ok(templates);
    if (url.endsWith('/ai/ticket-flags')) return ok([]);
    if (url.endsWith('/ai/tdd')) return ok({ proven: false, why: '', runsSeen: 0 });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
  http.post.mockImplementation(() => ok(wf));
  http.delete.mockImplementation(() => ok(null));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mount() {
  const members = new Map(
    [ai('t1', 'Triage Tin', 'triage'), ai('d1', 'Dev Khoa', 'dev'), ai('r1', 'Reviewer Binh', 'reviewer')].map(
      (m) => [m.id, m] as [string, AiMember],
    ),
  );
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AiBoardContext.Provider value={{ projectId: 'p1', members, runsByTicket: new Map(), settings: null }}>
        <TicketWorkflow ticket={ticket} />
      </AiBoardContext.Provider>
    </QueryClientProvider>,
  );
}

describe('missingRoles', () => {
  it('lists the roles of AI steps nobody on the team has', () => {
    expect(missingRoles(templates[1], new Set(['triage', 'dev']))).toEqual(['designer', 'user_tester']);
    expect(missingRoles(templates[0], new Set(['triage', 'dev', 'reviewer']))).toEqual([]);
  });
});

describe('the workflow picker', () => {
  it('says Triage chose the workflow', async () => {
    mount();
    expect((await screen.findByTestId('chosen-by-triage')).textContent).toBe('Chosen by Triage');
  });

  it('lists each workflow with its steps, the stops for you, and the roles the project lacks', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Change workflow' }));
    const picker = await screen.findByTestId('change-workflow');
    const quick = await within(picker).findByTestId('pick-quick_fix');
    expect(quick.textContent).toContain('A bug with an obvious cause');
    expect(quick.textContent).toContain('Review · Light');
    expect(quick.textContent).toContain('5 steps · you once');
    expect(quick.textContent).toContain('Every role is on the team');
    const ui = within(picker).getByTestId('pick-feature_ui');
    expect(ui.textContent).toContain('6 steps · you twice');
    expect(within(picker).getByTestId('missing-feature_ui').textContent).toBe(
      'Needs a Designer and a User tester: none on this project',
    );
    const chore = within(picker).getByTestId('pick-chore');
    expect(chore.getAttribute('aria-checked')).toBe('true');
    expect(chore.textContent).toContain('Triage chose this');
    expect((within(picker).getByRole('button', { name: 'Move it over' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('moves the ticket over to the picked workflow', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Change workflow' }));
    fireEvent.click(await screen.findByTestId('pick-quick_fix'));
    expect(screen.getByTestId('pick-quick_fix').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Move it over' }));
    await waitFor(() => expect(http.delete).toHaveBeenCalledWith('/tickets/KAN-319/ai/workflow'));
    await waitFor(() =>
      expect(http.post).toHaveBeenCalledWith('/tickets/KAN-319/ai/workflow', {
        template_key: 'quick_fix',
        depth: undefined,
      }),
    );
    await waitFor(() => expect(screen.queryByTestId('change-workflow')).toBeNull());
  });

  it('closes on Cancel without changing anything', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Change workflow' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('change-workflow')).toBeNull();
    expect(http.delete).not.toHaveBeenCalled();
  });
});
