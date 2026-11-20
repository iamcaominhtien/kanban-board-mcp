/**
 * Where the page header's actions sit as the room shrinks (design board "Rich Docs — reading", C, frames 21-28):
 * the same order everywhere. A main area of 1000 px or more shows them all; below that Export and Print go into
 * More; a tablet draws the rest as icons; a phone keeps only Edit and More (the follow bell becomes "Follow this
 * page" in More). Edit never moves into More on a tablet or a desktop.
 */

import { useEffect, useState } from 'react';
import type { DocsLayout } from '../../hooks/useDocsLayout';

/** The page actions that move. Edit and More always stay. */
export type HeaderAct = 'reader' | 'follow' | 'comments' | 'share' | 'export' | 'print';

/** `open`: a labelled button; `icon`: an icon button; `more`: an entry of the More menu. */
export type Placement = 'open' | 'icon' | 'more';

/** The width of the main area (px) from which every action is in the open. */
export const HEADER_WIDE_MIN = 1000;

/**
 * Where each action sits.
 * @param width - Width of the page's main area in CSS pixels; 0 when it is not measured yet (taken as wide).
 * @param layout - Desktop, tablet or phone.
 */
export function headerPlan(width: number, layout: DocsLayout): Record<HeaderAct, Placement> {
  if (layout === 'phone') {
    return { reader: 'more', follow: 'more', comments: 'more', share: 'more', export: 'more', print: 'more' };
  }
  if (layout === 'tablet') {
    return { reader: 'icon', follow: 'icon', comments: 'icon', share: 'icon', export: 'more', print: 'more' };
  }
  const wide = width === 0 || width >= HEADER_WIDE_MIN;
  return {
    reader: 'icon',
    follow: 'icon',
    comments: 'open',
    share: 'open',
    export: wide ? 'open' : 'more',
    print: wide ? 'open' : 'more',
  };
}

/**
 * The width of an element in CSS pixels, kept up to date (0 until it is measured or without ResizeObserver).
 * @param el - The element, or `null` while it is not mounted.
 */
export function useElementWidth(el: HTMLElement | null): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!el) return;
    setWidth(Math.round(el.getBoundingClientRect().width));
    if (typeof ResizeObserver === 'undefined') return;
    const obs = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(Math.round(w));
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, [el]);
  return width;
}

/**
 * How far an element is scrolled, 0 to 100, kept up to date (the reading progress bar under a page's bar).
 * @param el - The scrolling element, or `null` while it is not mounted.
 * @param resetKey - A value whose change measures again (the page shown).
 * @returns 0 while the element does not scroll.
 */
export function useScrollProgress(el: HTMLElement | null, resetKey?: unknown): number {
  const [pct, setPct] = useState(0);
  useEffect(() => {
    if (!el) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const room = el.scrollHeight - el.clientHeight;
      setPct(room > 0 ? Math.min(100, Math.max(0, (el.scrollTop / room) * 100)) : 0);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [el, resetKey]);
  return pct;
}
