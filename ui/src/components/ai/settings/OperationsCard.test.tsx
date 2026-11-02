// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const http = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../../../api/client', () => ({ client: http }));

import { OperationsCard } from './OperationsCard';

const ok = (data: unknown) => Promise.resolve({ data });
const member = (id: string, name: string, role: string) => ({ id, name, kind: 'ai', config: { role } });

let ops: Record<string, unknown>;
let members: unknown[];
let extra: Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  ops = { hangAfterMin: 15, diagnoseWithModel: true };
  members = [member('t1', 'Triage Tri', 'triage'), member('p1', 'PM Phuc', 'pm'), member('d1', 'Dev An', 'dev')];
  extra = {};
  http.get.mockImplementation((url: string) => {
    if (url in extra) return ok(extra[url]);
    if (url.endsWith('/ai/ops')) return ok(ops);
    if (url.endsWith('/ai/overview')) return ok({ members, settings: {}, summary: {} });
    if (url.endsWith('/ai/workflows'))
      return ok([
        { key: 'quick_fix', name: 'Quick fix', steps: [] },
        { key: 'standard', name: 'Standard feature', steps: [] },
      ]);
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
  // the server merges nested objects
  http.patch.mockImplementation((_u: string, body: Record<string, unknown>) =>
    ok(
      Object.fromEntries(
        Object.entries({ ...ops, ...body }).map(([k, v]) => [
          k,
          body[k] && typeof v === 'object' ? { ...((ops[k] as object) ?? {}), ...(v as object) } : v,
        ]),
      ),
    ),
  );
});
afterEach(cleanup);

const renderIt = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <OperationsCard projectId="p1" />
    </QueryClientProvider>,
  );
const patched = (body: object) => waitFor(() => expect(http.patch).toHaveBeenCalledWith('/projects/p1/ai/ops', body));

describe('OperationsCard', () => {
  it('uses the design wording and shows the saved number', async () => {
    renderIt();
    expect(await screen.findByText('Say nothing is moving after')).toBeTruthy();
    expect(screen.getByText(/A build that is still printing never trips it/)).toBeTruthy();
    expect((screen.getByTestId('ops-hang-after') as HTMLInputElement).value).toBe('15');
    expect(screen.getByText('Changes take effect on the next run.')).toBeTruthy();
  });

  it('saves the hang time on blur, only for a number from 1 up', async () => {
    renderIt();
    const input = await screen.findByTestId('ops-hang-after');
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.blur(input);
    fireEvent.change(input, { target: { value: '20' } });
    fireEvent.blur(input);
    await patched({ hangAfterMin: 20 });
    expect(http.patch).toHaveBeenCalledTimes(1);
  });
});

describe('Team on its own', () => {
  it('has its own heading and the intake switch, with the column once it is on', async () => {
    renderIt();
    expect((await screen.findByTestId('ops-own-heading')).textContent).toBe('Team on its own');
    expect(screen.getByText(/Only tickets that arrive after you turn it on/)).toBeTruthy();
    expect(screen.queryByTestId('ops-intake-status')).toBeNull();
    fireEvent.click(screen.getByTestId('ops-intake'));
    await patched({ intake: { on: true } });
  });

  it('picks the column and says since when', async () => {
    ops.intake = { on: true, status: 'todo', since: '2026-10-30T09:00:00Z' };
    renderIt();
    const select = (await screen.findByTestId('ops-intake-status')) as HTMLSelectElement;
    expect(select.value).toBe('todo');
    expect(screen.getByText(/Since /)).toBeTruthy();
    fireEvent.change(select, { target: { value: 'backlog' } });
    await patched({ intake: { status: 'backlog' } });
  });

  it('picks the default workflow from the templates, and None', async () => {
    ops.workflowDefault = 'standard';
    renderIt();
    const select = (await screen.findByTestId('ops-workflow-default')) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(3));
    expect(select.value).toBe('standard');
    fireEvent.change(select, { target: { value: '' } });
    await patched({ workflowDefault: '' });
  });

  it('offers only Triage members for Triage and only PMs for the PM', async () => {
    renderIt();
    const triage = (await screen.findByTestId('ops-triage')) as HTMLSelectElement;
    const pm = screen.getByTestId('ops-coordinator') as HTMLSelectElement;
    await waitFor(() => expect(triage.options.length).toBe(2));
    expect([...triage.options].map((o) => o.textContent)).toEqual(['Any Triage', 'Triage Tri']);
    expect([...pm.options].map((o) => o.textContent)).toEqual(['The first PM', 'PM Phuc']);
    fireEvent.change(triage, { target: { value: 't1' } });
    await patched({ triageId: 't1' });
    fireEvent.change(pm, { target: { value: 'p1' } });
    await patched({ coordinatorId: 'p1' });
    fireEvent.change(pm, { target: { value: '' } });
    await patched({ coordinatorId: null });
  });

  it('asks before the PM runs the team, and turns it on only once understood', async () => {
    renderIt();
    const sw = (await screen.findByTestId('ops-manager')) as HTMLButtonElement;
    await waitFor(() => expect(sw.disabled).toBe(false));
    fireEvent.click(sw);
    const dlg = await screen.findByTestId('ops-manager-confirm');
    expect(dlg.getAttribute('aria-label')).toBe('Let the PM decide for you?');
    expect(dlg.textContent).toContain('PM Phuc will decide, in your place');
    expect(dlg.textContent).toContain('up to Medium risk, at most 20 an hour');
    expect(dlg.textContent).toContain('That is why it stops at Medium and never touches the budget.');
    const on = screen.getByTestId('ops-manager-confirm-on') as HTMLButtonElement;
    expect(on.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('ops-manager-confirm')).toBeNull();
    expect(http.patch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('ops-manager'));
    fireEvent.click(await screen.findByTestId('ops-manager-agree'));
    fireEvent.click(screen.getByTestId('ops-manager-confirm-on'));
    await patched({ manager: { on: true } });
  });

  it('sets grace, risk and the hourly limit while the PM runs the team, and says how many are used', async () => {
    ops.manager = { on: true, graceMin: 0, maxRisk: 'medium', perHourLimit: 20 };
    extra['/projects/p1/ai/autopilot'] = { enabled: true, usedLastHour: 7 };
    renderIt();
    const grace = await screen.findByTestId('ops-manager-grace');
    expect((grace as HTMLInputElement).value).toBe('0');
    fireEvent.change(grace, { target: { value: '10' } });
    fireEvent.blur(grace);
    await patched({ manager: { graceMin: 10 } });
    expect(screen.getByTestId('ops-manager-risk-medium').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByTestId('ops-manager-risk-high'));
    await patched({ manager: { maxRisk: 'high' } });
    const limit = screen.getByTestId('ops-manager-limit');
    fireEvent.change(limit, { target: { value: '8' } });
    fireEvent.blur(limit);
    await patched({ manager: { perHourLimit: 8 } });
    expect((await screen.findByTestId('ops-manager-used')).textContent).toBe('7 of 8 used this hour.');
    expect(screen.getByTestId('ops-risk-tiers').textContent).toContain('Delete a ticket.');
    expect(screen.getByTestId('ops-never-pm').textContent).toContain('Never the PM’s call, whatever the ceiling:');
    expect(screen.getByTestId('ops-own-state').textContent).toBe('On · PM Phuc decides');
  });

  it('turns the PM off without asking', async () => {
    ops.manager = { on: true };
    renderIt();
    const sw = (await screen.findByTestId('ops-manager')) as HTMLButtonElement;
    await waitFor(() => expect(sw.disabled).toBe(false));
    fireEvent.click(sw);
    await patched({ manager: { on: false } });
    expect(screen.queryByTestId('ops-manager-confirm')).toBeNull();
  });

  it('says what the setup means, from the settings', async () => {
    ops.intake = { on: true, status: 'todo', since: '2026-10-14T09:00:00Z' };
    ops.workflowDefault = 'standard';
    ops.manager = { on: true, maxRisk: 'medium', perHourLimit: 20 };
    ops.autonomy = { done: 'person', approve: 'pm' };
    ops.ticketTokenCap = 800000;
    renderIt();
    const own = await screen.findByTestId('ops-meaning-own');
    await waitFor(() => expect(own.textContent).toContain('PM Phuc tries a failed step again'));
    expect(own.textContent).toContain('Takes each new ticket that lands in To Do with nobody assigned, since');
    expect(own.textContent).toContain('lets Triage choose its workflow');
    expect(own.textContent).toContain('PM Phuc approves the design step itself');
    const you = screen.getByTestId('ops-meaning-you');
    expect(you.textContent).toContain('Anything of High risk, for example deleting a ticket.');
    expect(you.textContent).toContain('Moving a ticket to Done, which merges the branch.');
    expect(you.textContent).toContain('Any ticket that has used 800,000 tokens, and the 21st decision in an hour.');
    expect(you.textContent).not.toContain('Approving the design');
  });

  it('says nothing is taken while both switches are off', async () => {
    renderIt();
    expect((await screen.findByTestId('ops-off-note')).textContent).toContain('Nothing is taken and nobody decides');
    expect(screen.getByTestId('ops-own-state').textContent).toBe('Off');
    expect(screen.getByTestId('ops-meaning-you').textContent).toContain(
      'Approving the design before anyone builds it.',
    );
    expect(screen.queryByTestId('ops-risk-tiers')).toBeNull();
  });

  it('sets who approves the design', async () => {
    renderIt();
    const you = await screen.findByTestId('ops-approve-person');
    expect(you.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(you);
    expect(http.patch).not.toHaveBeenCalled();
    await waitFor(() => expect((screen.getByTestId('ops-approve-pm') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('ops-approve-pm'));
    await patched({ autonomy: { approve: 'pm' } });
  });

  it('says when the PM is on but there is no PM, and offers to add one from the pack', async () => {
    members = [member('t1', 'Triage Tri', 'triage')];
    ops.manager = { on: true };
    extra['/projects/p1/ai/packs'] = [
      {
        id: 'builtin:pm',
        key: 'pm',
        name: 'PM',
        glyph: 'PM',
        tagline: '',
        model: 'opus',
        effort: 'high',
        template: 'pm',
        ceiling: 'todo',
        writes: 'nothing',
        handsIn: '',
        allow: [],
        plugins: [],
        mcp: [],
        limits: { maxParallel: 1, maxRunsPerDay: 10 },
        persona: '',
        version: 1,
        builtin: true,
      },
    ];
    extra['/ai/windows'] = { accounts: [{ key: 'local', name: 'This computer', status: 'ok', running: [] }] };
    renderIt();
    expect((await screen.findByTestId('ops-no-pm')).textContent).toContain('There is no PM to run it.');
    expect(screen.getByTestId('ops-own-state').textContent).toBe('On · no PM');
    const pm = screen.getByTestId('ops-coordinator') as HTMLSelectElement;
    expect(pm.options[0].textContent).toBe('No PM in this project');
    expect(pm.disabled).toBe(true);
    expect((screen.getByTestId('ops-approve-pm') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('ops-add-pm'));
    expect(await screen.findByRole('button', { name: 'Make member' })).toBeTruthy();
  });

  it('lets only the project owner hand decisions to the PM', async () => {
    extra['/projects/p1/ai/me'] = { role: 'member' };
    renderIt();
    expect(await screen.findByText(/Only the project owner can change it/)).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('ops-triage').querySelectorAll('option').length).toBe(2));
    expect((screen.getByTestId('ops-manager') as HTMLButtonElement).disabled).toBe(true);
  });

  it('hides the PM fields while the PM is off', async () => {
    renderIt();
    await screen.findByTestId('ops-manager');
    expect(screen.queryByTestId('ops-manager-grace')).toBeNull();
  });

  it('warns that Done merges when the board moves it', async () => {
    renderIt();
    const select = await screen.findByTestId('ops-autonomy-done');
    expect((select as HTMLSelectElement).value).toBe('person');
    expect(screen.queryByTestId('ops-done-warning')).toBeNull();
    fireEvent.change(select, { target: { value: 'after_review' } });
    await patched({ autonomy: { done: 'after_review' } });
    cleanup();
    ops.autonomy = { done: 'after_review' };
    renderIt();
    expect((await screen.findByTestId('ops-done-warning')).textContent).toContain('Done merges');
  });

  it('switches test-first, which is on until it is turned off', async () => {
    renderIt();
    const sw = await screen.findByTestId('ops-tdd');
    expect(sw.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(sw);
    await patched({ tdd: { required: false } });
  });

  it('sets the ticket token cap, 0 being no cap', async () => {
    ops.ticketTokenCap = 0;
    renderIt();
    const cap = await screen.findByTestId('ops-token-cap');
    expect((cap as HTMLInputElement).value).toBe('0');
    expect(screen.getByText(/0 is no cap/)).toBeTruthy();
    fireEvent.change(cap, { target: { value: '200000' } });
    fireEvent.blur(cap);
    await patched({ ticketTokenCap: 200000 });
  });

  it('switches live messages and the GitHub rules', async () => {
    renderIt();
    fireEvent.click(await screen.findByTestId('ops-live-messages'));
    await patched({ liveMessages: true });
    expect(screen.getByTestId('ops-github-auto').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByTestId('ops-github-auto'));
    await patched({ github: { auto: false } });
    fireEvent.click(screen.getByTestId('ops-github-on'));
    await patched({ github: { on: true } });
  });
});
