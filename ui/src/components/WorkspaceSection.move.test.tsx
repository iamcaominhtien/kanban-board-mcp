// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const http = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../api/client', () => ({ client: http }));

import { WorkspaceSection } from './WorkspaceSection';

const ws = {
  enabled: true,
  path: '/home/an/kanban-workspace/KAN-1',
  exists: true,
  retentionDays: 14,
  retentionOverride: null,
  sweepEligible: false,
  expiresAt: null,
  files: [{ name: 'report.html', isDir: false, size: 12, modifiedAt: '2026-11-02T10:00:00Z' }],
  fileCount: 1,
  totalBytes: 12,
  truncated: false,
};

const renderIt = (props: Partial<Parameters<typeof WorkspaceSection>[0]> = {}) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <WorkspaceSection ticketId="KAN-1" {...props} />
    </QueryClientProvider>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  http.get.mockResolvedValue({ data: ws });
});
afterEach(cleanup);

describe('WorkspaceSection: move to another ticket (issue #269)', () => {
  it('moves the folder to the ticket typed in, and says where it went', async () => {
    http.post.mockResolvedValue({
      data: { result: 'moved', path: '/home/an/kanban-workspace/KAN-2', to: 'KAN-2' },
    });
    renderIt();
    fireEvent.click(await screen.findByTestId('workspace-move-open'));
    fireEvent.change(screen.getByLabelText('Ticket to move the workspace to'), { target: { value: 'kan-2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move' }));
    await waitFor(() =>
      expect(http.post).toHaveBeenCalledWith('/tickets/KAN-1/workspace/move', { to_ticket_id: 'KAN-2', mode: 'move' }),
    );
    expect((await screen.findByRole('alert')).textContent).toContain('moved to KAN-2');
    expect(screen.queryByTestId('workspace-move-form')).toBeNull();
  });

  it('shows the reason when the move is refused', async () => {
    http.post.mockRejectedValue({ response: { data: { detail: 'Pick another ticket' } } });
    renderIt();
    fireEvent.click(await screen.findByTestId('workspace-move-open'));
    fireEvent.change(screen.getByLabelText('Ticket to move the workspace to'), { target: { value: 'KAN-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Pick another ticket');
  });

  it('is not offered on an idea or read-only', async () => {
    renderIt({ readOnly: true });
    await screen.findByText('report.html');
    expect(screen.queryByTestId('workspace-move-open')).toBeNull();
  });
});
