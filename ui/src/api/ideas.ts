import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client';
import { extractError } from './extractError';
import type {
  ArchiveReason,
  AssumptionImpact,
  AssumptionState,
  EvidenceKind,
  Idea,
  IdeaActivity,
  IdeaComment,
  IdeaCounts,
  IdeaEvidenceItem,
  IdeaForTicket,
  IdeaLogEntry,
  IdeaRow,
  IdeaScope,
  IdeaSource,
  IdeaSourceRef,
  IdeaStage,
  LogKind,
  PromotePreview,
  SimilarItem,
} from '../types/idea';
import type { Ticket } from '../types';

const BASE = '/api/idea-tickets';

/** A rule of the Idea Space the server refused, with the code a screen can react to. */
export interface IdeaRuleError {
  status: number;
  code: string;
  message: string;
  extra: Record<string, unknown>;
}

/**
 * Read the {code, message} the Idea Space answers with when a rule stops a request.
 * @param err - What a request threw.
 * @returns The rule error; `code` is "error" when the failure was not a rule.
 */
export function ideaRuleError(err: unknown): IdeaRuleError {
  const e = err as { response?: { status?: number; data?: { detail?: unknown } } };
  const detail = e?.response?.data?.detail;
  if (detail && typeof detail === 'object') {
    const { code, message, ...extra } = detail as Record<string, unknown>;
    return {
      status: e.response?.status ?? 0,
      code: typeof code === 'string' ? code : 'error',
      message: typeof message === 'string' ? message : extractError(err),
      extra,
    };
  }
  return { status: e?.response?.status ?? 0, code: 'error', message: extractError(err), extra: {} };
}

// ─── queries ──────────────────────────────────────────────────────────────

export interface IdeaListParams {
  scope: IdeaScope;
  projectId?: string;
  stages?: IdeaStage[];
  active?: boolean;
  q?: string;
  source?: IdeaSource;
  tag?: string;
  sort?: 'readiness' | 'updated' | 'created' | 'votes' | 'title';
}

/** Keys of the Idea Space queries; every mutation refreshes the whole `ideas` family. */
export const ideaKeys = {
  all: ['ideas'] as const,
  list: (p: IdeaListParams) => ['ideas', 'list', p] as const,
  counts: ['ideas', 'counts'] as const,
  one: (id: string) => ['ideas', 'one', id] as const,
  comments: (id: string) => ['ideas', 'comments', id] as const,
  log: (id: string) => ['ideas', 'log', id] as const,
  evidence: (id: string) => ['ideas', 'evidence', id] as const,
  activity: (id: string, filter?: string) => ['ideas', 'activity', id, filter ?? 'all'] as const,
  preview: (id: string, projectId?: string | null) => ['ideas', 'preview', id, projectId ?? ''] as const,
  byTicket: (ticketId: string) => ['ideas', 'by-ticket', ticketId] as const,
};

/** Ideas for the list, stages and matrix views. */
export function useIdeaList(params: IdeaListParams, enabled = true) {
  return useQuery({
    queryKey: ideaKeys.list(params),
    enabled: enabled && (params.scope !== 'project' || !!params.projectId),
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const res = await client.get<IdeaRow[]>(`${BASE}/space`, {
        params: {
          scope: params.scope,
          project_id: params.projectId,
          stage: params.stages,
          active: params.active || undefined,
          q: params.q || undefined,
          source: params.source,
          tag: params.tag,
          sort: params.sort,
        },
        paramsSerializer: { indexes: null },
      });
      return res.data;
    },
  });
}

/** Counts for the project switcher, the stage filters and the sidebar badge. */
export function useIdeaCounts() {
  return useQuery({
    queryKey: ideaKeys.counts,
    queryFn: async () => (await client.get<IdeaCounts>(`${BASE}/counts`)).data,
  });
}

/** One idea in full. */
export function useIdea(id: string | null) {
  return useQuery({
    queryKey: ideaKeys.one(id ?? ''),
    enabled: !!id,
    queryFn: async () => (await client.get<Idea>(`${BASE}/${id}`)).data,
  });
}

/** Query: the comments of an idea. */
export function useIdeaComments(id: string) {
  return useQuery({
    queryKey: ideaKeys.comments(id),
    queryFn: async () => (await client.get<IdeaComment[]>(`${BASE}/${id}/comments`)).data,
  });
}

/** Query: the research log of an idea. */
export function useIdeaLog(id: string) {
  return useQuery({
    queryKey: ideaKeys.log(id),
    queryFn: async () => (await client.get<IdeaLogEntry[]>(`${BASE}/${id}/log`)).data,
  });
}

/** Query: the evidence of an idea, each piece once. */
export function useIdeaEvidence(id: string) {
  return useQuery({
    queryKey: ideaKeys.evidence(id),
    queryFn: async () => (await client.get<IdeaEvidenceItem[]>(`${BASE}/${id}/evidence`)).data,
  });
}

/** Query: who changed what on an idea, optionally filtered by kind of change. */
export function useIdeaActivity(id: string, filter?: string) {
  return useQuery({
    queryKey: ideaKeys.activity(id, filter),
    queryFn: async () => (await client.get<IdeaActivity>(`${BASE}/${id}/activity`, { params: { filter } })).data,
  });
}

/** What Promote would create; nothing is written. */
export function usePromotePreview(id: string, projectId?: string | null, enabled = true) {
  return useQuery({
    queryKey: ideaKeys.preview(id, projectId),
    enabled,
    queryFn: async () =>
      (
        await client.get<PromotePreview>(`${BASE}/${id}/promote/preview`, {
          params: { project_id: projectId ?? undefined },
        })
      ).data,
  });
}

/** The idea a ticket started as and the assumption it tests. */
export function useIdeaForTicket(ticketId: string) {
  return useQuery({
    queryKey: ideaKeys.byTicket(ticketId),
    enabled: !!ticketId,
    queryFn: async () => (await client.get<IdeaForTicket>(`${BASE}/by-ticket/${ticketId}`)).data,
  });
}

/**
 * Ideas, tickets and Docs that look like a text (a local search, no model).
 * @param text - Title and text typed so far; nothing is searched below 4 characters.
 * @param opts.exclude - An idea to leave out.
 * @param opts.projectId - Project whose tickets and Docs are searched.
 */
export function useSimilar(text: string, opts: { exclude?: string; projectId?: string | null; kinds?: string[] } = {}) {
  const q = text.trim();
  return useQuery({
    queryKey: ['ideas', 'similar', q, opts.exclude ?? '', opts.projectId ?? '', opts.kinds ?? []],
    enabled: q.length >= 4,
    placeholderData: keepPreviousData,
    queryFn: async () =>
      (
        await client.get<SimilarItem[]>(`${BASE}/similar`, {
          params: { text: q, exclude: opts.exclude, project_id: opts.projectId ?? undefined, kinds: opts.kinds },
          paramsSerializer: { indexes: null },
        })
      ).data,
  });
}

/** Tags used by the ideas and tickets that look like the text. */
export function useTagSuggestions(text: string, exclude?: string) {
  const q = text.trim();
  return useQuery({
    queryKey: ['ideas', 'tags', q, exclude ?? ''],
    enabled: q.length >= 4,
    queryFn: async () => (await client.get<string[]>(`${BASE}/tag-suggestions`, { params: { text: q, exclude } })).data,
  });
}

// ─── mutations ────────────────────────────────────────────────────────────

/** A mutation that refreshes every Idea Space query (and the tickets, which promote and tests change). */
function useIdeaMutation<V, R>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ideaKeys.all });
      qc.invalidateQueries({ queryKey: ['tickets'] });
      qc.invalidateQueries({ queryKey: ['ticket'] });
    },
  });
}

export interface NewIdea {
  title: string;
  description?: string;
  projectId?: string | null;
  tags?: string[];
  source?: IdeaSource;
  sourceRef?: IdeaSourceRef;
}

/** Mutation: add an idea to the Inbox. */
export function useCreateIdea() {
  return useIdeaMutation(async (data: NewIdea) => (await client.post<Idea>(BASE, data)).data);
}

export interface StageMove {
  id: string;
  to: IdeaStage;
  parkUntil?: string;
  parkNote?: string;
  archiveReason?: ArchiveReason;
  archiveNote?: string;
  force?: boolean;
  via?: string;
  projectId?: string;
  tags?: string[];
}

/** Move an idea to another stage (Keep, Park, Archive, Restore, drag). */
export function useMoveIdea() {
  return useIdeaMutation(
    async ({ id, ...body }: StageMove) => (await client.post<Idea>(`${BASE}/${id}/stage`, body)).data,
  );
}

/** Mutation: take back the last stage move of an idea. */
export function useUndoIdeaMove() {
  return useIdeaMutation(async (id: string) => (await client.post<Idea>(`${BASE}/${id}/undo`)).data);
}

/** Mutation: park several ideas until the same date. */
export function useParkMany() {
  return useIdeaMutation(
    async (v: { ids: string[]; parkUntil: string; parkNote?: string }) =>
      (await client.post<Idea[]>(`${BASE}/park-many`, v)).data,
  );
}

/** Mutation: merge an idea into another; its text and votes go there. */
export function useMergeIdea() {
  return useIdeaMutation(
    async (v: { id: string; intoId: string }) =>
      (await client.post<Idea>(`${BASE}/${v.id}/merge`, { intoId: v.intoId })).data,
  );
}

/** Mutation: undo the last merge into an idea (within 10 minutes). */
export function useUndoMerge() {
  return useIdeaMutation(async (targetId: string) => (await client.post<Idea>(`${BASE}/${targetId}/undo-merge`)).data);
}

/** Mutation: add or remove your "I want this" on an idea. */
export function useVote() {
  return useIdeaMutation(
    async (v: { id: string; on?: boolean; voter?: string }) =>
      (await client.post<Idea>(`${BASE}/${v.id}/vote`, { on: v.on ?? true, voter: v.voter })).data,
  );
}

export interface PagePatch {
  body?: string;
  details?: string;
  title?: string;
  tags?: string[];
  owner?: string | null;
  effortGuess?: string | null;
  workspaceRetention?: 'open_then_30' | '30_days' | 'forever';
  ai?: boolean;
}

/** Mutation: edit the page text, title, tags, owner, effort guess or workspace retention of an idea. */
export function useEditIdeaPage() {
  return useIdeaMutation(
    async ({ id, ...body }: PagePatch & { id: string }) => (await client.patch<Idea>(`${BASE}/${id}/page`, body)).data,
  );
}

/** Mutation: give an idea a project, move it, or take it out of its project. */
export function useSetIdeaProject() {
  return useIdeaMutation(
    async (v: { id: string; projectId: string | null }) =>
      (await client.put<Idea>(`${BASE}/${v.id}/project`, { projectId: v.projectId })).data,
  );
}

/** Mutation: answer "Did it work as expected?" on a shipped idea. */
export function useRecordOutcome() {
  return useIdeaMutation(
    async (v: { id: string; outcome: 'worked' | 'partly' | 'no'; note?: string }) =>
      (await client.post<Idea>(`${BASE}/${v.id}/outcome`, { outcome: v.outcome, note: v.note })).data,
  );
}

/** Mutation: delete an idea for good. */
export function useDeleteIdea() {
  return useIdeaMutation(async (id: string) => client.delete(`${BASE}/${id}`));
}

// assumptions

/** Mutation: add an assumption to an idea. */
export function useAddAssumption() {
  return useIdeaMutation(
    async (v: { id: string; text: string; impact?: AssumptionImpact; ai?: boolean }) =>
      (
        await client.post<Idea>(`${BASE}/${v.id}/assumption-records`, {
          text: v.text,
          impact: v.impact ?? 'medium',
          ai: v.ai,
        })
      ).data,
  );
}

/** Mutation: change an assumption's text, impact, status or test ticket. */
export function useEditAssumption() {
  return useIdeaMutation(
    async ({
      id,
      assumptionId,
      ...body
    }: {
      id: string;
      assumptionId: string;
      text?: string;
      impact?: AssumptionImpact;
      status?: AssumptionState;
      testTicketId?: string | null;
    }) => (await client.patch<Idea>(`${BASE}/${id}/assumption-records/${assumptionId}`, body)).data,
  );
}

/** Mutation: delete an assumption and its evidence. */
export function useDeleteAssumption() {
  return useIdeaMutation(
    async (v: { id: string; assumptionId: string }) =>
      (await client.delete<Idea>(`${BASE}/${v.id}/assumptions/${v.assumptionId}`)).data,
  );
}

/** Mutation: create a ticket that tests an assumption, linked both ways. */
export function useCreateTestTicket() {
  return useIdeaMutation(
    async (v: { id: string; assumptionId: string; title?: string; assignee?: string }) =>
      (
        await client.post<{ idea: Idea; ticket: Ticket }>(
          `${BASE}/${v.id}/assumption-records/${v.assumptionId}/test-ticket`,
          {
            title: v.title,
            assignee: v.assignee,
          },
        )
      ).data,
  );
}

/** Mutation: answer what a test showed: validated, disproved or not sure. */
export function useResolveAssumption() {
  return useIdeaMutation(
    async (v: { id: string; assumptionId: string; outcome: 'validated' | 'disproved' | 'unsure' }) =>
      (await client.post<Idea>(`${BASE}/${v.id}/assumption-records/${v.assumptionId}/resolve`, { outcome: v.outcome }))
        .data,
  );
}

// evidence, comments, log

/** Mutation: attach a piece of evidence to one or more assumptions. */
export function useAddEvidence() {
  return useIdeaMutation(
    async (v: { id: string; assumptionIds: string[]; kind: EvidenceKind; ref: string; title?: string }) =>
      (
        await client.post<Idea>(`${BASE}/${v.id}/evidence`, {
          assumptionIds: v.assumptionIds,
          kind: v.kind,
          ref: v.ref,
          title: v.title ?? '',
        })
      ).data,
  );
}

/** Mutation: remove a piece of evidence. */
export function useDeleteEvidence() {
  return useIdeaMutation(
    async (v: { id: string; evidenceId: string }) =>
      (await client.delete<Idea>(`${BASE}/${v.id}/evidence/${v.evidenceId}`)).data,
  );
}

/** Mutation: comment on an idea. */
export function useAddComment() {
  return useIdeaMutation(
    async (v: { id: string; body: string }) =>
      (await client.post<IdeaComment>(`${BASE}/${v.id}/comments`, { body: v.body })).data,
  );
}

/** Mutation: edit a comment of an idea. */
export function useEditComment() {
  return useIdeaMutation(
    async (v: { id: string; commentId: string; body: string }) =>
      (await client.patch<IdeaComment>(`${BASE}/${v.id}/comments/${v.commentId}`, { body: v.body })).data,
  );
}

/** Mutation: delete a comment of an idea. */
export function useDeleteComment() {
  return useIdeaMutation(async (v: { id: string; commentId: string }) =>
    client.delete(`${BASE}/${v.id}/comments/${v.commentId}`),
  );
}

/** Mutation: add an entry to the research log. */
export function useAddLogEntry() {
  return useIdeaMutation(
    async (v: {
      id: string;
      kind: LogKind;
      body: string;
      assumptionId?: string | null;
      attachments?: { name: string; url: string }[];
      ticketId?: string | null;
      ai?: boolean;
    }) => {
      const { id, ...body } = v;
      return (await client.post<IdeaLogEntry>(`${BASE}/${id}/log`, body)).data;
    },
  );
}

/** Mutation: edit, re-kind or pin a log entry. */
export function useEditLogEntry() {
  return useIdeaMutation(
    async ({
      id,
      entryId,
      ...body
    }: {
      id: string;
      entryId: string;
      body?: string;
      kind?: LogKind;
      pinned?: boolean;
    }) => (await client.patch<IdeaLogEntry>(`${BASE}/${id}/log/${entryId}`, body)).data,
  );
}

/** Mutation: delete a log entry. */
export function useDeleteLogEntry() {
  return useIdeaMutation(async (v: { id: string; entryId: string }) =>
    client.delete(`${BASE}/${v.id}/log/${v.entryId}`),
  );
}

/** Mutation: turn a log entry into evidence for an assumption. */
export function useLogAsEvidence() {
  return useIdeaMutation(
    async (v: { id: string; entryId: string; assumptionId: string }) =>
      (await client.post<Idea>(`${BASE}/${v.id}/log/${v.entryId}/evidence`, { assumptionId: v.assumptionId })).data,
  );
}

// promote

export interface PromoteRequest {
  id: string;
  projectId?: string | null;
  title?: string;
  type?: 'bug' | 'feature' | 'task' | 'chore';
  priority?: 'low' | 'medium' | 'high' | 'critical';
  status?: 'backlog' | 'todo' | 'in-progress' | 'review' | 'testing';
  description?: string;
  subTickets?: string[];
  acknowledgeNotReady?: boolean;
  workspace?: 'move' | 'copy' | 'leave';
}

/** Mutation: create the ticket (and sub-tickets) from an idea. */
export function usePromoteIdea() {
  return useIdeaMutation(
    async ({ id, ...body }: PromoteRequest) =>
      (await client.post<{ idea: Idea; ticket: Ticket; subTickets: Ticket[] }>(`${BASE}/${id}/promote`, body)).data,
  );
}
