import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client';
import type {
  AiApproval,
  AiAuditEntry,
  AiMember,
  AiOverview,
  AiRun,
  AiSettings,
  DetectResult,
  PermissionRow,
  RunnerInfo,
} from '../types/ai';
import type { Ticket } from '../types';

export const aiKeys = {
  all: ['ai'] as const,
  overview: (projectId: string) => ['ai', 'overview', projectId] as const,
  board: (projectId: string) => ['ai', 'board', projectId] as const,
  member: (id: string) => ['ai', 'member', id] as const,
  usage: (id: string) => ['ai', 'usage', id] as const,
  permissions: (id: string) => ['ai', 'permissions', id] as const,
  ticketRuns: (ticketId: string) => ['ai', 'ticket-runs', ticketId] as const,
  run: (id: string) => ['ai', 'run', id] as const,
  approvals: (projectId: string, status?: string) => ['ai', 'approvals', projectId, status ?? 'all'] as const,
  audit: (projectId: string, filters: object) => ['ai', 'audit', projectId, filters] as const,
  projectUsage: (projectId: string) => ['ai', 'project-usage', projectId] as const,
};

/** Overview of the project's AI members (list page, members modal, pickers). */
export function useAiOverview(projectId: string) {
  return useQuery({
    queryKey: aiKeys.overview(projectId),
    queryFn: async () => (await client.get<AiOverview>(`/projects/${projectId}/ai/overview`)).data,
    enabled: !!projectId,
    refetchInterval: (q) => (q.state.data?.summary.runningNow ? 3000 : 15000),
  });
}

/** Where local runners run (this computer, or another one when this is the web build). Never changes while open. */
export function useRunnerInfo() {
  return useQuery({
    queryKey: ['ai', 'runner'] as const,
    queryFn: async () => (await client.get<RunnerInfo>('/ai/runner')).data,
    staleTime: Infinity,
    retry: false,
  });
}

/** Run state per ticket for the board (card footers, column indicators) and the kill switch. */
export function useAiBoard(projectId: string) {
  return useQuery({
    queryKey: aiKeys.board(projectId),
    queryFn: async () =>
      (await client.get<{ runs: AiRun[]; settings: AiSettings }>(`/projects/${projectId}/ai/board`)).data,
    enabled: !!projectId,
    refetchInterval: (q) =>
      q.state.data?.runs.some((r) => ['queued', 'starting', 'running'].includes(r.state)) ? 2000 : 15000,
  });
}

/** One AI member. */
export function useAiMember(id: string | null) {
  return useQuery({
    queryKey: aiKeys.member(id ?? ''),
    queryFn: async () => (await client.get<AiMember>(`/ai/members/${id}`)).data,
    enabled: !!id,
    refetchInterval: 5000,
  });
}

export interface MemberUsage {
  runsToday: number;
  runsLastHour: number;
  tokensInToday: number;
  tokensOutToday: number;
  costToday: number;
  costMonth: number;
  secondsToday: number;
  successRateWeek: number | null;
  days: { date: string; runs: number; costUsd: number; seconds: number }[];
  recentRuns: AiRun[];
  metered: boolean;
  dailyBudget: number | null;
  monthlyCap: number | null;
  maxRunsPerDay: number | null;
}

/** Usage tab. */
export function useAiUsage(id: string) {
  return useQuery({
    queryKey: aiKeys.usage(id),
    queryFn: async () => (await client.get<MemberUsage>(`/ai/members/${id}/usage`)).data,
  });
}

export interface PermissionsData {
  template: string;
  ceiling: string;
  scope: string;
  matrix: PermissionRow[];
  history: {
    id: string;
    at: string;
    by: string | null;
    byRole: string | null;
    kind: 'created' | 'changed';
    diffs: { action: string; label: string; from: string | null; to: string | null }[];
    other: { label: string; from: unknown; to: unknown }[];
    template?: string | null;
    ceiling?: string | null;
  }[];
  safeMode: boolean;
  agentSafeMode: boolean;
  pausedAll: boolean;
  overrideLabels: string[];
  me: { name: string; role: 'owner' | 'admin' | 'member' | 'viewer' };
  projects: { id: string; name: string; checked: boolean }[];
}

/** Permissions tab. */
export function useAiPermissions(id: string) {
  return useQuery({
    queryKey: aiKeys.permissions(id),
    queryFn: async () => (await client.get<PermissionsData>(`/ai/members/${id}/permissions`)).data,
  });
}

/** Run history of a ticket (newest first); polls while a run is active. */
export function useTicketRuns(ticketId: string | undefined) {
  return useQuery({
    queryKey: aiKeys.ticketRuns(ticketId ?? ''),
    queryFn: async () => (await client.get<AiRun[]>(`/tickets/${ticketId}/ai/runs`)).data,
    enabled: !!ticketId,
    refetchInterval: (q) =>
      q.state.data?.some((r) => ['queued', 'starting', 'running'].includes(r.state)) ? 1500 : 10000,
  });
}

/** Approvals of a project. */
export function useAiApprovals(projectId: string, status?: string) {
  return useQuery({
    queryKey: aiKeys.approvals(projectId, status),
    queryFn: async () =>
      (await client.get<AiApproval[]>(`/projects/${projectId}/ai/approvals`, { params: status ? { status } : {} }))
        .data,
    enabled: !!projectId,
    refetchInterval: 8000,
  });
}

/** Audit log page. */
export function useAiAudit(
  projectId: string,
  filters: { memberId?: string; result?: string; q?: string; runId?: string },
) {
  return useQuery({
    queryKey: aiKeys.audit(projectId, filters),
    queryFn: async () =>
      (
        await client.get<{ entries: AiAuditEntry[]; counts: Record<string, number>; total: number }>(
          `/projects/${projectId}/ai/audit`,
          {
            params: {
              member_id: filters.memberId || undefined,
              result: filters.result || undefined,
              q: filters.q || undefined,
              run_id: filters.runId || undefined,
            },
          },
        )
      ).data,
    enabled: !!projectId,
  });
}

export interface ProjectUsage {
  days: { date: string; costUsd: number; runs: number }[];
  agents: {
    memberId: string;
    name: string;
    runs: number;
    tokens: number;
    costUsd: number;
    seconds: number;
    metered: boolean;
  }[];
  tickets: { ticketId: string; runs: number; costUsd: number }[];
  topRuns: { runId: string; ticketId: string; number: number; name: string; costUsd: number; tokensIn: number }[];
  totalCost: number;
  totalRuns: number;
  boardDailyCap: number | null;
  boardMonthlyBudget: number | null;
  pricesUpdated: string;
}

/** Usage dashboard. */
export function useProjectAiUsage(projectId: string) {
  return useQuery({
    queryKey: aiKeys.projectUsage(projectId),
    queryFn: async () => (await client.get<ProjectUsage>(`/projects/${projectId}/ai/usage`)).data,
    enabled: !!projectId,
  });
}

/** Invalidate every AI query and the tickets (runs move tickets and post comments). */
function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: aiKeys.all });
    void qc.invalidateQueries({ queryKey: ['tickets'] });
    void qc.invalidateQueries({ queryKey: ['members'] });
  };
}

/** Generic AI mutation that refreshes the AI and ticket caches. */
export function useAiMutation<TVars, TOut>(fn: (v: TVars) => Promise<TOut>) {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: fn, onSuccess: () => invalidate() });
}

/** One row of “Undo run's changes”: a field to revert, or what stays (the files, the branch). */
export interface RevertRow {
  kind: 'field' | 'files' | 'branch';
  entryId?: string;
  ticketId?: string;
  field: string;
  from?: unknown;
  to?: unknown;
  current?: unknown;
  conflict: boolean;
  /** Who changed a conflicting field after the AI, and when. */
  editedBy?: string;
  editedAt?: string;
  count?: number;
  paths?: string[];
  name?: string;
  note?: string;
}

export const aiApi = {
  detect: async (provider: string, cliPath?: string) =>
    (await client.post<DetectResult>('/ai/detect', { provider, cliPath })).data,
  testRun: async (body: { provider: string; cliPath?: string; model?: string; workingDir?: string }) =>
    (await client.post<{ ok: boolean; seconds?: number; reply?: string; error?: string }>('/ai/test-run', body)).data,
  testKey: async (body: { provider: string; apiKey: string; baseUrl?: string }) =>
    (
      await client.post<{ ok: boolean; status: number | null; models?: string[]; error?: string; note?: string }>(
        '/ai/test-key',
        body,
      )
    ).data,
  checkName: async (projectId: string, name: string, exclude?: string) =>
    (
      await client.get<{ ok: boolean; conflict: string | null; message: string | null; suggestion: string | null }>(
        `/projects/${projectId}/ai/check-name`,
        { params: { name, exclude } },
      )
    ).data,
  create: async (projectId: string, body: Record<string, unknown>) =>
    (await client.post<AiMember>(`/projects/${projectId}/ai/members`, body)).data,
  update: async (id: string, body: Record<string, unknown>) =>
    (await client.patch<AiMember>(`/ai/members/${id}`, body)).data,
  pause: async (id: string, body: { cancelCurrent?: boolean; reason?: string } = {}) =>
    (await client.post<AiMember>(`/ai/members/${id}/pause`, body)).data,
  resume: async (id: string) => (await client.post<AiMember>(`/ai/members/${id}/resume`)).data,
  /** Skip a rate limit's wait: the queued runs try the provider again at once. */
  retryNow: async (id: string) => (await client.post<AiMember>(`/ai/members/${id}/retry-now`)).data,
  setProjects: async (id: string, projectIds: string[]) =>
    (await client.put(`/ai/members/${id}/projects`, { projectIds })).data,
  decidePending: async (id: string, decision: 'confirm' | 'reject') =>
    (await client.post<AiMember>(`/ai/members/${id}/permissions/pending/${decision}`)).data,
  test: async (id: string, full = true) =>
    (
      await client.post<{ ok: boolean; health: string; message: string; version?: string; account?: string }>(
        `/ai/members/${id}/test`,
        { full },
      )
    ).data,
  removalImpact: async (id: string) =>
    (
      await client.get<{
        openTickets: { id: string; title: string; status: string }[];
        activeRuns: { id: string; ticketId: string; number: number; state: string }[];
      }>(`/ai/members/${id}/removal-impact`)
    ).data,
  remove: async (id: string, body: { tickets: string; reassignTo?: string; runs: string }) =>
    (await client.post<{ removed: boolean; scheduled: boolean }>(`/ai/members/${id}/remove`, body)).data,
  testPermission: async (id: string, body: { action: string; ticketId?: string; targetStatus?: string }) =>
    (
      await client.post<{
        verdict: string;
        reason: string;
        checks: { label: string; ok: boolean; mode: string; note?: string }[];
      }>(`/ai/members/${id}/permissions/test`, body)
    ).data,
  updateSettings: async (projectId: string, body: Partial<AiSettings>) =>
    (await client.patch<AiSettings>(`/projects/${projectId}/ai/settings`, body)).data,
  pauseAll: async (projectId: string, body: { reason: string; cancelRunning: boolean; revokeTokens?: boolean }) =>
    (
      await client.post<{ cancelled: number; held: number; revokedTokens: number }>(
        `/projects/${projectId}/ai/pause-all`,
        body,
      )
    ).data,
  resumeAll: async (projectId: string, body: { safeMode: boolean; memberIds?: string[]; reviewed: boolean }) =>
    (await client.post(`/projects/${projectId}/ai/resume-all`, body)).data,
  assign: async (
    ticketId: string,
    body: { memberId: string; start: 'now' | 'queue' | 'none'; includeContext?: boolean; instruction?: string },
  ) => (await client.post<{ ticket: Ticket; run: AiRun | null }>(`/tickets/${ticketId}/ai/assign`, body)).data,
  run: async (ticketId: string, body: { memberId?: string; instruction?: string } = {}) =>
    (await client.post<AiRun>(`/tickets/${ticketId}/ai/run`, body)).data,
  ask: async (ticketId: string, body: { memberId: string; question: string; source?: string; ref?: string }) =>
    (await client.post<AiRun>(`/tickets/${ticketId}/ai/ask`, body)).data,
  cancel: async (runId: string, reason?: string) =>
    (await client.post<AiRun>(`/ai/runs/${runId}/cancel`, { reason })).data,
  /** Run again as run #n+1; `limitMin` gives that run a longer time limit ("Raise limit"). */
  retry: async (runId: string, limitMin?: number) =>
    (await client.post<AiRun>(`/ai/runs/${runId}/retry`, limitMin ? { limitMin } : undefined)).data,
  startNow: async (runId: string) => (await client.post<AiRun>(`/ai/runs/${runId}/start-now`)).data,
  pauseRun: async (runId: string) => (await client.post<AiRun>(`/ai/runs/${runId}/pause`)).data,
  resumeRun: async (runId: string) => (await client.post<AiRun>(`/ai/runs/${runId}/resume`)).data,
  /** “Ask someone else”: the question and Pending go to another person. */
  askSomeoneElse: async (runId: string, memberId: string) =>
    (await client.post<AiRun>(`/ai/runs/${runId}/ask-someone-else`, { memberId })).data,
  /** Regenerate an answer; with `question` the edited question is asked (Edit and re-run). */
  regenerate: async (runId: string, body: { question?: string; replace?: boolean } = {}) =>
    (await client.post<AiRun>(`/ai/runs/${runId}/regenerate`, body)).data,
  feedback: async (runId: string, rating: 'up' | 'down' | 'none', reasons: string[] = []) =>
    (await client.post<AiRun>(`/ai/runs/${runId}/feedback`, { rating, reasons })).data,
  refreshContext: async (runId: string) => (await client.post<AiRun>(`/ai/runs/${runId}/refresh-context`)).data,
  answer: async (runId: string, text: string) => (await client.post<AiRun>(`/ai/runs/${runId}/answer`, { text })).data,
  requestChanges: async (ticketId: string, text: string, continueSession: boolean) =>
    (await client.post<AiRun>(`/tickets/${ticketId}/ai/request-changes`, { text, continueSession })).data,
  takeOver: async (ticketId: string, memberId?: string) =>
    (await client.post<Ticket>(`/tickets/${ticketId}/ai/take-over`, { memberId })).data,
  revertPreview: async (runId: string) => (await client.get<RevertRow[]>(`/ai/runs/${runId}/revert-preview`)).data,
  revertRun: async (runId: string) =>
    (await client.post<{ entryId: string; result: string; reason?: string }[]>(`/ai/runs/${runId}/revert`)).data,
  revertEntries: async (entryIds: string[]) =>
    (await client.post<{ entryId: string; result: string; reason?: string }[]>('/ai/audit/revert', { entryIds })).data,
  approve: async (id: string, note?: string) =>
    (await client.post<AiApproval & { error?: string }>(`/ai/approvals/${id}/approve`, { note })).data,
  deny: async (id: string, note?: string, stopRun = false) =>
    (await client.post<AiApproval>(`/ai/approvals/${id}/deny`, { note, stopRun })).data,
  verifyAudit: async (projectId: string) =>
    (
      await client.get<{ ok: boolean; brokenAt: string | null; checked: number }>(
        `/projects/${projectId}/ai/audit/verify`,
      )
    ).data,
};
