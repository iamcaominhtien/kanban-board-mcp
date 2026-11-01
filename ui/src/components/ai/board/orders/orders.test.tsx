// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firing, Order, OrderTemplates, Rule } from '../../../../types/aiOrders';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../../../../api/client', () => ({ client: http }));

import { StandingOrdersSection } from '../StandingOrdersSection';

const rule = (o: Partial<Rule> = {}): Rule => ({
  when: 'ci_red',
  if: {},
  then: { mode: 'fixed', action: 'back_to_dev' },
  afterwards: { lesson: false },
  maxPerDay: 5,
  maxPerTarget: 2,
  onlyProject: true,
  ...o,
});
const order = (o: Partial<Order> = {}): Order => ({
  id: 'o1',
  projectId: 'p1',
  name: 'Red CI → back to its Dev',
  sentence: '',
  rule: rule(),
  state: 'trial',
  trialDays: 3,
  trialStartedAt: new Date().toISOString(),
  trialFiredAt: null,
  canGoLive: false,
  fired: 0,
  wouldHave: 0,
  lastFiredAt: null,
  lastSummary: null,
  template: null,
  createdBy: null,
  createdAt: new Date().toISOString(),
  ...o,
});
const firing = (o: Partial<Firing> = {}): Firing => ({
  id: 'f1',
  orderId: 'o1',
  at: new Date().toISOString(),
  target: 'KAN-209',
  ticketId: 'KAN-209',
  trigger: { kind: 'ci_red', title: 'CI failed on the lint step', detail: '' },
  action: { action: 'back_to_dev', label: 'Give it back to the Dev who wrote it' },
  would: true,
  result: null,
  canUndo: false,
  undoneAt: null,
  undoneBy: null,
  ...o,
});
const templates: OrderTemplates = {
  templates: [
    {
      key: 'ci_red',
      name: 'Red CI → back to its Dev',
      sentence: 'If CI goes red, give it back to the Dev.',
      rule: rule(),
    },
  ],
  actions: {
    diagnose: { label: 'Let the AI analyse, then decide', signals: ['ai_hang'] },
    stopChild: { label: 'Stop the stuck child process', signals: ['ai_hang'] },
    backToDev: { label: 'Give it back to the Dev who wrote it', signals: ['ci_red'] },
  },
  signals: ['ai_hang', 'ci_red'],
};

let orders: Order[] = [];
let firings: Firing[] = [];
let settings = { pausedAll: false, aiEnabled: true };

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <StandingOrdersSection projectId="p1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  http.get.mockImplementation((url: string) => {
    if (url === '/ai/order-templates') return Promise.resolve({ data: templates });
    if (url.endsWith('/ai/orders')) return Promise.resolve({ data: orders });
    if (url.endsWith('/ai/firings')) return Promise.resolve({ data: firings });
    if (url.endsWith('/ai/board')) return Promise.resolve({ data: { runs: [], settings } });
    return Promise.reject(new Error(url));
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  orders = [];
  firings = [];
  settings = { pausedAll: false, aiEnabled: true };
});

describe('StandingOrdersSection', () => {
  it('says there are no rules yet', async () => {
    mount();
    expect(await screen.findByTestId('orders-empty')).toBeTruthy();
  });

  it('shows a trial rule as trial with "would have", and a live one as On', async () => {
    orders = [
      order({ wouldHave: 4, lastFiredAt: new Date().toISOString(), lastSummary: 'gave KAN-209 back to Dev An' }),
      order({ id: 'o2', name: 'Hung', state: 'on', fired: 7, rule: rule({ when: 'ai_hang', if: { minMinutes: 30 } }) }),
    ];
    mount();
    const rows = await screen.findAllByTestId('order-row');
    expect(rows[0].textContent).toContain('Trial · 1 of 3 days');
    expect(rows[0].textContent).toContain('4 would have');
    expect(rows[0].textContent).toContain('would have gave KAN-209');
    expect(rows[1].textContent).toContain('On');
    expect(rows[1].textContent).toContain('An AI produces no output for 30 minutes');
    expect((screen.getByText('Turn it on') as HTMLButtonElement).disabled).toBe(true);
  });

  it('marks every rule paused when Pause all AI is on', async () => {
    settings = { pausedAll: true, aiEnabled: true };
    orders = [order({ state: 'on' })];
    mount();
    expect(await screen.findByTestId('orders-paused')).toBeTruthy();
    expect((await screen.findByTestId('order-row')).textContent).toContain('Paused');
  });

  it('reads a trial: would-haves are marked, a real firing has Undo', async () => {
    orders = [order({ wouldHave: 1 }), order({ id: 'o2', name: 'Live', state: 'on', fired: 1 })];
    firings = [firing()];
    mount();
    fireEvent.click(await screen.findByText('Read the trial'));
    expect(await screen.findByTestId('firing-would')).toBeTruthy();
    expect(screen.getByText('Would have')).toBeTruthy();
    expect(screen.queryByText('Undo')).toBeNull();
  });

  it('undoes a firing and shows why when it cannot', async () => {
    orders = [order({ state: 'on', fired: 1 })];
    firings = [firing({ would: false, canUndo: true })];
    http.post.mockRejectedValueOnce({ response: { data: { detail: 'A started run is stopped, not erased.' } } });
    mount();
    fireEvent.click(await screen.findByText('History'));
    fireEvent.click(await screen.findByText('Undo'));
    expect(await screen.findByText('A started run is stopped, not erased.')).toBeTruthy();
    expect(http.post).toHaveBeenCalledWith('/ai/firings/f1/undo');
  });

  it('opens an empty editor with the server’s words when a sentence is not understood', async () => {
    http.post.mockRejectedValueOnce({
      response: { data: { detail: 'I could not tell which signal this is about. Pick one in the editor.' } },
    });
    mount();
    fireEvent.click(await screen.findByText('New rule'));
    fireEvent.change(screen.getByLabelText('Say it in a sentence'), { target: { value: 'be nice' } });
    fireEvent.click(screen.getByText('Read it as a rule'));
    expect((await screen.findByTestId('editor-notice')).textContent).toContain('could not tell which signal');
    expect((screen.getByTestId('start-trial') as HTMLButtonElement).disabled).toBe(true);
  });

  it('starts a trial from a ready-made rule: creates it, then sets it to trial; Turn it on now stays off', async () => {
    http.post.mockResolvedValueOnce({ data: order({ id: 'new', state: 'off' }) });
    http.patch.mockResolvedValueOnce({ data: order({ id: 'new' }) });
    mount();
    fireEvent.click(await screen.findByText('If CI goes red, give it back to the Dev.'));
    expect((screen.getByTestId('turn-on-now') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('start-trial'));
    await waitFor(() => expect(http.patch).toHaveBeenCalled());
    expect(http.post.mock.calls[0][0]).toBe('/projects/p1/ai/orders');
    expect(http.post.mock.calls[0][1].rule.then).toEqual({ mode: 'fixed', action: 'back_to_dev' });
    expect(http.patch).toHaveBeenCalledWith('/ai/orders/new', { state: 'trial', trialDays: 3 });
  });

  it('shows the server’s refusal of a rule', async () => {
    http.post.mockRejectedValueOnce({ response: { data: { detail: 'A rule may only do what can be undone.' } } });
    mount();
    fireEvent.click(await screen.findByText('If CI goes red, give it back to the Dev.'));
    fireEvent.click(screen.getByTestId('start-trial'));
    expect((await screen.findByTestId('editor-error')).textContent).toContain('only do what can be undone');
  });
});
