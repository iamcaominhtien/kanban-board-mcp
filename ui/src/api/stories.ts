import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { client } from './client';
import { SAFETY_POLL_MS } from './pollIntervals';
import { ticketKeys } from './tickets';
import type { CreateStoryBody, Decision, DecisionList, StoryApprove, StoryDetail, StoryView } from '../types/story';

/**
 * Story and Decisions endpoints (docs/specs/ai-story-flow-implementation.md, "Story API" and "Decisions API").
 * A Story's id is its ticket's id.
 */
export const storyKeys = {
  list: (projectId: string) => ['stories', projectId] as const,
  detail: (storyId: string) => ['story', storyId] as const,
  decisions: (projectId: string) => ['ai', 'decisions', projectId] as const,
};

export interface DecisionFilter {
  story?: string;
  kind?: string;
  overridden?: boolean;
  since?: string;
  limit?: number;
}

export const storiesApi = {
  list: async (projectId: string) => (await client.get<StoryView[]>(`/projects/${projectId}/stories`)).data,
  get: async (storyId: string) => (await client.get<StoryDetail>(`/stories/${storyId}`)).data,
  create: async (projectId: string, body: CreateStoryBody) =>
    (await client.post<StoryView>(`/projects/${projectId}/stories`, body)).data,
  hand: async (storyId: string, body: { approve?: StoryApprove; budgetTokens?: number }) =>
    (await client.post<StoryView>(`/stories/${storyId}/hand`, body)).data,
  makeStory: async (ticketId: string) => (await client.post<StoryView>(`/tickets/${ticketId}/make-story`)).data,
  approvePlan: async (storyId: string) => (await client.post<StoryView>(`/stories/${storyId}/plan/approve`)).data,
  rejectPlan: async (storyId: string, note?: string) =>
    (await client.post<StoryView>(`/stories/${storyId}/plan/reject`, note ? { note } : {})).data,
  revisePlan: async (storyId: string, note: string) =>
    (await client.post<StoryView>(`/stories/${storyId}/plan/revise`, { note })).data,
  editPlan: async (storyId: string, items: { ticketId: string; after: string[] }[]) =>
    (await client.patch<StoryView>(`/stories/${storyId}/plan`, { items })).data,
  pause: async (storyId: string) => (await client.post<StoryView>(`/stories/${storyId}/pause`)).data,
  resume: async (storyId: string) => (await client.post<StoryView>(`/stories/${storyId}/resume`)).data,
  reopen: async (storyId: string) => (await client.post<StoryView>(`/stories/${storyId}/reopen`)).data,
  drop: async (storyId: string) => (await client.post<StoryView>(`/stories/${storyId}/drop`)).data,
  patch: async (storyId: string, body: { budgetTokens?: number; approve?: StoryApprove }) =>
    (await client.patch<StoryView>(`/stories/${storyId}`, body)).data,
  decisions: async (projectId: string, filter: DecisionFilter = {}) =>
    (await client.get<DecisionList>(`/projects/${projectId}/ai/decisions`, { params: filter })).data,
  override: async (decisionId: string, note?: string) =>
    (await client.post<Decision>(`/ai/decisions/${decisionId}/override`, note ? { note } : {})).data,
};

/** Every Story of a project (the board, the picker). */
export function useStories(projectId: string) {
  return useQuery({
    queryKey: storyKeys.list(projectId),
    queryFn: () => storiesApi.list(projectId),
    enabled: !!projectId,
    retry: false,
    refetchInterval: SAFETY_POLL_MS,
  });
}

/** One Story with its decisions and children (the Story page). */
export function useStory(storyId: string) {
  return useQuery({
    queryKey: storyKeys.detail(storyId),
    queryFn: () => storiesApi.get(storyId),
    enabled: !!storyId,
    retry: false,
    refetchInterval: SAFETY_POLL_MS,
  });
}

/** Decisions the PM took in a person's place. */
export function useDecisions(projectId: string, filter: DecisionFilter = {}) {
  return useQuery({
    queryKey: [...storyKeys.decisions(projectId), filter],
    queryFn: () => storiesApi.decisions(projectId, filter),
    enabled: !!projectId,
    retry: false,
  });
}

/** After a change to a Story: its list, its page, the board's tickets and the decisions. */
function refresh(qc: QueryClient, projectId: string | undefined, storyId?: string) {
  if (projectId) {
    void qc.invalidateQueries({ queryKey: storyKeys.list(projectId) });
    void qc.invalidateQueries({ queryKey: ticketKeys.all(projectId) });
    void qc.invalidateQueries({ queryKey: storyKeys.decisions(projectId) });
  } else {
    void qc.invalidateQueries({ queryKey: ['stories'] });
    void qc.invalidateQueries({ queryKey: ['tickets'] });
  }
  if (storyId) {
    void qc.invalidateQueries({ queryKey: storyKeys.detail(storyId) });
    void qc.invalidateQueries({ queryKey: ticketKeys.detail(storyId) });
  }
}

/** Give a new Story to the PM (or keep it as a Draft with `hand: false`). */
export function useCreateStory(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateStoryBody) => storiesApi.create(projectId, body),
    onSuccess: (s) => refresh(qc, projectId, s.id),
  });
}

/** Turn a ticket (with or without children) into a Story. */
export function useMakeStory(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ticketId: string) => storiesApi.makeStory(ticketId),
    onSuccess: (s, ticketId) => refresh(qc, projectId, s?.id ?? ticketId),
  });
}

type StoryAction =
  | { kind: 'hand'; approve?: StoryApprove; budgetTokens?: number }
  | { kind: 'approve' }
  | { kind: 'reject'; note?: string }
  | { kind: 'revise'; note: string }
  | { kind: 'edit'; items: { ticketId: string; after: string[] }[] }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'reopen' }
  | { kind: 'drop' }
  | { kind: 'patch'; budgetTokens?: number; approve?: StoryApprove };

function runAction(storyId: string, a: StoryAction): Promise<StoryView> {
  switch (a.kind) {
    case 'hand':
      return storiesApi.hand(storyId, { approve: a.approve, budgetTokens: a.budgetTokens });
    case 'approve':
      return storiesApi.approvePlan(storyId);
    case 'reject':
      return storiesApi.rejectPlan(storyId, a.note);
    case 'revise':
      return storiesApi.revisePlan(storyId, a.note);
    case 'edit':
      return storiesApi.editPlan(storyId, a.items);
    case 'pause':
      return storiesApi.pause(storyId);
    case 'resume':
      return storiesApi.resume(storyId);
    case 'reopen':
      return storiesApi.reopen(storyId);
    case 'drop':
      return storiesApi.drop(storyId);
    case 'patch':
      return storiesApi.patch(storyId, { budgetTokens: a.budgetTokens, approve: a.approve });
  }
}

/** Every action on one Story: hand, plan approve / reject / revise / edit, pause, resume, reopen, drop, patch. */
export function useStoryAction(storyId: string, projectId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: StoryAction) => runAction(storyId, a),
    onSuccess: () => refresh(qc, projectId, storyId),
  });
}

/** Reverse a decision the PM took; a 409 says why it can no longer be. */
export function useOverrideDecision(projectId?: string, storyId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, note }: { id: string; note?: string }) => storiesApi.override(id, note),
    onSuccess: () => refresh(qc, projectId, storyId),
  });
}
