// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../../../api/client', () => ({ client: http }));
import { AddAccountModal } from './AddAccountModal';

const card = (cli: string, over: Record<string, unknown> = {}) => ({
  cli,
  label: cli,
  blurb: '',
  provider: 'x',
  found: true,
  runnable: true,
  unavailable: null,
  ...over,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AddAccountModal CLI cards (ACC-5)', () => {
  it('shows the version after "found" when the server knows it, and "found" alone otherwise', async () => {
    http.get.mockResolvedValue({
      data: {
        accounts: [],
        clis: [
          card('claude', { version: '2.1.4' }),
          card('codex', { version: null }),
          card('opencode', { found: false }),
        ],
      },
    });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <AddAccountModal onClose={() => undefined} />
      </QueryClientProvider>,
    );
    expect((await screen.findByTestId('cli-card-claude')).textContent).toContain('found · v2.1.4');
    expect(screen.getByTestId('cli-card-codex').textContent).toContain('found');
    expect(screen.getByTestId('cli-card-codex').textContent).not.toContain('found ·');
    expect(screen.getByTestId('cli-card-opencode').textContent).toContain('not installed');
  });
});
