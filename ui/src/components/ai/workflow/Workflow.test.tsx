// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ticket } from '../../../types';
import type { AiMember } from '../../../types/ai';
import type { TddEvidence, ViewStep, WorkflowStep, WorkflowTemplate, WorkflowView } from '../../../types/aiWorkflow';

const http = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../../../api/client', () => ({ client: http }));
const runLink = vi.hoisted(() => ({ openRun: vi.fn() }));
vi.mock('../../aiteam/runLink', () => runLink);

import { AiBoardContext } from '../aiUi';
import { TicketWorkflow } from './TicketWorkflow';
import { WorkflowsSection } from './WorkflowsSection';

const ok = (data: unknown) => Promise.resolve({ data });
const ticket = { id: 'KAN-213', projectId: 'p1', title: 'Empty state' } as unknown as Ticket;
const member = { id: 'm1', name: 'Dev An' } as unknown as AiMember;

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
const view = (o: Partial<WorkflowView> = {}): WorkflowView => ({
  ticketId: 'KAN-213',
  templateKey: 'feature_ui',
  templateName: 'Feature with a UI',
  templateVersion: 1,
  state: 'active',
  stopReason: null,
  stopDetail: null,
  reviewDepth: 'standard',
  depthBy: 'triage',
  depthNote: null,
  rounds: {},
  split: [],
  rulings: [],
  objections: [],
  steps: [
    vs({ key: 'triage', idx: 0, label: 'Triage', role: 'triage', state: 'done', memberName: 'Triage Tri' }),
    vs({
      key: 'build',
      idx: 1,
      label: 'Build',
      state: 'active',
      attempt: 2,
      memberName: 'Dev An',
      noteIn: 'Fix the empty state',
    }),
    vs({ key: 'checks', idx: 2, label: 'Checks', kind: 'code', role: null }),
    vs({ key: 'review', idx: 3, label: 'Review', role: 'reviewer' }),
    vs({ key: 'done', idx: 4, label: 'Done', kind: 'person', role: null }),
  ],
  ...o,
});

let wf: WorkflowView | null;
let tdd: TddEvidence = { proven: false, why: 'every run passed', runsSeen: 3 };
let flags: unknown[] = [];

const step = (s: Partial<WorkflowStep>): WorkflowStep => ({
  key: 'x',
  label: 'X',
  kind: 'ai',
  role: 'dev',
  handsIn: '',
  gives: ['ticket', 'criteria'],
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
      step({ key: 'fix', label: 'Fix', handsIn: 'A branch' }),
      step({ key: 'checks', label: 'Checks', kind: 'code', role: null }),
      step({ key: 'review', label: 'Review', role: 'reviewer', depth: 'light' }),
      step({ key: 'done', label: 'Done', kind: 'person', role: null }),
    ],
  },
  {
    ...({} as WorkflowTemplate),
    key: 'standard',
    name: 'Standard feature',
    description: '',
    version: 1,
    builtin: true,
    personStops: 1,
    warning: null,
    steps: [step({ key: 'done', label: 'Done', kind: 'person', role: null })],
  },
];

function mount(ui: React.ReactNode, members = new Map([['m1', member]])) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AiBoardContext.Provider value={{ projectId: 'p1', members, runsByTicket: new Map(), settings: null }}>
        {ui}
      </AiBoardContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  wf = view();
  tdd = { proven: false, why: 'every run passed', runsSeen: 3 };
  flags = [];
  http.get.mockImplementation((url: string) => {
    if (url.endsWith('/ai/workflow')) return ok(wf);
    if (url.endsWith('/ai/workflows')) return ok(templates);
    if (url.endsWith('/ai/workflow-metrics'))
      return ok([
        {
          templateKey: 'quick_fix',
          tickets: 14,
          medianHours: 2.1667,
          passedFirst: 0.92,
          roundsAvg: 1,
          costPerTicket: 0.4,
        },
      ]);
    if (url.endsWith('/ai/tdd')) return ok(tdd);
    if (url.endsWith('/ai/ticket-flags')) return ok(flags);
    if (url.endsWith('/ai/packs')) return ok([]);
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
  http.post.mockImplementation(() => ok(view()));
  http.patch.mockImplementation(() => ok(view()));
  http.put.mockImplementation((_u: string, b: { name: string }) =>
    ok({ ...templates[0], name: b.name, version: 2, warning: null }),
  );
  http.delete.mockImplementation(() => ok(null));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the strip of steps', () => {
  it('shows each step with its state, the attempt after a send-back and what it was told', async () => {
    mount(<TicketWorkflow ticket={ticket} />);
    const strip = await screen.findByTestId('workflow-strip');
    expect(within(strip).getByTestId('wf-step-triage')).toHaveProperty('dataset.state', 'done');
    expect(within(strip).getByTestId('wf-step-build').textContent).toContain('working');
    expect(screen.getByTestId('wf-attempt-build').textContent).toBe('attempt 2');
    expect(screen.getByTestId('wf-note-in-build').textContent).toContain('Fix the empty state');
    expect(within(strip).getByTestId('wf-step-checks').textContent).toContain('By code');
    expect(within(strip).getByTestId('wf-step-review').textContent).toContain('Review · Standard');
    expect(within(strip).getByTestId('wf-step-done').textContent).toContain('waiting for you');
    expect(screen.getByTestId('step-position').textContent).toBe('step 2 of 5');
    expect(screen.getByTestId('who-held').textContent).toContain('Who did what');
    expect(screen.getByTestId('who-held').textContent).toContain('Dev An');
  });

  it('says why it stopped, and who gets it', async () => {
    wf = view({ state: 'stopped', stopReason: 'board_fault', stopDetail: 'The disk is full' });
    mount(<TicketWorkflow ticket={ticket} />);
    const card = await screen.findByTestId('stop-card');
    expect(card.textContent).toContain('Board fault');
    expect(card.textContent).toContain('Straight to you');
    expect(card.textContent).toContain('The disk is full');
  });

  it('says a blocked step has no member', async () => {
    wf = view();
    wf.steps[1] = { ...wf.steps[1], state: 'blocked' };
    const stepId = wf.steps[1].id;
    mount(<TicketWorkflow ticket={ticket} />);
    const row = await screen.findByTestId('wf-step-build');
    expect(row.textContent).toContain('No Dev on this project.');
    expect(row.textContent).toContain('or skip the step for this ticket');
    http.post.mockResolvedValue(ok(view()));
    fireEvent.click(within(row).getByRole('button', { name: 'Skip this step' }));
    await waitFor(() =>
      expect(http.post).toHaveBeenCalledWith('/tickets/KAN-213/ai/workflow/skip', { step_id: stepId }),
    );
  });

  it('offers only the control when the ticket has no workflow, and puts it on one', async () => {
    wf = null;
    mount(<TicketWorkflow ticket={ticket} />);
    const box = await screen.findByTestId('put-on-workflow');
    expect(screen.queryByTestId('workflow-strip')).toBeNull();
    await waitFor(() => expect(within(box).getByRole('option', { name: 'Quick fix' })).toBeTruthy());
    fireEvent.change(within(box).getByLabelText('Workflow'), { target: { value: 'quick_fix' } });
    fireEvent.click(within(box).getByRole('button', { name: 'Put on a workflow' }));
    await waitFor(() =>
      expect(http.post).toHaveBeenCalledWith('/tickets/KAN-213/ai/workflow', {
        template_key: 'quick_fix',
        depth: undefined,
      }),
    );
  });

  it('shows nothing when the project has no AI members', () => {
    const { container } = mount(<TicketWorkflow ticket={ticket} />, new Map());
    expect(container.innerHTML).toBe('');
    expect(http.get).not.toHaveBeenCalled();
  });

  it('shows an error with a retry when the workflow cannot load', async () => {
    http.get.mockImplementation(() => Promise.reject(new Error('boom')));
    mount(<TicketWorkflow ticket={ticket} />);
    expect(await screen.findByTestId('load-error')).toBeTruthy();
  });
});

describe('the review depth chip', () => {
  it('shows the depth and who chose it, and changes it', async () => {
    wf = view({ depthNote: 'Sent back twice: it would have gone up to Deep.', depthBy: 'person' });
    mount(<TicketWorkflow ticket={ticket} />);
    expect((await screen.findByTestId('depth-chip')).textContent).toContain('Standard');
    expect(screen.getByTestId('depth-by').textContent).toBe('set by you');
    expect(screen.getByTestId('depth-note').textContent).toContain('would have gone up');
    fireEvent.click(screen.getByRole('button', { name: 'Deep' }));
    await waitFor(() =>
      expect(http.patch).toHaveBeenCalledWith('/tickets/KAN-213/ai/workflow/depth', { depth: 'deep' }),
    );
  });
});

describe('the design approval', () => {
  const waiting = () => {
    const v = view();
    v.steps = [
      vs({
        key: 'design',
        idx: 0,
        label: 'Design',
        role: 'designer',
        state: 'done',
        memberName: 'Designer Dao',
        note: 'Two screens on the canvas',
      }),
      vs({ key: 'approve', idx: 1, label: 'You approve the design', kind: 'person', role: null, state: 'waiting' }),
      vs({ key: 'done', idx: 2, label: 'Done', kind: 'person', role: null }),
    ];
    return v;
  };

  it('approves', async () => {
    wf = waiting();
    mount(<TicketWorkflow ticket={ticket} />);
    const card = await screen.findByTestId('design-approval');
    expect(card.textContent).toContain('Two screens on the canvas');
    fireEvent.click(within(card).getByRole('button', { name: /Approve/ }));
    await waitFor(() =>
      expect(http.post).toHaveBeenCalledWith('/tickets/KAN-213/ai/workflow/decide', { approve: true, note: undefined }),
    );
  });

  it('sends it back with a note', async () => {
    wf = waiting();
    mount(<TicketWorkflow ticket={ticket} />);
    const card = await screen.findByTestId('design-approval');
    fireEvent.click(within(card).getByRole('button', { name: 'Change this first' }));
    fireEvent.change(within(card).getByLabelText('What to change'), { target: { value: ' Use a single line ' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Send it back' }));
    await waitFor(() =>
      expect(http.post).toHaveBeenCalledWith('/tickets/KAN-213/ai/workflow/decide', {
        approve: false,
        note: 'Use a single line',
      }),
    );
  });

  it('has no button on the last step, only the way to finish it', async () => {
    wf = view();
    wf.steps = [vs({ key: 'done', idx: 0, label: 'Done', kind: 'person', role: null, state: 'waiting' })];
    mount(<TicketWorkflow ticket={ticket} />);
    expect((await screen.findByTestId('last-step-hint')).textContent).toContain('move it to Done');
    expect(screen.queryByTestId('design-approval')).toBeNull();
  });
});

describe('the arbitration card', () => {
  const stuck = () =>
    view({
      state: 'stopped',
      stopReason: 'no_progress',
      rounds: { devReviewer: 4 },
      objections: [{ at: '2026-01-02T14:02:00Z', by: 'Reviewer Rin', role: 'reviewer', text: 'Compute it in the UI.' }],
      rulings: [
        {
          at: '2026-01-02T15:10:00Z',
          by: 'PM Phuc',
          verdict: 'undecided',
          reason: 'A product decision.',
          runId: 'run9',
        },
      ],
    });

  it('shows why and the ruling, and sides with Reviewer', async () => {
    wf = stuck();
    http.post.mockImplementation(() => ok({ side: 'reviewer', workflow: view() }));
    mount(<TicketWorkflow ticket={ticket} />);
    const card = await screen.findByTestId('arbitration-card');
    expect(card.textContent).toContain('KAN-213 went back and forth 4 times');
    expect(card.textContent).toContain('Compute it in the UI.');
    expect(screen.getByTestId('ruling').textContent).toContain('A product decision.');
    fireEvent.click(within(card).getByRole('button', { name: 'Side with Reviewer' }));
    await waitFor(() =>
      expect(http.post).toHaveBeenCalledWith('/tickets/KAN-213/ai/arbitration', {
        side: 'reviewer',
        reason: undefined,
      }),
    );
    expect((await screen.findByTestId('arbitration-done')).textContent).toContain('Sided with the Reviewer');
  });

  it('offers Dev, split, and the full arbitration', async () => {
    wf = stuck();
    http.post.mockImplementation(() => ok({ side: 'split', newTicket: { id: 'KAN-300' }, workflow: view() }));
    mount(<TicketWorkflow ticket={ticket} />);
    const card = await screen.findByTestId('arbitration-card');
    expect(within(card).getByRole('button', { name: 'Side with Dev' })).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: 'Read the full arbitration' }));
    expect(runLink.openRun).toHaveBeenCalledWith('run9');
    fireEvent.click(within(card).getByRole('button', { name: 'Split the ticket' }));
    expect((await screen.findByTestId('arbitration-done')).textContent).toContain('KAN-300');
  });

  it('keeps the buttons away once it is ruled', async () => {
    wf = view({ rulings: [{ at: '2026-01-02T15:10:00Z', by: 'PM Phuc', verdict: 'dev', reason: 'Dev is right.' }] });
    mount(<TicketWorkflow ticket={ticket} />);
    const card = await screen.findByTestId('arbitration-card');
    expect(within(card).queryByRole('button', { name: 'Side with Dev' })).toBeNull();
  });
});

describe('the test-first evidence', () => {
  it('shows the red run, the green run and how they were matched', async () => {
    tdd = {
      proven: true,
      red: {
        run: 'r1',
        at: '2026-01-02T11:22:18Z',
        command: 'npm test -- --run src/cost',
        failed: 1,
        failing: ['shows the estimate'],
        why: 'Failed on an assertion: expected $0.41',
      },
      green: { run: 'r2', at: '2026-01-02T11:31:05Z', command: 'npm test -- --run src/cost', passed: 62 },
      file: 'src/cost.test.ts',
    };
    mount(<TicketWorkflow ticket={ticket} />);
    const card = await screen.findByTestId('tdd-card');
    expect(card.textContent).toContain('Proven');
    expect(screen.getByTestId('tdd-red').textContent).toContain('1 failed');
    expect(screen.getByTestId('tdd-green').textContent).toContain('62 passed');
    expect(card.textContent).toContain('the command, the test file, the test name and why it failed');
    fireEvent.click(within(card).getByRole('button', { name: 'Open the red run' }));
    expect(runLink.openRun).toHaveBeenCalledWith('r1');
  });

  it('says why when not proven, once Dev has had its turn', async () => {
    wf = view();
    wf.steps[1] = { ...wf.steps[1], state: 'done' };
    mount(<TicketWorkflow ticket={ticket} />);
    expect((await screen.findByTestId('tdd-why')).textContent).toContain('every run passed');
    fireEvent.click(screen.getByRole('button', { name: 'Send it back to Dev An' }));
    await waitFor(() =>
      expect(http.post).toHaveBeenCalledWith('/tickets/KAN-213/ai/workflow/send-back', {
        role: 'dev',
        note: 'No test-first evidence: every run passed',
      }),
    );
  });

  it('stays quiet while Dev is still working', async () => {
    mount(<TicketWorkflow ticket={ticket} />);
    await screen.findByTestId('workflow-strip');
    expect(screen.queryByTestId('tdd-card')).toBeNull();
  });
});

describe('the workflow table and the template editor', () => {
  it('draws the chain, the measures and the italic Checks', async () => {
    mount(<WorkflowsSection projectId="p1" />);
    const row = await screen.findByTestId('workflow-row-quick_fix');
    expect(row.textContent).toContain('Triage›Fix (Dev)›Checks›Review (Light)›Done');
    expect(row.textContent).toContain('5 steps · you once');
    expect(row.textContent).toContain('14 tickets');
    expect(row.textContent).toContain('2 h 10');
    expect(row.textContent).toContain('92%');
    expect(row.querySelector('i')?.textContent).toBe('Checks');
  });

  it('edits a step and saves it as a new template', async () => {
    mount(<WorkflowsSection projectId="p1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Quick fix' }));
    const ed = await screen.findByTestId('template-editor');
    // step 2 (Fix) is selected: it has a role, and the transcript is off
    expect(within(ed).getByTestId('give-transcript').getAttribute('aria-checked')).toBe('false');
    fireEvent.change(within(ed).getByLabelText('What it has to hand in'), { target: { value: 'A branch and a note' } });
    fireEvent.click(within(ed).getByTestId('give-design'));
    fireEvent.click(within(ed).getByRole('checkbox'));
    fireEvent.click(within(ed).getByRole('button', { name: 'Move up' }));
    expect(within(ed).getByText(/Step 1/)).toBeTruthy();
    fireEvent.click(within(ed).getByRole('button', { name: 'Save as new' }));
    await waitFor(() => expect(http.put).toHaveBeenCalled());
    const [url, body] = http.put.mock.calls[0];
    expect(url).toBe('/projects/p1/ai/workflows/quick_fix_copy');
    expect(body.name).toBe('Quick fix (copy)');
    expect(body.steps.map((s: { key: string }) => s.key)).toEqual(['fix', 'triage', 'checks', 'review', 'done']);
    expect(body.steps[0]).toMatchObject({ handsIn: 'A branch and a note', retryModel: 'opus', role: 'dev' });
    expect(body.steps[0].gives).toContain('design');
    expect((await screen.findByTestId('editor-saved')).textContent).toContain('version 2');
  });

  it('removes a step, changes this one, and shows a server refusal', async () => {
    http.put.mockImplementation(() => Promise.reject({ response: { data: { detail: 'The step Fix needs a role.' } } }));
    mount(<WorkflowsSection projectId="p1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Quick fix' }));
    const ed = await screen.findByTestId('template-editor');
    fireEvent.click(within(ed).getByRole('button', { name: 'Remove' }));
    fireEvent.click(within(ed).getByRole('button', { name: 'Change this one' }));
    await waitFor(() => expect(http.put).toHaveBeenCalled());
    expect(http.put.mock.calls[0][0]).toBe('/projects/p1/ai/workflows/quick_fix');
    expect(http.put.mock.calls[0][1].steps).toHaveLength(4);
    expect((await within(ed).findByRole('alert')).textContent).toContain('needs a role');
  });

  // "Who does it" is the design's own dropdown: open it and pick an option
  const pickWho = (ed: HTMLElement, name: string) => {
    fireEvent.click(within(ed).getByRole('button', { name: 'Who does it' }));
    fireEvent.click(screen.getByRole('option', { name: new RegExp(`^${name}`) }));
  };

  it('warns when a template stops for you more than twice', async () => {
    mount(<WorkflowsSection projectId="p1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Quick fix' }));
    const ed = await screen.findByTestId('template-editor');
    fireEvent.click(within(ed).getByRole('button', { name: 'Add a step' }));
    pickWho(ed, 'You');
    expect(within(ed).queryByTestId('editor-warning')).toBeNull();
    fireEvent.click(within(ed).getByRole('button', { name: 'Add a step' }));
    pickWho(ed, 'You');
    expect(within(ed).getByTestId('editor-warning').textContent).toContain('more than twice');
  });
});

describe('the team on its own', () => {
  const unproven = () => {
    wf = view();
    wf.steps[1] = { ...wf.steps[1], state: 'done', outcome: 'unproven' };
  };

  it('offers to accept an unproven Dev step once, and says it is not done', async () => {
    unproven();
    mount(<TicketWorkflow ticket={ticket} />);
    const card = await screen.findByTestId('tdd-card');
    expect(card.textContent).toContain('not marked done');
    expect(screen.getByTestId('wf-step-build').textContent).toContain('not proven');
    fireEvent.click(within(card).getByRole('button', { name: 'Accept without it, just this once' }));
    // the reason is required: nothing is sent until one is written
    const form = await within(card).findByTestId('tdd-reason');
    const ok = within(form).getByRole('button', { name: 'Accept just this once' });
    expect(ok).toHaveProperty('disabled', true);
    expect(http.post).not.toHaveBeenCalled();
    fireEvent.change(within(form).getByRole('textbox'), { target: { value: 'Copy change only.' } });
    fireEvent.click(ok);
    await waitFor(() =>
      expect(http.post).toHaveBeenCalledWith('/tickets/KAN-213/ai/tdd/accept', { reason: 'Copy change only.' }),
    );
  });

  it('turns the rule off only after a confirmation', async () => {
    unproven();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    mount(<TicketWorkflow ticket={ticket} />);
    const button = await screen.findByRole('button', { name: 'Turn the rule off for this project' });
    fireEvent.click(button);
    expect(http.post).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(http.post).toHaveBeenCalledWith('/tickets/KAN-213/ai/tdd/accept', { ruleOff: true }));
    confirm.mockRestore();
  });

  it('shows an accepted step as accepted, with no buttons and no "not marked done"', async () => {
    wf = view();
    wf.steps[1] = {
      ...wf.steps[1],
      state: 'done',
      outcome: 'accepted',
      result: { accepted: { by: 'Minh Tran', at: '2026-01-02T14:02:00Z', reason: 'Copy change only.' } },
    };
    mount(<TicketWorkflow ticket={ticket} />);
    const card = await screen.findByTestId('tdd-card');
    expect(screen.getByTestId('tdd-accepted').textContent).toBe('Accepted without tests');
    // who, when and why, on the card
    expect(screen.getByTestId('tdd-why').textContent).toContain('Minh Tran accepted it at');
    expect(screen.getByTestId('accepted-reason').textContent).toBe('“Copy change only.”');
    expect(card.textContent).not.toContain('not marked done');
    expect(within(card).queryByRole('button', { name: 'Accept without it, just this once' })).toBeNull();
    expect(screen.getByTestId('wf-step-build').textContent).toContain('accepted without proof');
  });

  it('reads who and why from the step note when the result has none', async () => {
    wf = view();
    wf.steps[1] = {
      ...wf.steps[1],
      state: 'done',
      outcome: 'accepted',
      note: 'Done.\n\nAccepted without test-first evidence by An Nguyen: Docs only.',
    };
    mount(<TicketWorkflow ticket={ticket} />);
    expect((await screen.findByTestId('tdd-why')).textContent).toContain('An Nguyen accepted it');
    expect(screen.getByTestId('accepted-reason').textContent).toBe('“Docs only.”');
  });

  it('says quietly that test first is off, with no red card', async () => {
    const base = http.get.getMockImplementation()!;
    http.get.mockImplementation((url: string) =>
      url === '/projects/p1/ai/ops' ? ok({ tdd: { required: false } }) : base(url),
    );
    wf = view();
    wf.steps[1] = { ...wf.steps[1], state: 'done' };
    mount(<TicketWorkflow ticket={ticket} />);
    expect((await screen.findByTestId('tdd-off')).textContent).toBe('Not required');
    const card = screen.getByTestId('tdd-card');
    expect(card.textContent).toContain('Test first is off for this project');
    expect(within(card).queryByRole('button')).toBeNull();
  });

  it('keeps the accept buttons away when the Dev step was simply sent back', async () => {
    wf = view();
    wf.steps[1] = { ...wf.steps[1], state: 'done' };
    mount(<TicketWorkflow ticket={ticket} />);
    await screen.findByTestId('tdd-card');
    expect(screen.queryByRole('button', { name: 'Accept without it, just this once' })).toBeNull();
  });

  it('lets a ticket stopped at its token cap go on', async () => {
    wf = view({
      state: 'stopped',
      stopReason: 'quota_cap',
      stopDetail: 'Used 210,000 tokens; the cap for one ticket is 200,000.',
    });
    mount(<TicketWorkflow ticket={ticket} />);
    const card = await screen.findByTestId('cap-stopped-card');
    expect(card.textContent).toContain('210,000');
    fireEvent.click(within(card).getByTestId('cap-resume'));
    await waitFor(() => expect(http.post).toHaveBeenCalledWith('/tickets/KAN-213/ai/workflow/resume'));
  });

  it('names the pieces a split ticket waits for', async () => {
    wf = view({ state: 'stopped', stopReason: 'split', stopDetail: 'two pieces', split: ['KAN-2', 'KAN-3'] });
    const open = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <AiBoardContext.Provider
          value={{
            projectId: 'p1',
            members: new Map([['m1', member]]),
            runsByTicket: new Map(),
            settings: null,
            openTicket: open,
          }}
        >
          <TicketWorkflow ticket={ticket} />
        </AiBoardContext.Provider>
      </QueryClientProvider>,
    );
    const pieces = await screen.findByTestId('split-pieces');
    expect(pieces.textContent).toBe('Split into KAN-2 and KAN-3; it is done when they all are.');
    expect(within(screen.getByTestId('stop-card')).queryByRole('button', { name: 'Let it go on' })).toBeNull();
    fireEvent.click(within(pieces).getByRole('button', { name: 'KAN-3' }));
    expect(open).toHaveBeenCalledWith('KAN-3');
  });

  it('says the board moved the ticket to Done', async () => {
    wf = view({ state: 'done' });
    wf.steps[4] = { ...wf.steps[4], state: 'done', outcome: 'board', endedAt: '2026-01-02T15:00:00Z' };
    mount(<TicketWorkflow ticket={ticket} />);
    expect((await screen.findByTestId('wf-by-board-done')).textContent).toContain('Moved to Done by the board');
    expect(screen.getByTestId('who-held').textContent).toContain('Moved to Done by the board');
  });

  it.each([
    ['run', 'Its run was refused.'],
    ['no_folder', 'The Checks have no folder to run in.'],
    ['failed', 'The PM could not get this step through and passed it to you.'],
  ])('says why a step could not start (%s)', async (why, text) => {
    wf = view();
    wf.steps[1] = { ...wf.steps[1], state: 'blocked' };
    flags = [{ id: 'f1', kind: 'step_blocked', data: { why }, open: true, createdAt: '2026-01-02T10:00:00Z' }];
    mount(<TicketWorkflow ticket={ticket} />);
    const note = await screen.findByTestId('wf-blocked-build');
    expect(note.textContent).toContain(text);
    expect(screen.getByTestId('wf-step-build').textContent).not.toContain('No Dev on this project');
  });
});
