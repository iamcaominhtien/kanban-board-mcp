// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const http = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../../../api/client', () => ({ client: http }));

import { ConfigMigrationOffer } from './ConfigMigrationOffer';

const files = [
  { path: '.claude/skills/a.md', unchanged: true, blockOnly: false },
  { path: 'CLAUDE.md', unchanged: false, blockOnly: true },
  { path: '.mcp.json', unchanged: false, blockOnly: false },
];
function setup(perRun: boolean, migrationFiles = files) {
  http.get.mockImplementation((url: string) =>
    url.endsWith('/ai/ops')
      ? Promise.resolve({ data: { perRunConfig: perRun } })
      : Promise.resolve({ data: { memberId: 'm1', folder: '/work/dev', files: migrationFiles } }),
  );
}
const renderIt = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ConfigMigrationOffer memberId="m1" projectId="p" />
    </QueryClientProvider>,
  );

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('ConfigMigrationOffer', () => {
  it('shows nothing while per-run configuration is off', async () => {
    setup(false);
    const { container } = renderIt();
    await waitFor(() => expect(http.get).toHaveBeenCalled());
    expect(container.textContent).toBe('');
    expect(http.get.mock.calls.some((c) => String(c[0]).includes('config-migration'))).toBe(false);
  });

  it('shows nothing when there are no files to remove', async () => {
    setup(true, []);
    const { container } = renderIt();
    await waitFor(() => expect(http.get.mock.calls.some((c) => String(c[0]).includes('config-migration'))).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe('');
  });

  it('lists the files, marks the changed ones, and removes them', async () => {
    setup(true);
    http.post.mockResolvedValue({ data: { removed: ['.claude/skills/a.md', 'CLAUDE.md'] } });
    renderIt();
    expect(await screen.findByText(/The board wrote 3 files into \/work\/dev/)).toBeTruthy();
    expect(screen.getByText(/and 1 changed file will be left as they are/)).toBeTruthy();
    expect(screen.getByText(/CLAUDE\.md \(only the board’s block\)/)).toBeTruthy();
    expect(screen.getByText(/\.mcp\.json \(changed, kept\)/)).toBeTruthy();
    fireEvent.click(screen.getByTestId('migration-run'));
    expect((await screen.findByTestId('migration-done')).textContent).toMatch(/Removed 2 files from the folder/);
    expect(http.post).toHaveBeenCalledWith('/ai/members/m1/config-migration');
  });

  it('says "1 file" in the singular after removing one', async () => {
    setup(true, [files[0]]);
    http.post.mockResolvedValue({ data: { removed: ['x'] } });
    renderIt();
    expect(await screen.findByText(/The board wrote 1 file into/)).toBeTruthy();
    fireEvent.click(screen.getByTestId('migration-run'));
    expect((await screen.findByTestId('migration-done')).textContent).toMatch(/Removed 1 file from/);
  });

  it('shows the error and keeps the offer when removal fails', async () => {
    setup(true);
    http.post.mockRejectedValue({ response: { data: { detail: 'folder locked' } } });
    renderIt();
    fireEvent.click(await screen.findByTestId('migration-run'));
    expect(await screen.findByText('folder locked')).toBeTruthy();
    expect(screen.getByTestId('migration-offer')).toBeTruthy();
  });
});
