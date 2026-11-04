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

describe('Messages and GitHub', () => {
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
