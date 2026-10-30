import { useQuery } from '@tanstack/react-query';
import { client } from './client';
import type {
  AssigneeSuggestion,
  AssistDraft,
  AssistErrorBody,
  AssistState,
  ChatDetail,
  ChatMessage,
  Chat,
  CoverageRow,
  DraftKind,
  HealthPanel,
  InsightChip,
  SimilarTicket,
} from '../types/assist';

export const assistKeys = {
  state: (projectId: string) => ['assist', 'state', projectId] as const,
  chats: (projectId: string, q: string) => ['assist', 'chats', projectId, q] as const,
  chat: (id: string) => ['assist', 'chat', id] as const,
  message: (id: string) => ['assist', 'message', id] as const,
  draft: (id: string) => ['assist', 'draft', id] as const,
  ticketDrafts: (ticketId: string) => ['assist', 'ticket-drafts', ticketId] as const,
  health: (projectId: string) => ['assist', 'health', projectId] as const,
  chips: (projectId: string) => ['assist', 'chips', projectId] as const,
  coverage: (ticketId: string) => ['assist', 'coverage', ticketId] as const,
  docDrafts: (projectId: string, docId: string) => ['assist', 'doc-drafts', projectId, docId] as const,
};

const ACTIVE_MSG = ['queued', 'thinking', 'streaming', 'rate_limited'];

/** Board AI state for a project: Board AI, features, budget, unseen insights (dock, settings, entry points). */
export function useAssistState(projectId: string | null | undefined) {
  return useQuery({
    queryKey: assistKeys.state(projectId ?? ''),
    queryFn: async () => (await client.get<AssistState>(`/projects/${projectId}/ai/assist`)).data,
    enabled: !!projectId,
    refetchInterval: 30000,
  });
}

/** The person's chats (B3). */
export function useChats(projectId: string, q: string, enabled = true) {
  return useQuery({
    queryKey: assistKeys.chats(projectId, q),
    queryFn: async () =>
      (
        await client.get<{ chats: Chat[]; count: number; monthCost: number; keepDays: number }>(
          `/projects/${projectId}/ai/assist/chats`,
          { params: { q: q || undefined } },
        )
      ).data,
    enabled: !!projectId && enabled,
  });
}

/** One chat; polls while an answer is being written. */
export function useChat(id: string | null) {
  return useQuery({
    queryKey: assistKeys.chat(id ?? ''),
    queryFn: async () => (await client.get<ChatDetail>(`/ai/assist/chats/${id}`)).data,
    enabled: !!id,
    refetchInterval: (q) => (q.state.data?.messages.some((m) => ACTIVE_MSG.includes(m.state)) ? 400 : false),
  });
}

/** One draft; polls while it is being written. */
export function useDraft(id: string | null | undefined) {
  return useQuery({
    queryKey: assistKeys.draft(id ?? ''),
    queryFn: async () => (await client.get<AssistDraft>(`/ai/assist/drafts/${id}`)).data,
    enabled: !!id,
    refetchInterval: (q) => (q.state.data?.status === 'pending' ? 500 : false),
  });
}

/** Drafts on a ticket (badges, the latest description / split / cases draft). */
export function useTicketDrafts(ticketId: string | undefined) {
  return useQuery({
    queryKey: assistKeys.ticketDrafts(ticketId ?? ''),
    queryFn: async () => (await client.get<AssistDraft[]>(`/tickets/${ticketId}/ai/assist/drafts`)).data,
    enabled: !!ticketId,
    refetchInterval: (q) => (q.state.data?.some((d) => d.status === 'pending') ? 600 : false),
  });
}

/** The Board health panel. */
export function useHealth(projectId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: assistKeys.health(projectId ?? ''),
    queryFn: async () => (await client.get<HealthPanel>(`/projects/${projectId}/ai/assist/health`)).data,
    enabled: !!projectId && enabled,
    refetchInterval: (q) => (q.state.data?.drafts.some((d) => d.status === 'pending') ? 600 : 60000),
  });
}

/** Insight chips for board cards. */
export function useInsightChips(projectId: string | null | undefined) {
  return useQuery({
    queryKey: assistKeys.chips(projectId ?? ''),
    queryFn: async () => (await client.get<InsightChip[]>(`/projects/${projectId}/ai/assist/chips`)).data,
    enabled: !!projectId,
    refetchInterval: 60000,
  });
}

/** Coverage by acceptance criterion. */
export function useCoverage(ticketId: string | undefined) {
  return useQuery({
    queryKey: assistKeys.coverage(ticketId ?? ''),
    queryFn: async () =>
      (
        await client.get<{ coverage: CoverageRow[]; covered: number; total: number }>(
          `/tickets/${ticketId}/ai/assist/coverage`,
        )
      ).data,
    enabled: !!ticketId,
  });
}

/** Drafts made for a doc (dashed blocks in the editor). */
export function useDocDrafts(projectId: string, docId: string | null | undefined) {
  return useQuery({
    queryKey: assistKeys.docDrafts(projectId, docId ?? ''),
    queryFn: async () =>
      (await client.get<AssistDraft[]>(`/projects/${projectId}/ai/assist/drafts`, { params: { doc_id: docId } })).data,
    enabled: !!projectId && !!docId,
    refetchInterval: (q) => (q.state.data?.some((d) => d.status === 'pending') ? 600 : false),
  });
}

/** The coded error a Board AI request failed with (not configured, over budget, viewer, conflict…). */
export function assistError(err: unknown): AssistErrorBody | null {
  const data = (err as { response?: { data?: AssistErrorBody } })?.response?.data;
  return data && typeof data === 'object' && 'code' in data ? data : null;
}

export const assistApi = {
  updateSettings: async (projectId: string, body: Record<string, unknown>) =>
    (await client.patch<AssistState>(`/projects/${projectId}/ai/assist`, body)).data,
  createChat: async (
    projectId: string,
    body: { scope: string; ticketId?: string | null; docId?: string | null; fresh?: boolean },
  ) => (await client.post<ChatDetail>(`/projects/${projectId}/ai/assist/chats`, body)).data,
  patchChat: async (
    id: string,
    body: { scope?: string; ticketId?: string | null; docId?: string | null; includeDoc?: string },
  ) => (await client.patch<ChatDetail>(`/ai/assist/chats/${id}`, body)).data,
  deleteChat: async (id: string) => {
    await client.delete(`/ai/assist/chats/${id}`);
  },
  send: async (
    chatId: string,
    body: {
      text: string;
      draft?: boolean;
      sendAll?: boolean;
      docIds?: string[];
      filters?: Record<string, unknown>;
      memberForm?: Record<string, unknown>;
    },
  ) => (await client.post<{ user: ChatMessage; ai: ChatMessage }>(`/ai/assist/chats/${chatId}/messages`, body)).data,
  stop: async (messageId: string) => (await client.post<ChatMessage>(`/ai/assist/messages/${messageId}/stop`)).data,
  feedback: async (messageId: string, thumb: 'up' | 'down' | null, reason = '') =>
    (await client.post<ChatMessage>(`/ai/assist/messages/${messageId}/feedback`, { thumb, reason })).data,
  retry: async (messageId: string, sendAll = false) =>
    (await client.post<ChatMessage>(`/ai/assist/messages/${messageId}/retry`, { sendAll })).data,
  startDraft: async (
    projectId: string,
    body: { kind: DraftKind; ticketId?: string; docId?: string; data?: Record<string, unknown> },
  ) => (await client.post<AssistDraft>(`/projects/${projectId}/ai/assist/drafts`, body)).data,
  apply: async (id: string, body: Record<string, unknown>) =>
    (await client.post<AssistDraft>(`/ai/assist/drafts/${id}/apply`, body)).data,
  undo: async (id: string) => (await client.post<AssistDraft>(`/ai/assist/drafts/${id}/undo`)).data,
  discard: async (id: string) => (await client.post<AssistDraft>(`/ai/assist/drafts/${id}/discard`)).data,
  cancel: async (id: string) => (await client.post<AssistDraft>(`/ai/assist/drafts/${id}/cancel`)).data,
  regenerate: async (id: string, body: { feedback?: string; field?: string; allowMore?: boolean } = {}) =>
    (await client.post<AssistDraft>(`/ai/assist/drafts/${id}/regenerate`, body)).data,
  edit: async (id: string, payload: Record<string, unknown>) =>
    (await client.patch<AssistDraft>(`/ai/assist/drafts/${id}`, { payload })).data,
  requestApply: async (id: string) =>
    (await client.post<{ lead: string | null; ticketId: string }>(`/ai/assist/drafts/${id}/request-apply`)).data,
  similar: async (projectId: string, text: string) =>
    (await client.get<SimilarTicket[]>(`/projects/${projectId}/ai/assist/similar`, { params: { text } })).data,
  assignees: async (projectId: string, params: { text?: string; ticketId?: string }) =>
    (
      await client.get<AssigneeSuggestion[]>(`/projects/${projectId}/ai/assist/assignees`, {
        params: { text: params.text, ticket_id: params.ticketId },
      })
    ).data,
  runHealth: async (projectId: string) => (await client.post(`/projects/${projectId}/ai/assist/health/run`)).data,
  healthSeen: async (projectId: string) => {
    await client.post(`/projects/${projectId}/ai/assist/health/seen`);
  },
  snoozeAll: async (projectId: string) => {
    await client.post(`/projects/${projectId}/ai/assist/health/snooze-all`);
  },
  insight: async (id: string, action: 'act' | 'snooze' | 'dismiss' | 'restore', hours = 24) =>
    (await client.post(`/ai/assist/insights/${id}/${action}`, { hours })).data,
};
