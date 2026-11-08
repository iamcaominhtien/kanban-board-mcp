import { useEffect, useRef, type RefObject } from 'react';

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

/** The ticket page listens: an open ticket on another tab ("AI activity", Test cases...) goes back to its main one. */
export function useAnswerRequest(ticketId: string | null | undefined, onRequest: () => void): void {
  const cb = useRef(onRequest);
  cb.current = onRequest;
  useEffect(() => {
    if (!ticketId) return undefined;
    const on = (e: Event) => {
      if ((e as CustomEvent<{ ticketId: string }>).detail?.ticketId === ticketId) cb.current();
    };
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, [ticketId]);
}

/**
 * The element holding a ticket's open question answers a pending "Answer" request: scroll to it, focus its box. An
 * element that is not shown yet (its tab is hidden until the ticket page switches back) keeps the request waiting.
 */
export function useAnswerFocus(ticketId: string | null | undefined, ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!ticketId) return undefined;
    let timer: number | undefined;
    const go = (): boolean => {
      const el = ref.current;
      if (pending !== ticketId || !el || el.getClientRects().length === 0) return false;
      pending = null;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      (el.querySelector('textarea, input') as HTMLElement | null)?.focus({ preventScroll: true });
      return true;
    };
    // a hidden tab shows on the next renders: ask again for a couple of seconds
    const goSoon = (tries = 0) => {
      if (pending !== ticketId || go() || tries >= 20) return;
      timer = window.setTimeout(() => goSoon(tries + 1), 100);
    };
    goSoon();
    const on = (e: Event) => {
      if ((e as CustomEvent<{ ticketId: string }>).detail?.ticketId !== ticketId) return;
      window.clearTimeout(timer);
      goSoon();
    };
    window.addEventListener(EVENT, on);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener(EVENT, on);
    };
  }, [ticketId, ref]);
}
