import { createContext, useContext } from 'react';

/** What the chip already knows about its target (a page in the Recycle Bin has no readable body). */
export interface PeekHint {
  deleted?: boolean;
  title?: string;
}

/** What a ticket screen offers to doc and ticket references rendered inside it. */
export interface DocsRefsValue {
  projectId: string;
  /** The ticket the text belongs to (feeds the side panel's "Referenced from this ticket" strip). */
  ticketId?: string;
  /** Open the 480px read-only side panel over the ticket. */
  peek: (pageId: string, anchor?: string | null, hint?: PeekHint) => void;
  /** Leave the ticket and open the page in Docs. */
  openInDocs: (pageId: string, anchor?: string | null) => void;
  openTicket: (ticketId: string) => void;
}

const Ctx = createContext<DocsRefsValue | null>(null);

export const DocsRefsProvider = Ctx.Provider;

/** Return the surrounding ticket/Docs reference context, or null. */
export function useDocsRefs(): DocsRefsValue | null {
  return useContext(Ctx);
}

/** What the Docs page offers to the chips in its text: the same side panel as in a ticket. */
const PeekCtx = createContext<DocsRefsValue['peek'] | null>(null);

export const DocsPeekProvider = PeekCtx.Provider;

/** Return the Docs page's "Open in side panel" action, or null outside the Docs page. */
export function useDocsPeek(): DocsRefsValue['peek'] | null {
  return useContext(PeekCtx);
}
