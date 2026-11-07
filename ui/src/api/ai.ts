import { LIVE_POLL_MS, SAFETY_POLL_MS } from './pollIntervals';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import camelcaseKeys from 'camelcase-keys';
import { client } from './client';
import { mergeSteps } from './aiRunCache';
import type {
  AiLive,
  AiOverview,
  AiRun,
  AiRunFull,
  AiSettings,
  AiTeam,
  BoardRun,
  RunMessage,
  RunnerInfo,
  RunState,
  RunStep,
  TeamPack,
  AiTeamRole,
} from '../types/ai';
import { ACTIVE_STATES } from '../types/ai';

export const aiKeys = {
  all: ['ai'] as const,
  overview: (projectId: string) => ['ai', 'overview', projectId] as const,
  board: (projectId: string) => ['ai', 'board', projectId] as const,
  settings: (projectId: string) => ['ai', 'settings', projectId] as const,
  teams: (projectId: string) => ['ai', 'teams', projectId] as const,
  team: (id: string) => ['ai', 'team', id] as const,
  run: (id: string) => ['ai', 'run', id] as const,
  runMessages: (id: string) => ['ai', 'run', id, 'messages'] as const,
  ticketRuns: (ticketId: string) => ['ai', 'ticketRuns', ticketId] as const,
  projectRuns: (projectId: string, state?: string) => ['ai', 'runs', projectId, state ?? ''] as const,
  live: (projectId: string) => ['ai', 'live', projectId] as const,
  packs: ['ai', 'packs', 'teams'] as const,
  roles: ['ai', 'packs', 'roles'] as const,
};

/** Whether a run is still going (queued, starting, running or waiting for an answer). */
export const isActive = (state: RunState | undefined) => !!state && ACTIVE_STATES.includes(state);

/** The board's cache: the newest run of each ticket, by ticket id. */
export interface AiBoardData {
  tickets: Record<string, BoardRun>;
}

// --------------------------------------------------------------------------- queries

/** The project's AI settings (permission mode, deny list, lessons, limits, the kill switch). */
export function useAiSettings(projectId: string) {
  return useQuery({
    queryKey: aiKeys.settings(projectId),
    queryFn: async () => (await client.get<AiSettings>(`/projects/${projectId}/ai/settings`)).data,
    enabled: !!projectId,
    refetchInterval: SAFETY_POLL_MS,
  });
}

/** Counts for the AI Team page and the header: teams, runs by state, what is active. */
export function useAiOverview(projectId: string) {
  return useQuery({
    queryKey: aiKeys.overview(projectId),
    queryFn: async () => (await client.get<AiOverview>(`/projects/${projectId}/ai/overview`)).data,
    enabled: !!projectId,
    refetchInterval: (q) => (q.state.data?.active.length ? LIVE_POLL_MS : SAFETY_POLL_MS),
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

/**
 * The newest run of every ticket: the board's card footers and the kill switch. The ticket ids key a dict, so the
 * response keeps its keys ("IAM-12" would be camel-cased into "iam12") and each entry is converted by hand.
 */
export function useAiBoard(projectId: string) {
  return useQuery({
    queryKey: aiKeys.board(projectId),
    queryFn: async (): Promise<AiBoardData> => {
      const raw = (
        await client.get<{ tickets: Record<string, Record<string, unknown>> }>(`/projects/${projectId}/ai/board`, {
          keepKeys: true,
        })
      ).data;
      const tickets: Record<string, BoardRun> = {};
      for (const [ticketId, entry] of Object.entries(raw.tickets ?? {})) {
        tickets[ticketId] = { ...(camelcaseKeys(entry, { deep: true }) as unknown as BoardRun), ticketId };
      }
      return { tickets };
    },
    enabled: !!projectId,
    refetchInterval: (q) =>
      Object.values(q.state.data?.tickets ?? {}).some((r) => isActive(r.state)) ? LIVE_POLL_MS : SAFETY_POLL_MS,
  });
}

/** The project's teams. */
export function useAiTeams(projectId: string, includeRemoved = false) {
  return useQuery({
    queryKey: [...aiKeys.teams(projectId), includeRemoved] as const,
    queryFn: async () =>
      (
        await client.get<AiTeam[]>(`/projects/${projectId}/ai/teams`, {
          params: includeRemoved ? { include_removed: true } : undefined,
        })
      ).data,
    enabled: !!projectId,
    refetchInterval: SAFETY_POLL_MS,
  });
}

/** One team. */
export function useAiTeam(id: string | null) {
  return useQuery({
    queryKey: aiKeys.team(id ?? ''),
    queryFn: async () => (await client.get<AiTeam>(`/ai/teams/${id}`)).data,
    enabled: !!id,
    refetchInterval: LIVE_POLL_MS,
  });
}

/** The ready-made team packs (which roles a team brings). */
export function useTeamPacks() {
  return useQuery({
    queryKey: aiKeys.packs,
    queryFn: async () => (await client.get<TeamPack[]>('/ai/packs/teams')).data,
    staleTime: Infinity,
  });
}

/** Every ready-made role (the roles a team may add). */
export function useRoleCatalogue() {
  return useQuery({
    queryKey: aiKeys.roles,
    queryFn: async () => (await client.get<AiTeamRole[]>('/ai/packs/roles')).data,
    staleTime: Infinity,
  });
}

/** Run history of a ticket (newest first), without steps. */
export function useTicketRuns(ticketId: string | undefined) {
  return useQuery({
    queryKey: aiKeys.ticketRuns(ticketId ?? ''),
    queryFn: async () => (await client.get<AiRun[]>(`/tickets/${ticketId}/ai/runs`)).data,
    enabled: !!ticketId,
    refetchInterval: (q) => (q.state.data?.some((r) => isActive(r.state)) ? LIVE_POLL_MS : SAFETY_POLL_MS),
  });
}

/** The project's runs (Run history), newest first, without steps. */
export function useProjectRuns(projectId: string, opts: { state?: string; limit?: number } = {}) {
  return useQuery({
    queryKey: aiKeys.projectRuns(projectId, opts.state),
    queryFn: async () =>
      (
        await client.get<AiRun[]>(`/projects/${projectId}/ai/runs`, {
          params: { limit: opts.limit ?? 60, state: opts.state || undefined },
        })
      ).data,
    enabled: !!projectId,
    refetchInterval: SAFETY_POLL_MS,
  });
}

/** One run with its subagents and the newest steps. Steps arrive over SSE (aiRunCache.ts) and by page. */
export function useAiRun(id: string | null | undefined) {
  return useQuery({
    queryKey: aiKeys.run(id ?? ''),
    queryFn: async () => (await client.get<AiRunFull>(`/ai/runs/${id}`, { params: { steps: 50 } })).data,
    enabled: !!id,
    refetchInterval: (q) => (isActive(q.state.data?.state) ? LIVE_POLL_MS : false),
  });
}

/** Several runs with their subagents and newest steps at once (the ticket's Timeline); the same cache as `useAiRun`. */
export function useAiRuns(ids: string[]) {
  return useQueries({
    queries: ids.map((id) => ({
      queryKey: aiKeys.run(id),
      queryFn: async () => (await client.get<AiRunFull>(`/ai/runs/${id}`, { params: { steps: 50 } })).data,
      refetchInterval: (q: { state: { data?: AiRunFull } }) => (isActive(q.state.data?.state) ? LIVE_POLL_MS : false),
    })),
  });
}

/** Messages into and out of a run (a person's notes, other AI sessions). */
export function useRunMessages(runId: string | null | undefined) {
  return useQuery({
    queryKey: aiKeys.runMessages(runId ?? ''),
    queryFn: async () => (await client.get<RunMessage[]>(`/ai/runs/${runId}/messages`)).data,
    enabled: !!runId,
  });
}

/** The newest steps of every active run of the project. */
export function useAiLive(projectId: string) {
  return useQuery({
    queryKey: aiKeys.live(projectId),
    queryFn: async () => (await client.get<AiLive>(`/projects/${projectId}/ai/live`)).data,
    enabled: !!projectId,
    refetchInterval: (q) => (q.state.data?.runs.length ? LIVE_POLL_MS : SAFETY_POLL_MS),
  });
}

// --------------------------------------------------------------------------- mutations

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

/**
 * Fetch a page of a run's steps (`after` a seq; `agent` = `lead` or a subagent id) and merge it into the run's cache,
 * so the tree shows them. Returns how many steps the page held.
 */
export function useLoadSteps(runId: string) {
  const qc = useQueryClient();
  return async (opts: { after?: number; agent?: string; limit?: number } = {}): Promise<RunStep[]> => {
    const steps = await aiApi.runSteps(runId, opts);
    qc.setQueryData<AiRunFull>(aiKeys.run(runId), (old) =>
      old ? { ...old, steps: mergeSteps(old.steps, steps) } : old,
    );
    return steps;
  };
}

export const aiApi = {
  createTeam: async (projectId: string, body: Record<string, unknown>) =>
    (await client.post<AiTeam>(`/projects/${projectId}/ai/teams`, body)).data,
  updateTeam: async (id: string, body: Record<string, unknown>) =>
    (await client.patch<AiTeam>(`/ai/teams/${id}`, body)).data,
  pauseTeam: async (id: string, body: { cancelCurrent?: boolean; reason?: string } = {}) =>
    (await client.post<AiTeam>(`/ai/teams/${id}/pause`, body)).data,
  resumeTeam: async (id: string) => (await client.post<AiTeam>(`/ai/teams/${id}/resume`)).data,
  testTeam: async (id: string) =>
    (await client.post<{ ok: boolean; health: string; message: string; version?: string }>(`/ai/teams/${id}/test`))
      .data,
  removalImpact: async (id: string) =>
    (
      await client.get<{
        openTickets: { id: string; title: string; status: string }[];
        activeRuns: { id: string; ticketId: string; number: number; state: string }[];
      }>(`/ai/teams/${id}/removal-impact`)
    ).data,
  removeTeam: async (id: string, body: { tickets: 'reassign' | 'unassign'; reassignTo?: string }) =>
    (await client.post<{ removed: boolean }>(`/ai/teams/${id}/remove`, body)).data,
  updateSettings: async (projectId: string, body: Partial<AiSettings>) =>
    (await client.patch<AiSettings>(`/projects/${projectId}/ai/settings`, body)).data,
  pauseAll: async (projectId: string, body: { reason?: string; cancelRunning: boolean }) =>
    (await client.post<AiSettings>(`/projects/${projectId}/ai/pause-all`, body)).data,
  resumeAll: async (projectId: string) => (await client.post<AiSettings>(`/projects/${projectId}/ai/resume-all`)).data,
  /** Run the ticket's team on it. A lead already working on the ticket hears the instruction instead. */
  run: async (ticketId: string, body: { teamId?: string; instruction?: string; mode?: 'work' | 'ask' } = {}) =>
    (await client.post<AiRun>(`/tickets/${ticketId}/ai/run`, body)).data,
  cancel: async (runId: string) => (await client.post<AiRun>(`/ai/runs/${runId}/cancel`)).data,
  retry: async (runId: string) => (await client.post<AiRun>(`/ai/runs/${runId}/retry`)).data,
  answer: async (runId: string, text: string) => (await client.post<AiRun>(`/ai/runs/${runId}/answer`, { text })).data,
  message: async (runId: string, text: string) =>
    (await client.post<{ ok?: boolean; delivered?: boolean }>(`/ai/runs/${runId}/message`, { text })).data,
  runSteps: async (runId: string, opts: { after?: number; agent?: string; limit?: number } = {}) =>
    (
      await client.get<RunStep[]>(`/ai/runs/${runId}/steps`, {
        params: { after: opts.after || undefined, agent: opts.agent, limit: opts.limit },
      })
    ).data,
  /** `/compact` in the ticket chat: "queued" when the lead is working (it compacts after its step), "done" with the
   * tokens before and after when the lead was idle. */
  compact: async (ticketId: string) =>
    (
      await client.post<{ state: 'queued' | 'done'; runId?: string; before?: number; after?: number }>(
        `/tickets/${ticketId}/ai/compact`,
      )
    ).data,
  stepOutput: async (runId: string, seq: number) =>
    (await client.get<RunStep>(`/ai/runs/${runId}/steps/${seq}/output`)).data,
};
