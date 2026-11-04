import { useQuery } from '@tanstack/react-query';
import { client } from './client';
import { aiKeys } from './ai';
import type { AiAuditEntry, AiSettings } from '../types/ai';

/** Safety and cost endpoints (design/screens/ai-safety-cost.md): hooks, plain calls and their types. */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Me {
  name: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
}

export interface Inbox {
  mentions: { ticketId: string; ticketTitle: string; commentId: string; author: string; text: string; at: string }[];
  questions: {
    runId: string;
    ticketId: string;
    ticketTitle: string;
    memberName: string | null;
    text: string;
    options: string[];
    askedAt: string | null;
    to: string | null;
  }[];
  approvals: number;
  me: Me;
}

export interface Notification {
  id: string;
  projectId: string;
  event: string;
  title: string;
  body: string;
  refKind: string | null;
  refId: string | null;
  memberId: string | null;
  urgent: boolean;
  inapp: boolean;
  desktop: boolean;
  held: boolean;
  data: { percent?: number; spent?: number; limit?: number; kind?: string };
  createdAt: string;
}

export interface CellUse {
  used: number;
  cap: number | null;
  full: boolean;
}

export interface LimitRow {
  memberId: string;
  name: string;
  provider: string;
  connection: string;
  metered: boolean;
  parallel: number;
  atCap: string;
  perRunMinutes: number | null;
  capPerRun: number | null;
  runs: CellUse | null;
  daily?: CellUse;
  monthly?: CellUse;
  tokens?: CellUse;
}

export interface Limits {
  board: {
    name: string;
    daily: CellUse;
    monthly: CellUse;
    tokens: CellUse;
    parallel: CellUse;
    runs: CellUse;
    atCap: string;
  };
  agents: LimitRow[];
}

export interface UsageDashboard {
  range: { key: string; since: string; until: string };
  tiles: {
    spend: number;
    monthSpend: number;
    monthBudget: number | null;
    today: number;
    dailyCap: number | null;
    forecast: number;
    forecastPerDay: number;
    forecastDate: string;
    forecastWithin: boolean;
    runs: number;
    apiRuns: number;
    localRuns: number;
  };
  days: {
    date: string;
    costUsd: number;
    runs: number;
    forecast: boolean;
    byAgent: { memberId: string; costUsd: number }[];
  }[];
  series: { memberId: string; name: string }[];
  agents: {
    memberId: string;
    name: string;
    provider: string | null;
    runs: number;
    tokens: number;
    seconds: number;
    costUsd: number;
    metered: boolean;
    monthlyCap: number | null;
    pctOfCap: number | null;
  }[];
  topRuns: { runId: string; ticketId: string; number: number; name: string; costUsd: number; tokensIn: number }[];
  tickets: { ticketId: string; title: string; runs: number; costUsd: number }[];
  prices: { updated: string; rows: { model: string; input: number; output: number }[] };
  boardDailyCap: number | null;
  boardMonthlyBudget: number | null;
  limits: Limits;
}

export interface ResumeInfo {
  pausedAt: string | null;
  pausedBy: string | null;
  windowStart: string;
  windowEnd: string;
  actions: { id: string; at: string; memberName: string; action: string; target: string | null; result: string }[];
  actionCount: number;
  spentToday: number;
  dailyCap: number | null;
  budgetsOk: boolean;
  safeBefore?: boolean;
  heldOrder?: { ticketId: string; memberId: string }[];
  members: {
    memberId: string;
    name: string;
    overBudget: boolean;
    overBudgetReason?: string | null;
    tokenRevoked: boolean;
    health?: string;
    paused?: boolean;
    pausedReason?: string | null;
    /** Tickets of queued work runs, oldest first. */
    held?: string[];
    /** Tickets with a question waiting for a person. */
    waitingForYou?: string[];
    /** Runs the pause cancelled. */
    cancelled?: { ticketId: string; step: number; at: string | null; runNumber: number }[];
  }[];
}

export interface Defaults {
  template: string;
  ceiling: string;
  deleteMode: string;
  dailyBudget: number | null;
  monthlyCap: number | null;
  updatedBy: string | null;
  updatedAt: string | null;
  canEdit: boolean;
}

export interface AuditDetail extends AiAuditEntry {
  trace: { text: string; trust: 'trusted' | 'data_only' | 'untrusted' | null; chip?: string }[];
  approval: {
    id: string;
    status: string;
    decidedBy: string | null;
    decidedAt?: string | null;
    note?: string | null;
  } | null;
}

export interface RevertPreviewRow {
  entryId: string;
  target: string | null;
  memberName: string;
  fields: string[];
  result: 'revert' | 'skip';
  reason: string | null;
  line: string | null;
}

export interface AuditPage {
  entries: AiAuditEntry[];
  counts: Record<string, number>;
  total: number;
  hasMore: boolean;
  nextBefore: number | null;
  retentionDays: number | null;
}

export interface AuditFilters {
  memberId?: string;
  result?: string;
  q?: string;
  actions?: string;
  since?: string;
  until?: string;
  runId?: string;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/** The person this browser acts as and their role. */
export function useAiMe(projectId: string) {
  return useQuery({
    queryKey: ['ai', 'me', projectId],
    queryFn: async () => (await client.get<Me>(`/projects/${projectId}/ai/me`)).data,
    enabled: !!projectId,
    staleTime: 60000,
  });
}

/** Inbox: mentions, questions and the approvals count. */
export function useAiInbox(projectId: string) {
  return useQuery({
    queryKey: ['ai', 'inbox', projectId],
    queryFn: async () => (await client.get<Inbox>(`/projects/${projectId}/ai/inbox`)).data,
    enabled: !!projectId,
    refetchInterval: 15_000,
  });
}

/** Usage dashboard for a range. */
export function useUsageDashboard(projectId: string, range: string, since?: string, until?: string) {
  return useQuery({
    queryKey: [...aiKeys.all, 'dashboard', projectId, range, since ?? '', until ?? ''],
    queryFn: async () =>
      (
        await client.get<UsageDashboard>(`/projects/${projectId}/ai/usage`, {
          params: { range, since: since || undefined, until: until || undefined },
        })
      ).data,
    enabled: !!projectId,
    refetchInterval: 15000,
  });
}

/** Budget alerts. */
export function useBudgetAlerts(projectId: string) {
  return useQuery({
    queryKey: ['ai', 'alerts', projectId],
    queryFn: async () => (await client.get<Notification[]>(`/projects/${projectId}/ai/alerts`)).data,
    enabled: !!projectId,
    refetchInterval: 20000,
  });
}

/** Facts for the Resume dialog. */
export function useResumeInfo(projectId: string, enabled = true) {
  return useQuery({
    queryKey: ['ai', 'resume-info', projectId],
    queryFn: async () => (await client.get<ResumeInfo>(`/projects/${projectId}/ai/resume-info`)).data,
    enabled: !!projectId && enabled,
  });
}

/** Workspace defaults. */
export function useWorkspaceDefaults(projectId: string) {
  return useQuery({
    queryKey: ['ai', 'defaults', projectId],
    queryFn: async () => (await client.get<Defaults>(`/projects/${projectId}/ai/workspace-defaults`)).data,
    enabled: !!projectId,
  });
}

/** The audit log with filters; pages are appended by the view. */
export async function fetchAudit(projectId: string, f: AuditFilters, beforeSeq?: number, limit = 50) {
  return (
    await client.get<AuditPage>(`/projects/${projectId}/ai/audit`, {
      params: {
        member_id: f.memberId || undefined,
        result: f.result || undefined,
        q: f.q || undefined,
        actions: f.actions || undefined,
        since: f.since || undefined,
        until: f.until || undefined,
        run_id: f.runId || undefined,
        before_seq: beforeSeq,
        limit,
      },
    })
  ).data;
}

/** Query string of an export link with the audit filters on screen. */
export function auditExportQuery(f: AuditFilters, format: 'csv' | 'json'): string {
  const p = new URLSearchParams({ format });
  if (f.memberId) p.set('member_id', f.memberId);
  if (f.result) p.set('result', f.result);
  if (f.q) p.set('q', f.q);
  if (f.actions) p.set('actions', f.actions);
  if (f.since) p.set('since', f.since);
  if (f.until) p.set('until', f.until);
  return p.toString();
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export const safetyApi = {
  updateSettings: async (projectId: string, body: Record<string, unknown>) =>
    (await client.patch<AiSettings>(`/projects/${projectId}/ai/settings`, body)).data,
  notifications: async (projectId: string, after?: string) =>
    (
      await client.get<{ items: Notification[]; now: string }>(`/projects/${projectId}/ai/notifications`, {
        params: { after },
      })
    ).data,
  saveDefaults: async (projectId: string, body: Omit<Defaults, 'canEdit' | 'updatedBy' | 'updatedAt'>) =>
    (await client.put<Defaults>(`/projects/${projectId}/ai/workspace-defaults`, body)).data,
  auditEntry: async (id: string) => (await client.get<AuditDetail>(`/ai/audit/${id}`)).data,
  revertPreview: async (entryIds: string[]) =>
    (await client.post<RevertPreviewRow[]>('/ai/audit/revert-preview', { entryIds })).data,
};
