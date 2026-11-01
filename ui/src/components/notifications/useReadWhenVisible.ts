import { useEffect, useRef, type RefObject } from 'react';

const DWELL_MS = 1000;

/**
 * Reads rows that have been on screen for a moment (design C2): every `[data-unread]` row inside the container that
 * stays visible for a second is passed to `onRead`, once. `signature` changes when the rows do.
 */
export function useReadWhenVisible(
  container: RefObject<HTMLElement | null>,
  enabled: boolean,
  signature: string,
  onRead: (ids: string[]) => void,
) {
  const sent = useRef(new Set<string>());
  const cb = useRef(onRead);
  cb.current = onRead;

  useEffect(() => {
    const root = container.current;
    if (!enabled || !root || typeof IntersectionObserver === 'undefined') return;
    const timers = new Map<Element, ReturnType<typeof setTimeout>>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = (e.target as HTMLElement).dataset.rowId;
          if (!id) continue;
          if (e.isIntersecting && !sent.current.has(id) && !timers.has(e.target)) {
            timers.set(
              e.target,
              setTimeout(() => {
                timers.delete(e.target);
                sent.current.add(id);
                cb.current([id]);
              }, DWELL_MS),
            );
          } else if (!e.isIntersecting && timers.has(e.target)) {
            clearTimeout(timers.get(e.target));
            timers.delete(e.target);
          }
        }
      },
      { root, threshold: 0.6 },
    );
    root.querySelectorAll('[data-unread]').forEach((el) => io.observe(el));
    return () => {
      io.disconnect();
      timers.forEach((t) => clearTimeout(t));
    };
  }, [container, enabled, signature]);
}
