// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ticket, TestCase } from '../../../types';
import type { AiMember, AiRun } from '../../../types/ai';
import type { TddEvidence, ViewStep, WorkflowView } from '../../../types/aiWorkflow';

const http = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../../../api/client', () => ({ client: http }));
const runLink = vi.hoisted(() => ({ openRun: vi.fn() }));
vi.mock('../../aiteam/runLink', () => runLink);

import { AiBoardContext } from '../aiUi';
import { EvidenceBlock } from './EvidenceBlock';
import { acceptedOf, gateState, proofOf, testerProof } from './evidenceModel';

const ok = (data: unknown) => Promise.resolve({ data });

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

const view = (steps: ViewStep[], o: Partial<WorkflowView> = {}): WorkflowView => ({
  ticketId: 'KAN-305',
  templateKey: 'standard',
  templateName: 'Standard feature',
  templateVersion: 1,
  state: 'active',
  stopReason: null,
  stopDetail: null,
  reviewDepth: 'standard',
  depthBy: null,
  depthNote: null,
  rounds: {},
  split: [],
  rulings: [],
  objections: [],
  steps,
  ...o,
});

const steps = (tester: Partial<ViewStep> = {}, dev: Partial<ViewStep> = {}) => [
  vs({ key: 'build', idx: 0, label: 'Build', memberName: 'Dev Khoa', runId: 'run-dev', ...dev }),
  vs({
    key: 'checks',
    idx: 1,
    label: 'Checks',
    kind: 'code',
    role: null,
    result: {
      checks: [
        { name: 'test', command: 'npm test', ok: true, tail: '', seconds: 3 },
        { name: 'lint', command: 'npm run lint', ok: true, tail: '', seconds: 1 },
      ],
    },
  }),
  vs({ key: 'review', idx: 2, label: 'Review', role: 'reviewer', outcome: 'pass', memberName: 'Reviewer Binh' }),
  vs({ key: 'test', idx: 3, label: 'Test', role: 'qa', memberName: 'Tester Mai', ...tester }),
  vs({ key: 'done', idx: 4, label: 'Done', kind: 'person', role: null, state: 'waiting' }),
];

const proven: TddEvidence = {
  proven: true,
  red: {
    run: 'r1',
    at: '2026-01-02T10:14:00Z',
    command: 'npm test -- favourites',
    failed: 2,
    failing: ['saves a city'],
    why: 'failed on an assertion',
  },
  green: { run: 'r2', at: '2026-01-02T10:31:00Z', command: 'npm test -- favourites', passed: 14 },
  file: 'favourites.test.ts',
};

const tc = (o: Partial<TestCase>): TestCase => ({ id: o.code ?? 'x', title: 't', status: 'pass', ...o }) as TestCase;
const cases = [
  tc({ code: 'TC-1', title: 'Add a city', proof: '![after](https://img/tc1.png)' }),
  tc({ code: 'TC-2', title: 'Remove it', proof: '```\n$ npx playwright test favourites\n3 passed (12.4s)\n```' }),
  tc({ code: 'TC-3', title: 'No network', proof: 'Not provable: needs a real iPhone' }),
];
const ticket = (testCases: TestCase[] = cases) =>
  ({
    id: 'KAN-305',
    projectId: 'p1',
    title: 'Save favourite cities',
    status: 'review',
    testCases,
  }) as unknown as Ticket;

const devRun = {
  id: 'run-dev',
  mode: 'work',
  memberId: 'm1',
  tests: { passed: 14, failed: 0, lint: 'clean' },
  files: [
    { path: 'FavouriteList.tsx', added: 84, removed: 0, new: true },
    { path: 'useFavourites.ts', added: 31, removed: 3, new: false },
  ],
} as unknown as AiRun;

let wf: WorkflowView;
let tdd: TddEvidence;
let ops: Record<string, unknown>;

beforeEach(() => {
  wf = view(steps());
  tdd = proven;
  ops = {};
  http.get.mockImplementation((url: string) => {
    if (url.endsWith('/ai/workflow')) return ok(wf);
    if (url.endsWith('/ai/tdd')) return ok(tdd);
    if (url.endsWith('/ai/runs')) return ok([devRun]);
    if (url.endsWith('/ai/ops')) return ok(ops);
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
  http.post.mockImplementation(() => ok(wf));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mount(t: Ticket = ticket()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AiBoardContext.Provider
        value={{
          projectId: 'p1',
          members: new Map([['m1', { id: 'm1', name: 'Dev Khoa', kind: 'ai' } as unknown as AiMember]]),
          runsByTicket: new Map(),
          settings: null,
        }}
      >
        <EvidenceBlock ticket={t} />
      </AiBoardContext.Provider>
    </QueryClientProvider>,
  );
}

describe('the evidence model', () => {
  it('reads a picture, a log and a reason it cannot be shown from the proofs', () => {
    expect(proofOf(cases[0]).image).toBe('https://img/tc1.png');
    expect(proofOf(cases[1]).log).toContain('3 passed (12.4s)');
    expect(proofOf(cases[2]).unprovable).toBe(true);
    const p = testerProof([...cases, tc({ code: 'TC-4', proof: '' }), tc({ code: 'TC-5', status: 'pending' })]);
    expect(p.given).toHaveLength(4);
    expect(p.shown).toBe(2);
    expect(p.trusted).toHaveLength(1);
    expect(p.missing.map((t) => t.code)).toEqual(['TC-4']);
  });

  it('follows the table of N, top to bottom', () => {
    expect(gateState(view(steps()), proven, true)).toBe('complete');
    expect(gateState(view(steps({ outcome: 'no_evidence' })), proven, true)).toBe('missing');
    expect(gateState(view(steps({}, { outcome: 'unproven' })), undefined, true)).toBe('tdd_unproven');
    expect(gateState(view(steps({}, { outcome: 'accepted' })), undefined, true)).toBe('accepted');
    expect(gateState(view(steps()), { proven: false, why: 'x', runsSeen: 1 }, false)).toBe('tdd_off');
  });

  it('finds who accepted, when and why', () => {
    const at = '2026-01-02T14:02:00Z';
    expect(
      acceptedOf(vs({ key: 'b', idx: 0, outcome: 'accepted', result: { accepted: { by: 'u', at, reason: 'r' } } })),
    ).toEqual({ by: 'u', at, reason: 'r' });
    expect(acceptedOf(vs({ key: 'b', idx: 0, outcome: 'pass' }))).toBeNull();
  });
});

describe('the Evidence block', () => {
  it('gathers the gate, Dev’s tests and diff, and the Tester’s pictures and logs', async () => {
    mount();
    const block = await screen.findByTestId('evidence-block');
    await waitFor(() => expect(screen.getByTestId('evidence-state').textContent).toContain('Evidence complete'));
    expect(screen.getByTestId('gate-tdd').dataset.mark).toBe('ok');
    expect(screen.getByTestId('gate-checks').textContent).toContain('test, lint');
    expect(screen.getByTestId('gate-proof').textContent).toContain('2 of 3, 1 on trust');
    expect(screen.getByTestId('gate-review').textContent).toContain('pass');
    expect(screen.getByTestId('evidence-red').textContent).toContain('2 failed');
    expect(screen.getByTestId('evidence-green').textContent).toContain('14 passed');
    expect((await screen.findByTestId('evidence-tests')).textContent).toContain('14 passed');
    expect(screen.getByTestId('evidence-files').textContent).toContain('+ FavouriteList.tsx +84');
    expect(within(block).getByAltText('Proof of TC-1')).toHaveProperty('src', 'https://img/tc1.png');
    expect(screen.getByTestId('evidence-log').textContent).toContain('npx playwright test favourites');
    expect(screen.getByTestId('evidence-proof-count').textContent).toContain('2 of 3 results have a proof');
    expect(screen.getByTestId('evidence-trusted').textContent).toContain('Not provable: needs a real iPhone');
    expect(screen.getByTestId('evidence-board-moves').textContent).toContain('Moving to Done stays yours');
    fireEvent.click(within(block).getByRole('button', { name: 'Open the red run' }));
    expect(runLink.openRun).toHaveBeenCalledWith('r1');
  });

  it('says the board may move it to Done when the board moves tickets itself', async () => {
    ops = { autonomy: { done: 'after_review' } };
    mount();
    await waitFor(() =>
      expect(screen.getByTestId('evidence-board-moves').textContent).toBe('The board may move it to Done.'),
    );
  });

  it('makes a testing step with nothing to show visible: send it back, or accept with a reason', async () => {
    wf = view(steps({ outcome: 'no_evidence' }));
    mount(ticket([tc({ code: 'TC-2', proof: '' }), tc({ code: 'TC-4', proof: null })]));
    const card = await screen.findByTestId('evidence-missing');
    expect(card.textContent).toContain('Tester Mai marked 2 results pass');
    expect(card.textContent).toContain('No proof: TC-2, TC-4.');
    expect(screen.getByTestId('evidence-state').textContent).toContain('Evidence missing');

    fireEvent.click(within(card).getByRole('button', { name: /Send back to Tester Mai/ }));
    await waitFor(() =>
      expect(http.post).toHaveBeenCalledWith(
        '/tickets/KAN-305/ai/workflow/send-back',
        expect.objectContaining({ role: 'qa' }),
      ),
    );

    fireEvent.click(within(card).getByRole('button', { name: 'Accept without evidence' }));
    const form = within(card).getByTestId('evidence-reason');
    const accept = within(form).getByRole('button', { name: 'Accept without evidence' });
    expect(accept).toHaveProperty('disabled', true);
    fireEvent.change(within(form).getByRole('textbox'), { target: { value: 'I tried it myself.' } });
    fireEvent.click(accept);
    await waitFor(() =>
      expect(http.post).toHaveBeenCalledWith('/tickets/KAN-305/ai/evidence/accept', { reason: 'I tried it myself.' }),
    );
  });

  it('shows who took the Tester’s step without evidence, and why', async () => {
    wf = view(
      steps({
        outcome: 'accepted',
        result: { accepted: { by: 'user', at: '2026-01-02T14:02:00Z', reason: 'Tried on staging.' } },
      }),
    );
    mount();
    const card = await screen.findByTestId('evidence-accepted');
    expect(card.textContent).toContain('You accepted it at');
    expect(card.textContent).toContain('“Tried on staging.”');
  });

  it('says test first is not proven, once, and that the board waits', async () => {
    wf = view(steps({}, { outcome: 'unproven' }));
    tdd = { proven: false, why: 'Every run passed; none failed first.', runsSeen: 3 };
    ops = { autonomy: { done: 'after_review' } };
    mount();
    const box = await screen.findByTestId('evidence-tdd');
    expect(box.dataset.state).toBe('unproven');
    await waitFor(() => expect(box.textContent).toContain('Every run passed; none failed first.'));
    expect(within(box).queryByRole('button')).toBeNull(); // the choices stay on the workflow's card
    expect(screen.getByTestId('evidence-state').textContent).toContain('Test first not proven');
    await waitFor(() =>
      expect(screen.getByTestId('evidence-board-moves').textContent).toContain('does not move it to Done'),
    );
  });

  it('says quietly when test first is off', async () => {
    tdd = { proven: false, why: 'x', runsSeen: 0 };
    ops = { tdd: { required: false } };
    mount();
    await waitFor(() => expect(screen.getByTestId('evidence-tdd').dataset.state).toBe('off'));
    expect(screen.getByTestId('evidence-state').textContent).toContain('Test first off');
  });

  it('draws nothing before Dev has handed anything in', async () => {
    wf = view([vs({ key: 'build', idx: 0, state: 'active' })]);
    const { container } = mount();
    await waitFor(() => expect(http.get).toHaveBeenCalledWith('/tickets/KAN-305/ai/workflow'));
    expect(container.querySelector('[data-testid="evidence-block"]')).toBeNull();
  });
});
