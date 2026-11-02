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

beforeEach(() => {
  vi.clearAllMocks();
  ops = { hangAfterMin: 15, diagnoseWithModel: true };
  http.get.mockImplementation((url: string) => {
    if (url.endsWith('/ai/ops')) return ok(ops);
    if (url.endsWith('/ai/overview'))
      return ok({
        members: [member('t1', 'Triage Tri', 'triage'), member('p1', 'PM Phuc', 'pm'), member('d1', 'Dev An', 'dev')],
        settings: {},
        summary: {},
      });
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

describe('The team on its own', () => {
  it('has its own heading and the intake switch, with the column once it is on', async () => {
    renderIt();
    expect((await screen.findByTestId('ops-own-heading')).textContent).toBe('The team on its own');
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

  it('turns the PM on, then sets grace, risk and the hourly limit', async () => {
    renderIt();
    fireEvent.click(await screen.findByTestId('ops-manager'));
    await patched({ manager: { on: true } });
    cleanup();
    ops.manager = { on: true, graceMin: 5, maxRisk: 'medium', perHourLimit: 20 };
    renderIt();
    const grace = await screen.findByTestId('ops-manager-grace');
    fireEvent.change(grace, { target: { value: '10' } });
    fireEvent.blur(grace);
    await patched({ manager: { graceMin: 10 } });
    fireEvent.change(screen.getByTestId('ops-manager-risk'), { target: { value: 'high' } });
    await patched({ manager: { maxRisk: 'high' } });
    const limit = screen.getByTestId('ops-manager-limit');
    fireEvent.change(limit, { target: { value: '8' } });
    fireEvent.blur(limit);
    await patched({ manager: { perHourLimit: 8 } });
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
