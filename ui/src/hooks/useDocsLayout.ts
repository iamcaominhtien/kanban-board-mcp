import { useEffect, useState } from 'react';

/**
 * How the Docs space lays itself out (design board "Rich Docs — app frame"): `desktop` shows the tree, the page and
 * "On this page" side by side; `tablet` folds the tree to a 56 px rail that opens a drawer and the outline to a
 * button; `phone` has drawers and bottom sheets one tap away and a floating Edit button.
 */
export type DocsLayout = 'desktop' | 'tablet' | 'phone';

/** Below this width of the Docs area (px) the phone layout is used. */
export const DOCS_PHONE_BELOW = 600;
/** Below this width of the Docs area (px) the tablet layout is used. */
export const DOCS_TABLET_BELOW = 960;

/**
 * The layout for a width of the Docs area.
 * @param width - Width of the Docs area in CSS pixels (not the window: Docs can sit beside the app sidebar or in a
 *   window of its own).
 */
export function docsLayoutFor(width: number): DocsLayout {
  if (width < DOCS_PHONE_BELOW) return 'phone';
  if (width < DOCS_TABLET_BELOW) return 'tablet';
  return 'desktop';
}

/** The layout for the window width: a first guess until the Docs area is measured. */
function guess(): DocsLayout {
  if (typeof window === 'undefined') return 'desktop';
  return docsLayoutFor(window.innerWidth);
}

/**
 * The Docs layout for the width of `el`, kept up to date with a ResizeObserver. Without an element (or where
 * ResizeObserver is missing) the window width is used.
 * @param el - The element that holds the Docs area, or `null` while it is not mounted.
 */
export function useDocsLayout(el: HTMLElement | null): DocsLayout {
  const [layout, setLayout] = useState<DocsLayout>(guess);
  useEffect(() => {
    if (el && typeof ResizeObserver !== 'undefined') {
      const measure = (w: number) => setLayout(docsLayoutFor(w));
      measure(el.getBoundingClientRect().width || window.innerWidth);
      const obs = new ResizeObserver((entries) => {
        const w = entries[0]?.contentRect.width;
        if (w) measure(w);
      });
      obs.observe(el);
      return () => obs.disconnect();
    }
    const onResize = () => setLayout(guess());
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [el]);
  return layout;
}

/**
 * How far the on-screen keyboard (or anything else the visual viewport leaves out) covers the bottom of the
 * window, in CSS pixels; 0 where `visualViewport` is missing. Used to sit a bar above the keyboard.
 * @param active - Set false to stop listening (the value goes back to 0).
 */
export function useKeyboardInset(active = true): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!active || !vv) {
      setInset(0);
      return;
    }
    const update = () => setInset(Math.max(0, Math.round(window.innerHeight - (vv.height + vv.offsetTop))));
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, [active]);
  return inset;
}

/** Below this window width (px) Docs hides the app's project sidebar behind a menu button. */
export const DOCS_SIDEBAR_DRAWER_BELOW = 1100;

/**
 * Whether the window is narrower than `below`, kept up to date.
 * @param below - Width in CSS pixels.
 */
export function useNarrowWindow(below: number): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < below);
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < below);
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [below]);
  return narrow;
}
