import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { client } from './client';

/** What a ticket's team is doing: `working` hears a note now, `asking` waits for the person (sending is blocked). */
export type SendTeamState = 'working' | 'asking' | 'idle';

export interface SendTeamRef {
  id: string;
  name: string;
}

export interface SendTicketTeam extends SendTeamRef {
  state: SendTeamState;
  runNumber: number | null;
}

/** How a ticket is tied to the page: `built`, `linked`, `named`, `mentions` or `editor`. */
export interface SendRelation {
  kind: 'built' | 'linked' | 'named' | 'mentions' | 'editor' | string;
  label: string;
}

export interface SendTicket {
  id: string;
  title: string;
  status: string;
  relations: SendRelation[];
  /** Null when the ticket has no team. */
  team: SendTicketTeam | null;
}

export interface SendThreadOrder {
  ticketId: string;
  /** Why this ticket fits this thread: named in its section, above it, or in the thread. */
  badge?: { kind: 'section' | 'above' | 'thread' | string; label: string } | null;
}

export interface SendThreadTargets {
  threadId: string;
  /** The ticket to preselect. */
  default: string | null;
  order: SendThreadOrder[];
}

export interface SendToAiTargets {
  pageId: string;
  maxThreads: number;
  /** Tickets tied to the page, best relation first. */
  tickets: SendTicket[];
  threads: SendThreadTargets[];
  /** Every other ticket of the project (searched in the browser). */
  others: SendTicket[];
  teams: SendTeamRef[];
  /** The team that built the page (else the project's only team). */
  builderTeam: SendTeamRef | null;
  boardAi: { available: boolean };
  pageAssistant: { available: boolean };
}

export type SendDestination = 'team' | 'board_ai' | 'page_assistant';

export interface SendToAiBody {
  threadIds: string[];
  to: SendDestination;
  ticketId?: string;
  /** A ticket with no team: give it this team and send. */
  giveTeamId?: string;
}

export interface SendToAiResult {
  to: SendDestination;
  threads: number;
  ticketId?: string;
  team?: SendTeamRef;
  gaveTeam?: boolean;
  delivered?: boolean;
  runId?: string;
  runNumber?: number;
  /** One line telling the person what happened. */
  note: string;
}

export interface TicketDocComments {
  threads: number;
  pages: { pageId: string; title: string; threads: number }[];
  maxThreads: number;
  /** The team that built the first of those pages (the default for "give it to a team"). */
  builderTeam: { id: string; name: string } | null;
}

export const sendToAiKeys = {
  targets: (pageId: string) => ['docs', 'send-to-ai', pageId] as const,
  ticket: (ticketId: string) => ['docs', 'ticket-comments', ticketId] as const,
};

/** The `code` of a send error (`no_threads`, `too_many`, `no_ticket`, `no_team`, `team_asking`, `not_started`). */
export function sendErrorCode(err: unknown): string | null {
  const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  if (detail && typeof detail === 'object' && 'code' in detail) return String((detail as { code: unknown }).code);
  return null;
}

/** Refresh what a send changes: the page's threads (the "Sent to …" line), the targets and the AI team's queries. */
function refreshAfterSend(qc: QueryClient, pageId: string | null) {
  void qc.invalidateQueries({ queryKey: pageId ? ['docs', 'comments', pageId] : ['docs', 'comments'] });
  void qc.invalidateQueries({ queryKey: ['docs', 'send-to-ai'] });
  void qc.invalidateQueries({ queryKey: ['docs', 'ticket-comments'] });
  void qc.invalidateQueries({ queryKey: ['ai'] });
}

/**
 * Query where a page's comment threads can be sent: the tickets tied to it, the team of each, and the AI helpers.
 * One query per page, shared by the box and the buttons on the threads.
 * @param pageId - Page whose threads are sent; disabled while null.
 * @param enabled - False to skip the request (a viewer, a closed panel).
 */
export function useSendToAiTargets(pageId: string | null, enabled = true) {
  return useQuery({
    queryKey: sendToAiKeys.targets(pageId ?? ''),
    queryFn: async () => (await client.get<SendToAiTargets>(`/docs/pages/${pageId}/send-to-ai`)).data,
    enabled: !!pageId && enabled,
    staleTime: 15_000,
    retry: 1,
  });
}

/**
 * Mutation: send some of the page's open threads to a ticket's team, the Board AI or the page's assistant.
 * @param pageId - Page the threads belong to.
 */
export function useSendToAi(pageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: SendToAiBody) =>
      (await client.post<SendToAiResult>(`/docs/pages/${pageId}/send-to-ai`, body)).data,
    onSuccess: () => refreshAfterSend(qc, pageId),
    // a team that began asking (or a ticket not started) changed what the box shows
    onError: () => void qc.invalidateQueries({ queryKey: sendToAiKeys.targets(pageId) }),
  });
}

/**
 * Query the open comment threads of the pages linked to a ticket.
 * @param ticketId - Ticket to load; disabled while empty.
 */
export function useTicketDocComments(ticketId: string | null | undefined) {
  return useQuery({
    queryKey: sendToAiKeys.ticket(ticketId ?? ''),
    queryFn: async () => (await client.get<TicketDocComments>(`/tickets/${ticketId}/docs/comments`)).data,
    enabled: !!ticketId,
    staleTime: 15_000,
    retry: 1,
  });
}

/**
 * Mutation: send the open comments of a ticket's linked pages to that ticket's own team. With no team the server
 * answers `no_team`; repeat it with `giveTeamId`.
 * @param ticketId - Ticket whose team receives them.
 */
export function useSendTicketComments(ticketId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { giveTeamId?: string }) =>
      (await client.post<SendToAiResult>(`/tickets/${ticketId}/docs/comments/send`, v)).data,
    onSuccess: () => refreshAfterSend(qc, null),
  });
}
