import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { slugify } from '../../utils/docsMarkdown';
import { DocPeekPanel, type PeekTarget } from './DocPeekPanel';
import { DocsRefsProvider, type DocsRefsValue } from './DocsRefsContext';
import './docs.css';

interface Props {
  projectId: string;
  ticketId: string;
  onOpenDocsPage?: (pageId: string, anchor?: string | null) => void;
  onOpenTicket?: (ticketId: string) => void;
  children: ReactNode;
}

/**
 * Gives every pill inside a ticket the side panel, "Open in Docs" and ticket navigation.
 * @param props.projectId - Project the ticket belongs to.
 * @param props.ticketId - Ticket the pills are inside.
 * @param props.onOpenDocsPage - Called with page id and anchor to open a page in the Docs view.
 * @param props.onOpenTicket - Called with a ticket id to open another ticket.
 */
export function TicketDocsHost({ projectId, ticketId, onOpenDocsPage, onOpenTicket, children }: Props) {
  const [target, setTarget] = useState<PeekTarget | null>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState(0);
  const open = !!target;

  // While the panel is open the ticket shifts left (up to 240px, keeping 16px to the window edge) so the 480px panel
  // does not cover its right column; the scrim dims it (TicketDocRefs C1, DR-3).
  useLayoutEffect(() => {
    if (!open) {
      setShift(0);
      return;
    }
    const dialog = hostRef.current?.querySelector<HTMLElement>(':scope > div > [role="dialog"]');
    const left = dialog?.getBoundingClientRect().left ?? 0;
    setShift(Math.max(0, Math.min(240, Math.round(left - 16))));
  }, [open]);

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
      <div
        ref={hostRef}
        className="dk-peek-host"
        data-peek-open={open ? 'true' : undefined}
        style={{ display: 'contents', ['--dk-peek-shift' as string]: `${shift}px` }}
      >
        {children}
      </div>
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
