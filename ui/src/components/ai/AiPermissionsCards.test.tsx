// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiApproval } from '../../types/ai';
import type { AiPermissions, BlocksReport } from '../../api/aiSafety';

const api = vi.hoisted(() => ({
  approve: vi.fn(),
  deny: vi.fn(),
  savePermissions: vi.fn(),
  revokeGrant: vi.fn(),
}));
const data = vi.hoisted(() => ({ permissions: null as unknown, blocks: null as unknown }));
vi.mock('../../api/aiSafety', async (orig) => ({
  ...(await orig<typeof import('../../api/aiSafety')>()),
  safetyApi: api,
  useAiPermissions: () => ({ data: data.permissions, isError: false }),
  useAiBlocks: () => ({ data: data.blocks, isLoading: false, isError: false }),
  useAlwaysGrants: () => ({ data: [] }),
}));
vi.mock('../Toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

import { BlocksCard, PermissionsCard } from './AiPermissionsCards';
import { ApprovalCard } from './AiInbox';

function wrap(ui: React.ReactElement) {
  return render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
}

const perms = (over: Partial<AiPermissions> = {}): AiPermissions => ({
  preset: 'normal',
  bypass: 'member',
  webSearch: 'roles',
  askCli: true,
  docsAsk: false,
  presets: [
    { key: 'careful', label: 'Careful', line: 'No Bypass.', bypass: 'never', webSearch: 'off', docsAsk: true },
    {
      key: 'normal',
      label: 'Normal',
      line: 'Each role gets what it needs.',
      bypass: 'member',
      webSearch: 'roles',
      docsAsk: false,
    },
    {
      key: 'trusted',
      label: 'Trusted',
      line: 'Bypass for every run.',
      bypass: 'always',
      webSearch: 'on',
      docsAsk: false,
    },
  ],
  roles: [
    { role: 'dev', words: 'installs packages and runs the tests', tools: ['Bash(npm install:*)'], webSearch: true },
  ],
  webSearchRoles: ['pm', 'ba', 'designer', 'dev'],
  canEdit: true,
  canTrust: true,
  ...over,
});

const toolAsk = (over: Partial<AiApproval> = {}) =>
  ({
    id: 'apr_1',
    projectId: 'p1',
    memberId: 'm1',
    memberName: 'Dev (TDD)',
    runId: 'run_1',
    ticketId: 'KAN-142',
    action: 'use_tool',
    summary: 'Let Dev (TDD) run `npm install left-pad`',
    params: {},
    reason: 'The CLI refused it',
    risk: 'medium',
    status: 'pending',
    onBehalfOf: 'An Nguyen',
    requestedAt: '2026-11-02T10:00:00Z',
    expiresAt: '2026-11-03T10:00:00Z',
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    run: { id: 'run_1', number: 4, state: 'finished', trigger: 'assign', startedBy: 'An Nguyen' },
    canDecide: true,
    scopes: ['ticket', 'project', 'role'],
    toolRule: 'Bash(npm install:*)',
    toolCall: 'run `npm install left-pad`',
    role: 'dev',
    ...over,
  }) as AiApproval;

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('PermissionsCard', () => {
  it('shows the three presets with a line each and saves the one picked', async () => {
    data.permissions = perms();
    api.savePermissions.mockResolvedValue(perms({ preset: 'careful' }));
    wrap(<PermissionsCard projectId="p1" />);
    expect(screen.getByText('Each role gets what it needs.')).toBeTruthy();
    fireEvent.click(screen.getByText('Careful'));
    await waitFor(() => expect(api.savePermissions).toHaveBeenCalledWith('p1', { preset: 'careful' }));
    fireEvent.click(screen.getByText('Every role'));
    await waitFor(() => expect(api.savePermissions).toHaveBeenCalledWith('p1', { webSearch: 'on' }));
  });

  it('keeps Trusted for the owner', () => {
    data.permissions = perms({ canTrust: false });
    wrap(<PermissionsCard projectId="p1" />);
    expect((screen.getByText('Trusted').closest('button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('lists what each role runs without asking', () => {
    data.permissions = perms();
    wrap(<PermissionsCard projectId="p1" />);
    fireEvent.click(screen.getByTestId('ai-role-tools-toggle'));
    expect(screen.getByText('installs packages and runs the tests')).toBeTruthy();
  });
});

describe('BlocksCard', () => {
  it('groups what stopped the AIs with a verdict and filters by it', () => {
    const report: BlocksReport = {
      since: '2026-10-03',
      days: 30,
      total: 3,
      byVerdict: { kept: 2, fixed: 1 },
      groups: [
        {
          key: 'board:change_status:status_ceiling',
          kind: 'board',
          title: 'Change status: refused (status ceiling)',
          count: 2,
          roles: ['dev'],
          members: ['Dev (TDD)'],
          firstAt: '2026-11-01T10:00:00Z',
          lastAt: '2026-11-02T10:00:00Z',
          example: 'Done is above the status ceiling',
          trying: 'manage ticket update KAN-142',
          verdict: 'kept',
          verdictText: 'A person decides past the ceiling.',
          refs: [],
        },
        {
          key: 'board:proof_path',
          kind: 'board',
          title: 'Evidence file not found in the working folder',
          count: 1,
          roles: ['qa'],
          members: ['QA'],
          firstAt: '2026-11-02T08:00:00Z',
          lastAt: '2026-11-02T08:00:00Z',
          example: 'qa/evidence/TC-6.png: no such file',
          trying: '',
          verdict: 'fixed',
          verdictText: 'The board looks in the worktree first.',
          refs: [],
        },
      ],
    };
    data.blocks = report;
    wrap(<BlocksCard projectId="p1" />);
    expect(screen.getByText('Kept on purpose')).toBeTruthy();
    expect(screen.getByTestId('ai-block-board:proof_path')).toBeTruthy();
    fireEvent.click(screen.getByText('Fixed · 1'));
    expect(screen.queryByTestId('ai-block-board:change_status:status_ceiling')).toBeNull();
  });
});

describe('ApprovalCard: ask once, then remember', () => {
  it('a refused tool is allowed for the scope picked and the run goes on', async () => {
    api.approve.mockResolvedValue({ ...toolAsk(), rule: 'Bash(npm install:*)', continuedRunId: 'run_2' });
    wrap(<ApprovalCard approval={toolAsk()} />);
    expect(screen.getByTestId('approval-rule').textContent).toBe('Bash(npm install:*)');
    fireEvent.click(screen.getByText('Always for every Dev'));
    expect(screen.getByTestId('approval-scope-hint').textContent).toContain('Only the owner');
    fireEvent.click(screen.getByTestId('approval-approve'));
    await waitFor(() => expect(api.approve).toHaveBeenCalledWith('apr_1', { scope: 'role', goOn: true }));
  });

  it('a board action is approved once by default, or remembered for the project', async () => {
    api.approve.mockResolvedValue(toolAsk({ action: 'change_assignee' }));
    wrap(
      <ApprovalCard
        approval={toolAsk({ action: 'change_assignee', scopes: ['once', 'ticket', 'project'], toolRule: null })}
      />,
    );
    expect(screen.getByTestId('approval-approve').textContent).toBe('Approve once');
    fireEvent.click(screen.getByText('For this project'));
    expect(screen.getByTestId('approval-approve').textContent).toBe('Approve & remember');
    fireEvent.click(screen.getByTestId('approval-approve'));
    await waitFor(() => expect(api.approve).toHaveBeenCalledWith('apr_1', { scope: 'project' }));
  });
});
