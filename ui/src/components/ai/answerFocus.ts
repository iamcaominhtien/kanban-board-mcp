import { useEffect, type RefObject } from 'react';

const EVENT = 'ai:answer-question';
let pending: string | null = null;

/**
 * "Answer" on a notice: bring the ticket's open question in front of the person. The ticket may be open already (then
 * the notice has nothing to open) or about to open (then its question is not drawn yet), so the request waits a few
 * seconds for the question to appear and scrolls to it, with its answer box focused.
 */
export function requestAnswerFocus(ticketId: string | null | undefined): void {
  if (!ticketId) return;
  pending = ticketId;
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { ticketId } }));
  window.setTimeout(() => {
    if (pending === ticketId) pending = null;
  }, 8000);
}

/** The element holding a ticket's open question answers a pending "Answer" request: scroll to it, focus its box. */
export function useAnswerFocus(ticketId: string | null | undefined, ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!ticketId) return undefined;
    const go = () => {
      const el = ref.current;
      if (pending !== ticketId || !el) return;
      pending = null;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      (el.querySelector('textarea, input') as HTMLElement | null)?.focus({ preventScroll: true });
    };
    go();
    const on = (e: Event) => {
      if ((e as CustomEvent<{ ticketId: string }>).detail?.ticketId === ticketId) go();
    };
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, [ticketId, ref]);
}
