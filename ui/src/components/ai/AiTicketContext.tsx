import { createContext, useContext } from 'react';

/** What the AI parts of the open ticket can ask the ticket window to do (mention pills, hover cards, comments). */
export interface AiTicketActions {
  /** The open ticket (null outside a ticket: Docs, the board). */
  ticketId: string | null;
  /** Put a mention of this AI member in the comment box and focus it. */
  ask: (memberId: string) => void;
  /** Open the assign popover of the open ticket for this AI member. */
  assign: (memberId: string) => void;
  /** Open one run in the ticket's AI tab. */
  openRun: (runId: string) => void;
}

const NONE: AiTicketActions = {
  ticketId: null,
  ask: () => undefined,
  assign: () => undefined,
  openRun: () => undefined,
};

/** Context of the open ticket for AI mentions and replies. */
export const AiTicketContext = createContext<AiTicketActions>(NONE);

/** Actions of the open ticket (no-ops outside a ticket). */
export function useAiTicket(): AiTicketActions {
  return useContext(AiTicketContext);
}

/** Window events between the hover card / pills and the comment box / assignee picker of the same ticket. */
export const ASK_AI_EVENT = 'kanban:ask-ai';
export const ASSIGN_AI_EVENT = 'kanban:assign-ai';

/** Fire one of the events above for a ticket and AI member. */
export function fireAiEvent(name: string, ticketId: string, memberId: string): void {
  window.dispatchEvent(new CustomEvent(name, { detail: { ticketId, memberId } }));
}
