import { useEffect, useRef, useState } from 'react';

/**
 * Follow an element that may only appear later (a card that shows a skeleton first): the box is looked at again after
 * every render, and measured, and watched while it is there.
 */
function useBox<T extends HTMLElement>(onSize: (w: number, h: number) => void) {
  const ref = useRef<T>(null);
  const [node, setNode] = useState<T | null>(null);
  // runs after every render on purpose (the box can appear on any render); it only sets state when the box changed
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (ref.current !== node) setNode(ref.current);
  });
  useEffect(() => {
    if (!node) return;
    const measure = () => {
      const r = node.getBoundingClientRect();
      onSize(Math.round(r.width), Math.round(r.height));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    return () => ro.disconnect();
    // `onSize` only sets state
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node]);
  return ref;
}

/**
 * The width of an element, kept up to date (for drawing a picture to fit its box).
 * @param fallback - Width to use until the first measure.
 */
export function useWidth<T extends HTMLElement>(fallback = 560) {
  const [width, setWidth] = useState(fallback);
  const ref = useBox<T>((w) => setWidth(Math.max(120, w || fallback)));
  return { ref, width };
}

/** The width and height of an element, kept up to date (0 until it has been measured). */
export function useSize<T extends HTMLElement>() {
  const [size, setSize] = useState({ w: 0, h: 0 });
  const ref = useBox<T>((w, h) => setSize((s) => (s.w === w && s.h === h ? s : { w, h })));
  return { ref, size };
}
