import { useEffect, useRef, type RefObject } from 'react';

/**
 * Keeps keyboard focus sensible around a dialog: on open, focus moves into the dialog when nothing inside has it yet;
 * on close, focus goes back to the control that opened it.
 *
 * @param ref - The dialog's root element. It needs `tabIndex={-1}` so it can take the focus itself.
 * @param onEscape - Called when Escape is pressed inside the dialog and nothing inside handled the key.
 * @param fallback - Finds the control to focus on close when the opener is gone (a card that moved to another column).
 */
export function useDialogFocus(
  ref: RefObject<HTMLElement | null>,
  onEscape?: () => void,
  fallback?: () => HTMLElement | null,
): void {
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;
  // read while rendering: an autoFocus inside the dialog takes the focus before any effect runs
  const openerRef = useRef<Element | null>(typeof document === 'undefined' ? null : document.activeElement);
  useEffect(() => {
    const opener = openerRef.current instanceof HTMLElement ? openerRef.current : null;
    const el = ref.current;
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) escapeRef.current?.();
    };
    el?.addEventListener('keydown', onKey);
    return () => {
      el?.removeEventListener('keydown', onKey);
      const back =
        opener && opener !== document.body && opener.isConnected ? opener : (fallbackRef.current?.() ?? null);
      back?.focus({ preventScroll: true });
    };
    // runs once per open: the dialog is mounted only while it is open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
