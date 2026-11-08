// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiTeam } from '../../types/ai';
import { ToastProvider } from '../Toast';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock('../../api/client', () => ({ client: http }));
vi.mock('../notifications/NotificationsHost', () => ({ NotificationBellButton: () => null }));

import { AddTeamModal } from './AddTeamModal';
import { AiMembersPage } from './AiMembersPage';
import { AiProfile } from './AiProfile';
import { AiBoardContext } from './aiUi';

const roles = [
  {
    key: 'dev',
    name: 'Developer',
    description: 'Writes code',
    prompt: 'Code.',
    model: null,
    effort: null,
    tools: null,
    writes: 'worktree',
  },
  {
    key: 'reviewer',
    name: 'Reviewer',
    description: 'Reads diffs',
    prompt: 'Review.',
    model: 'sonnet',
    effort: null,
    tools: ['Read'],
    writes: 'nothing',
  },
];

const team = (over: Partial<AiTeam> = {}): AiTeam =>
  ({
    id: 't1',
    projectId: 'p1',
    name: 'Team An',
    color: '#2E6F40',
    kind: 'ai',
    provider: 'claude-code',
    description: '',
    workingDir: '/code/app',
    model: 'sonnet',
    effort: null,
    persona: '',
    packKey: 'standard',
    packName: 'Standard feature',
    roles,
    config: { roles: [{ key: 'qa', off: true }] },
    permissionMode: 'bypass',
    maxParallel: 2,
    paused: false,
    health: 'ok',
    healthDetail: null,
    accountId: null,
    accountRef: null,
    status: { code: 'idle', label: 'Idle', detail: null },
    running: [],
    slotsInUse: 0,
    queued: 0,
    assigned: [{ id: 'KAN-4', title: 'Add a filter', status: 'todo' }],
    usage: { runsToday: 3, costToday: 0.5, tokensToday: 100 },
    lastRun: null,
    createdAt: '2026-11-01T00:00:00Z',
    ...over,
  }) as AiTeam;

function mount(node: React.ReactNode) {
  http.get.mockImplementation((url: string) => {
    if (url === '/ai/packs/teams')
      return Promise.resolve({
        data: [
          {
            key: 'standard',
            name: 'Standard feature',
            description: 'Dev, Reviewer, QA',
            roles: ['dev', 'reviewer', 'qa'],
          },
          { key: 'bugfix', name: 'Quick fix', description: 'Dev and Reviewer', roles: ['dev', 'reviewer'] },
        ],
      });
    if (url === '/ai/packs/roles')
      return Promise.resolve({
        data: [
          ...roles,
          {
            key: 'qa',
            name: 'QA',
            description: 'Checks',
            prompt: '',
            model: null,
            effort: null,
            tools: null,
            writes: 'tests',
          },
        ],
      });
    if (url === '/projects/p1/ai/teams') return Promise.resolve({ data: [team()] });
    if (url === '/ai/teams/t1') return Promise.resolve({ data: team() });
    if (url === '/projects/p1/ai/overview')
      return Promise.resolve({
        data: { projectId: 'p1', pausedAll: false, teams: [], runs: { needsInput: 1 }, active: [] },
      });
    if (url === '/ai/accounts') return Promise.resolve({ data: { accounts: [], clis: [] } });
    if (url === '/ai/accounts-on-this-computer') return Promise.resolve({ data: [] });
    return Promise.resolve({ data: [] });
  });
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <AiBoardContext.Provider
          value={{ projectId: 'p1', members: new Map(), runsByTicket: new Map(), settings: null }}
        >
          {node}
        </AiBoardContext.Provider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('AddTeamModal', () => {
  it('asks for a name and a folder before it adds anything', async () => {
    mount(<AddTeamModal projectId="p1" projectName="Kanban" onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('add-team-submit'));
    expect(await screen.findByText('Give the team a name')).toBeTruthy();
    expect(screen.getByText('Choose the folder runs start in')).toBeTruthy();
    expect(http.post).not.toHaveBeenCalled();
  });

  it('creates a team with the pack, model and persona picked, then opens its page', async () => {
    http.post.mockResolvedValue({ data: team({ id: 'tNew' }) });
    const onOpen = vi.fn();
    mount(<AddTeamModal projectId="p1" projectName="Kanban" onClose={vi.fn()} onOpenProfile={onOpen} />);
    fireEvent.change(screen.getByTestId('team-name'), { target: { value: 'Backend' } });
    fireEvent.change(screen.getByTestId('team-working-dir'), { target: { value: '~/dev/app' } });
    fireEvent.change(screen.getByTestId('team-model'), { target: { value: 'haiku' } });
    fireEvent.change(screen.getByTestId('team-persona'), { target: { value: 'Be terse.' } });
    fireEvent.click(await screen.findByTestId('team-pack-bugfix'));
    fireEvent.click(screen.getByTestId('add-team-submit'));
    await waitFor(() =>
      expect(http.post).toHaveBeenCalledWith('/projects/p1/ai/teams', {
        name: 'Backend',
        workingDir: '~/dev/app',
        model: 'haiku',
        packKey: 'bugfix',
        persona: 'Be terse.',
      }),
    );
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith('tNew'));
  });

  it('shows the reason the server gives', async () => {
    http.post.mockRejectedValue({ response: { data: { detail: 'There is already a team with that name.' } } });
    mount(<AddTeamModal projectId="p1" projectName="Kanban" onClose={vi.fn()} />);
    fireEvent.change(screen.getByTestId('team-name'), { target: { value: 'Backend' } });
    fireEvent.change(screen.getByTestId('team-working-dir'), { target: { value: '/x' } });
    fireEvent.click(screen.getByTestId('add-team-submit'));
    expect((await screen.findByTestId('add-team-error')).textContent).toContain('already a team');
  });
});

describe('AiMembersPage', () => {
  it('lists the teams with their role chips, status and account', async () => {
    mount(
      <AiMembersPage
        projectId="p1"
        projectName="Kanban"
        humans={[]}
        onBack={vi.fn()}
        onOpenTicket={vi.fn()}
        onOpenMembersModal={vi.fn()}
      />,
    );
    const row = await screen.findByTestId('ai-row-Team An');
    expect(within(row).getByTestId('role-chips').textContent).toContain('Reviewer');
    expect(row.textContent).toContain('Idle');
    expect(row.textContent).toContain('3 runs');
    expect(await screen.findByText(/1 waiting for an answer/)).toBeTruthy();
  });

  it('pauses a team from its menu', async () => {
    http.post.mockResolvedValue({ data: team({ paused: true }) });
    mount(
      <AiMembersPage
        projectId="p1"
        projectName="Kanban"
        humans={[]}
        onBack={vi.fn()}
        onOpenTicket={vi.fn()}
        onOpenMembersModal={vi.fn()}
      />,
    );
    await screen.findByTestId('ai-row-Team An');
    fireEvent.click(screen.getByLabelText('More actions for Team An'));
    fireEvent.click(screen.getByTestId('ai-pause-Team An'));
    await waitFor(() => expect(http.post).toHaveBeenCalledWith('/ai/teams/t1/pause', {}));
  });
});

describe('AiProfile', () => {
  const open = () => mount(<AiProfile member={team()} projectId="p1" humans={[]} onOpenTicket={vi.fn()} />);

  it('shows the roles of the pack and the ones turned off', async () => {
    open();
    expect(await screen.findByTestId('role-dev')).toBeTruthy();
    expect(screen.getByTestId('role-reviewer')).toBeTruthy();
    expect((await screen.findByTestId('roles-off')).textContent).toContain('QA (turn on)');
  });

  it('saves a role model as an override and keeps the others', async () => {
    http.patch.mockResolvedValue({ data: team() });
    open();
    const row = await screen.findByTestId('role-reviewer');
    fireEvent.change(within(row).getByLabelText('Reviewer model'), { target: { value: 'opus' } });
    fireEvent.click(within(row).getByTestId('role-save-reviewer'));
    await waitFor(() =>
      expect(http.patch).toHaveBeenCalledWith('/ai/teams/t1', {
        config: {
          roles: [
            { key: 'qa', off: true },
            { key: 'reviewer', model: 'opus' },
          ],
        },
      }),
    );
  });

  it('turns a role off', async () => {
    http.patch.mockResolvedValue({ data: team() });
    open();
    fireEvent.click(await screen.findByTestId('role-off-dev'));
    await waitFor(() =>
      expect(http.patch).toHaveBeenCalledWith('/ai/teams/t1', {
        config: {
          roles: [
            { key: 'qa', off: true },
            { key: 'dev', off: true },
          ],
        },
      }),
    );
  });

  it('changes the permission mode', async () => {
    http.patch.mockResolvedValue({ data: team({ permissionMode: 'auto' }) });
    open();
    fireEvent.click(await screen.findByTestId('permission-auto'));
    await waitFor(() => expect(http.patch).toHaveBeenCalledWith('/ai/teams/t1', { permissionMode: 'auto' }));
  });
});
