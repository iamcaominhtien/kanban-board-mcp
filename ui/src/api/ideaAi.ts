import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client';
import { ideaKeys } from './ideas';
import type { ArchiveReason, AssumptionImpact, IdeaScope, SimilarItem } from '../types/idea';

const BASE = '/api/idea-ai';

export interface IdeaAiSettings {
  enabled: boolean;
  triageAdvice: boolean;
  weeklyGrooming: boolean;
  ask: boolean;
  readDocs: boolean;
  readRepo: boolean;
  dailyCap: number;
}

/** Whether AI help can answer now, and the switches behind it. */
export interface IdeaAiStatus {
  state: 'on' | 'off' | 'no_member' | 'unavailable' | 'cap';
  message: string;
  settings: IdeaAiSettings;
  member: string | null;
  spentToday: number;
  cap: number;
  /** An idea with no project: no repository to read, so no effort guess. */
  limited: boolean;
  hints: Record<'advice' | 'shape' | 'exists' | 'grooming' | 'ask' | 'ticket', number>;
}

export interface IdeaAdvice {
  id: string;
  ideaId: string;
  action: 'keep' | 'park' | 'merge' | 'archive';
  reason: string;
  confidence: 'high' | 'medium' | 'low';
  targetId: string | null;
  targetTitle: string | null;
  archiveReason: ArchiveReason | null;
  parkDays: number | null;
  cost: number;
  createdAt: string;
  /** The idea changed after the AI read it. */
  stale: boolean;
}

export interface ShapeResult {
  kind: 'problem' | 'assumptions' | 'tests' | 'effort' | 'exists' | 'ask';
  ai: true;
  member: string;
  memberId: string;
  cost: number;
  model?: string;
  problem?: string;
  idea?: string;
  assumptions?: { text: string; impact: AssumptionImpact; cheapestTest: string }[];
  tests?: { assumptionId: string; test: string }[];
  effort?: string;
  why?: string;
  files?: string[];
  summary?: string;
  items?: (SimilarItem & { why: string })[];
  found?: SimilarItem[];
  answer?: string;
}

export interface AskResult {
  answer: string;
  sources: { id: string; title: string }[];
  ideasRead: number;
  member: string;
  cost: number;
}

export interface PreparedTicket {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  subTickets: string[];
  member: string;
  cost: number;
}

export interface IdeaDigest {
  id: string;
  projectId: string | null;
  text: string;
  items: { kind: string; ideaIds: string[]; text: string }[];
  ai: boolean;
  cost: number;
  ideasRead: number;
  createdAt: string;
}

const key = {
  status: (projectId: string | null) => ['ideas', 'ai', 'status', projectId ?? ''] as const,
  advice: (ids: string[]) => ['ideas', 'ai', 'advice', ids] as const,
  digest: (projectId: string | null) => ['ideas', 'ai', 'digest', projectId ?? ''] as const,
};

/** Query: whether AI help is available for a project (null: ideas with no project). */
export function useIdeaAiStatus(projectId: string | null) {
  // while a switch is being saved, a refresh (the board refreshes on every server event) must not put the old value back
  const saving = useIsMutating({ mutationKey: ['idea-ai-settings'] }) > 0;
  return useQuery({
    queryKey: key.status(projectId),
    enabled: !saving,
    queryFn: async () =>
      (await client.get<IdeaAiStatus>(`${BASE}/status`, { params: { project_id: projectId ?? undefined } })).data,
  });
}

/** Mutation: change the AI switches of a project; the switch moves at once and goes back if the server refuses. */
export function useUpdateIdeaAiSettings(projectId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ['idea-ai-settings'],
    mutationFn: async (patch: Partial<IdeaAiSettings>) =>
      (await client.put<IdeaAiStatus>(`${BASE}/settings`, patch, { params: { project_id: projectId ?? undefined } }))
        .data,
    onMutate: (patch) => {
      void qc.cancelQueries({ queryKey: key.status(projectId) });
      const before = qc.getQueryData<IdeaAiStatus>(key.status(projectId));
      if (before) qc.setQueryData(key.status(projectId), { ...before, settings: { ...before.settings, ...patch } });
      return { before };
    },
    onError: (_e, _patch, ctx) => ctx?.before && qc.setQueryData(key.status(projectId), ctx.before),
    onSuccess: (data) => qc.setQueryData(key.status(projectId), data),
  });
}

/** Query: the open triage advice of some ideas. */
export function useIdeaAdvice(ideaIds: string[], enabled: boolean) {
  return useQuery({
    queryKey: key.advice(ideaIds),
    enabled: enabled && ideaIds.length > 0,
    queryFn: async () =>
      (
        await client.get<IdeaAdvice[]>(`${BASE}/advice`, {
          params: { idea_ids: ideaIds },
          paramsSerializer: { indexes: null },
        })
      ).data,
  });
}

/** Mutation: read Inbox ideas and suggest Keep, Park, Merge or Archive for each. Nothing is applied. */
export function useRequestAdvice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (ideaIds: string[]) =>
      (
        await client.post<{
          advice: IdeaAdvice[];
          none: string[];
          errors: { ideaId: string; code: string; message: string }[];
        }>(`${BASE}/advice`, { ideaIds })
      ).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ideas', 'ai'] });
      qc.invalidateQueries({ queryKey: ideaKeys.counts });
    },
  });
}

/** Mutation: mark a piece of advice accepted or ignored. */
export function useAdviceState() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { id: string; state: 'accepted' | 'ignored' }) =>
      (await client.post(`${BASE}/advice/${v.id}/state`, { state: v.state })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ideas', 'ai', 'advice'] }),
  });
}

/** Mutation: draft help for an idea page (problem, assumptions, tests, effort, what exists, or a question). */
export function useShapeIdea() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { ideaId: string; kind: ShapeResult['kind']; question?: string }) =>
      (await client.post<ShapeResult>(`${BASE}/shape`, v)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ideas', 'ai', 'status'] }),
  });
}

/** Mutation: draft the ticket text, acceptance criteria and a split for the Promote dialog. */
export function usePrepareTicket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (ideaId: string) =>
      (await client.post<PreparedTicket>(`${BASE}/prepare-ticket`, { ideaId })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ideas', 'ai', 'status'] }),
  });
}

/** Mutation: ask a question about the ideas in view. */
export function useAskIdeas() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { question: string; projectId?: string; scope: IdeaScope }) =>
      (await client.post<AskResult>(`${BASE}/ask`, v)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ideas', 'ai', 'status'] }),
  });
}

/** Query: the newest weekly digest. */
export function useIdeaDigest(projectId: string | null) {
  return useQuery({
    queryKey: key.digest(projectId),
    queryFn: async () =>
      (await client.get<IdeaDigest | null>(`${BASE}/digest`, { params: { project_id: projectId ?? undefined } })).data,
  });
}

/** Mutation: write the digest now. */
export function useRunDigest(projectId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await client.post<IdeaDigest>(`${BASE}/digest/run`, { projectId })).data,
    onSuccess: (d) => qc.setQueryData(key.digest(projectId), d),
  });
}
