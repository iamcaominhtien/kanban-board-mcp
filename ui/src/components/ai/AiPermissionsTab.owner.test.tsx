// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiMember, PermissionRow } from '../../types/ai';

const update = vi.hoisted(() => vi.fn());
const role = vi.hoisted(() => ({ value: 'owner' as 'owner' | 'admin' }));

const row = (
  action: string,
  label: string,
  templateMode: PermissionRow['mode'],
  lockedMin: PermissionRow['mode'] | null = null,
): PermissionRow => ({
  action,
  label,
  description: '',
  risk: 'low',
  templateMode,
  override: null,
  mode: templateMode,
  lockedMin,
  source: 'Template · developer',
});

vi.mock('../../api/ai', async (orig) => ({
  ...(await orig<typeof import('../../api/ai')>()),
  aiApi: { update, decidePending: vi.fn(), testPermission: vi.fn() },
  useAiPermissions: () => ({
    data: {
      template: 'developer',
      ceiling: 'review',
      scope: 'assigned',
      matrix: [
        row('change_assignee', 'Change assignee', 'approval'),
        row('delete_tickets', 'Delete tickets', 'blocked', 'approval'),
      ],
      history: [],
      safeMode: false,
      agentSafeMode: false,
      pausedAll: false,
      overrideLabels: [],
      me: { name: 'Tien', role: role.value },
      projects: [{ id: 'p1', name: 'Yuyama AI', checked: true }],
    },
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock('../Toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

import { Permissions } from './AiPermissionsTab';

const member = {
  id: 'm1',
  name: 'Dev (TDD)',
  template: 'developer',
  ceiling: 'review',
  scope: 'assigned',
  assigned: [],
  connection: 'local',
  safeMode: false,
  workingDir: '/repo',
  pendingChange: null,
} as unknown as AiMember;

function wrap() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <Permissions member={member} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  update.mockResolvedValue({});
});
afterEach(cleanup);

describe('Permissions: the owner may go past a lock, after a warning', () => {
  it('a locked mode keeps its lock but opens a warning for the owner, who confirms it', async () => {
    role.value = 'owner';
    wrap();
    const locked = screen.getByTestId('perm-delete_tickets-allowed') as HTMLButtonElement;
    expect(locked.disabled).toBe(false);
    expect(locked.textContent).toContain('🔒');
    fireEvent.click(locked);
    expect(screen.getByRole('dialog').textContent).toContain('gone for good');
    const confirm = screen.getByTestId('confirm-owner') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true); // the acknowledgement first
    fireEvent.click(screen.getByTestId('widen-ack'));
    fireEvent.click(confirm);
    await waitFor(() => expect(update).toHaveBeenCalledWith('m1', { permissions: { delete_tickets: 'allowed' } }));
  });

  it('more than the template asks too, without the extra tick', async () => {
    role.value = 'owner';
    wrap();
    fireEvent.click(screen.getByTestId('perm-change_assignee-allowed'));
    expect(screen.getByTestId('widen-why').textContent).toContain('more than its role');
    fireEvent.click(screen.getByTestId('confirm-owner'));
    await waitFor(() => expect(update).toHaveBeenCalledWith('m1', { permissions: { change_assignee: 'allowed' } }));
  });

  it('stays greyed and closed for anyone else', () => {
    role.value = 'admin';
    wrap();
    expect((screen.getByTestId('perm-delete_tickets-allowed') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('perm-change_assignee-allowed') as HTMLButtonElement).disabled).toBe(true);
  });
});
