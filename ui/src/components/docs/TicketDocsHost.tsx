import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { slugify } from '../../utils/docsMarkdown';
import { DocPeekPanel, type PeekTarget } from './DocPeekPanel';
import { DocsRefsProvider, type DocsRefsValue } from './DocsRefsContext';

interface Props {
  projectId: string;
  ticketId: string;
  onOpenDocsPage?: (pageId: string, anchor?: string | null) => void;
  onOpenTicket?: (ticketId: string) => void;
  children: ReactNode;
}

/** Gives every pill inside a ticket the side panel, "Open in Docs" and ticket navigation. */
export function TicketDocsHost({ projectId, ticketId, onOpenDocsPage, onOpenTicket, children }: Props) {
  const [target, setTarget] = useState<PeekTarget | null>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  const peek = useCallback<DocsRefsValue['peek']>((pageId, anchor, hint) => {
    if (!returnTo.current)
      returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setTarget({ pageId, anchor: anchor ?? null, hint });
  }, []);
  const close = useCallback(() => {
    setTarget(null);
    const el = returnTo.current;
    returnTo.current = null;
    requestAnimationFrame(() => el?.focus?.());
  }, []);

  /** Leaves the ticket for Docs, keeping the section in the URL (#auth). */
  const toDocs = useCallback(
    (pageId: string, anchor?: string | null) => {
      const slug = anchor ? slugify(anchor) : '';
      window.history.replaceState(
        null,
        '',
        `${window.location.pathname}${window.location.search}${slug ? `#${slug}` : ''}`,
      );
      onOpenDocsPage?.(pageId, anchor);
    },
    [onOpenDocsPage],
  );

  const value = useMemo<DocsRefsValue>(
    () => ({
      projectId,
      ticketId,
      peek,
      openInDocs: toDocs,
      openTicket: (id) => onOpenTicket?.(id),
    }),
    [projectId, ticketId, peek, toDocs, onOpenTicket],
  );

  return (
    <DocsRefsProvider value={value}>
      {children}
      {target && (
        <DocPeekPanel
          target={target}
          projectId={projectId}
          ticketId={ticketId}
          onSwitch={setTarget}
          onClose={close}
          onOpenInDocs={(id, a) => {
            close();
            toDocs(id, a);
          }}
          onOpenTicket={(id) => {
            close();
            onOpenTicket?.(id);
          }}
        />
      )}
    </DocsRefsProvider>
  );
}
