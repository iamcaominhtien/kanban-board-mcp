import { useEffect, useRef } from 'react';

/**
 * Listen for keys while the viewer is open. Runs before the rest of the app sees the key, and a handled key
 * (the handler returns true) is not passed on, so board shortcuts and the ticket window behind do not react.
 * @param handler - Return true when the key was used.
 */
export function useViewerKeys(handler: (e: KeyboardEvent) => boolean | void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (ref.current(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', fn, true);
    return () => window.removeEventListener('keydown', fn, true);
  }, []);
}

/** Whether the key press happened while typing in a field. */
export function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}
