import { useQuery } from '@tanstack/react-query';
import { client } from './client';
import type { AssistDraft, Availability, CostEstimate } from '../types/assist';

/** The places an editor can be in; the server decides what each one offers (design/screens/ai-where-you-work.md, D5). */
export type EditorSurface =
  'ticket_description' | 'acceptance_criteria' | 'comment' | 'doc' | 'idea' | 'debug_note' | 'test_case';

export type EditorAction =
  | 'improve'
  | 'shorten'
  | 'fix_spelling'
  | 'explain'
  | 'ask'
  | 'continue'
  | 'summarise'
  | 'criteria'
  | 'diagram'
  | 'translate'
  | 'split'
  | 'more_criteria';

/** One entry of the /ai menu or the selection bar. */
export interface EditorActionInfo {
  action: EditorAction;
  label: string;
  hint: string;
  /** What the result is: replaces the selection, is inserted, is an answer, a list of criteria, a diagram. */
  result: 'replace' | 'insert' | 'answer' | 'list' | 'diagram';
}

/** What an editor may offer here, and whether this person may use it now. */
export interface EditorAiState {
  surface: EditorSurface;
  label: string;
  availability: Availability;
  menu: EditorActionInfo[];
  bar: EditorActionInfo[];
  estimate: CostEstimate | null;
  memberId: string | null;
}

/** One request from an editor. */
export interface EditorRequest {
  surface: EditorSurface;
  action: EditorAction;
  selection?: string;
  before?: string;
  after?: string;
  prompt?: string;
  language?: string;
  ticketId?: string | null;
  docId?: string | null;
  ideaId?: string | null;
  /** The chips: what the AI may read besides the instruction. */
  include?: { ticket?: boolean; page?: boolean; selection?: boolean };
}

/** One line of "What will be sent". */
export interface SentPiece {
  kind: string;
  label: string;
  chars: number;
  tokens: number;
  preview: string;
}

export interface EditorPreview {
  pieces: SentPiece[];
  tokens: number;
  estimate: CostEstimate | null;
  privateSkipped: string[];
  neverSent: string[];
}

/** The result of an editor draft (`draft.payload.result`). */
export interface EditorResult {
  kind: 'replace' | 'insert' | 'answer' | 'list' | 'diagram';
  text?: string;
  items?: string[];
  diagram?: {
    title: string;
    xml: string;
    nodes: { id: string; label: string; shape: string }[];
    edges: { from: string; to: string; label: string }[];
  };
  cutShort: boolean;
}

export const editorKeys = {
  state: (projectId: string, surface: string, ticketId?: string | null, ideaId?: string | null) =>
    ['assist', 'editor-state', projectId, surface, ticketId ?? '', ideaId ?? ''] as const,
};

/**
 * Whether AI is available in this editor, plus its /ai menu and selection bar. Nothing is sent.
 * @param projectId - The project the request is booked on (an idea with no project uses a project of the person).
 * @param surface - Where the editor is.
 * @param ticketId - The ticket the text belongs to.
 * @param enabled - False skips the request.
 * @param ideaId - The idea the text belongs to: the Idea Space's own switch and cap then apply.
 */
export function useEditorAiState(
  projectId: string | undefined,
  surface: EditorSurface,
  ticketId?: string | null,
  enabled = true,
  ideaId?: string | null,
) {
  return useQuery({
    queryKey: editorKeys.state(projectId ?? '', surface, ticketId, ideaId),
    queryFn: async () =>
      (
        await client.get<EditorAiState>(`/projects/${projectId}/ai/editor/state`, {
          params: { surface, ticket_id: ticketId ?? undefined, idea_id: ideaId ?? undefined },
        })
      ).data,
    enabled: !!projectId && enabled,
    staleTime: 15000,
    refetchInterval: 30000,
  });
}

export const editorAiApi = {
  /** "What will be sent": the pieces of this request. Sends nothing. */
  preview: async (projectId: string, body: EditorRequest) =>
    (await client.post<EditorPreview>(`/projects/${projectId}/ai/editor/preview`, body)).data,
  /** Ask for a draft; poll it with `GET /ai/assist/drafts/{id}`. The text is not touched. */
  draft: async (projectId: string, body: EditorRequest) =>
    (await client.post<AssistDraft>(`/projects/${projectId}/ai/editor/drafts`, body)).data,
  getDraft: async (id: string) => (await client.get<AssistDraft>(`/ai/assist/drafts/${id}`)).data,
  /** Accept: records "edited with AI by <person>" and adds a list of criteria to the ticket. */
  accept: async (id: string, items?: string[]) =>
    (await client.post<{ draft: AssistDraft; created?: string[] }>(`/ai/editor/drafts/${id}/accept`, { items })).data,
  discard: async (id: string) => (await client.post<AssistDraft>(`/ai/assist/drafts/${id}/discard`)).data,
  cancel: async (id: string) => (await client.post<AssistDraft>(`/ai/assist/drafts/${id}/cancel`)).data,
  /** Try again: the same request, written again. */
  retry: async (id: string) => (await client.post<AssistDraft>(`/ai/assist/drafts/${id}/regenerate`, {})).data,
  /** Continue a draft that was cut short at the length limit. */
  goOn: async (id: string) => (await client.post<AssistDraft>(`/ai/editor/drafts/${id}/continue`)).data,
};
