import { useLayoutEffect, useRef, useState } from 'react';
import type { MenuHost, MenuState } from './menuHost';
import type { SlashCtx } from './slashItems';
import { InsertCatalog } from './blocks/InsertCatalog';

/**
 * Position a floating menu under a rect, flipping to stay inside the viewport.
 * @param rect - Anchor rectangle (the caret); `null` while closed.
 * @param width - Menu width in px, used to keep it inside the viewport.
 * @returns Ref for the menu element and its computed `pos` (null until measured).
 */
export function useMenuPosition(rect: DOMRect | null, width: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  // The menu's height, followed with a ResizeObserver as its list changes. It used to be read in a layout effect
  // that ran after every render and set the position: whenever React could not bail out of that update early, the
  // effect ran again after the render it caused, and the editor died with "Maximum update depth exceeded" (ED-9).
  const [height, setHeight] = useState<number | null>(null);
  const open = rect != null;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!open || !el) return;
    const measure = () => setHeight(el.offsetHeight);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);
  const rTop = rect?.top;
  const rBottom = rect?.bottom;
  const rLeft = rect?.left;
  useLayoutEffect(() => {
    if (rTop == null || rBottom == null || rLeft == null) return;
    const h = height ?? 300;
    const below = rBottom + 6;
    const top = below + h > window.innerHeight - 8 && rTop - 6 - h > 8 ? rTop - 6 - h : below;
    const left = Math.max(8, Math.min(rLeft, window.innerWidth - width - 8));
    setPos((p) => (p && p.top === top && p.left === left ? p : { top, left }));
  }, [rTop, rBottom, rLeft, width, height]);
  return { ref, pos };
}

/** Footer row of key hints for a floating menu. */
export function MenuFooter({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '6px 12px',
        padding: '8px 10px 4px',
        marginTop: 4,
        borderTop: '1px solid #EEF3EF',
        fontSize: 11.5,
        color: '#5B6B60',
      }}
    >
      {children}
    </div>
  );
}

/**
 * Key-cap plus label pair for a menu footer.
 * @param props.k - Key-cap text.
 */
export const Hint = ({ k, children }: { k: string; children: React.ReactNode }) => (
  <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
    <span className="dk-kbd">{k}</span>
    {children}
  </span>
);

interface Props {
  host: MenuHost;
  state: MenuState;
  ctx: SlashCtx;
}

/**
 * The "/" menu: the Insert catalog (Rich Docs board K), which the plus beside a block, Ctrl+/ and the ribbon's
 * Insert open too (they type the "/" for it, `openInsertCatalog`).
 * @param props.host - Menu host that routes keyboard events to the menu.
 * @param props.state - Current menu state (query, position).
 * @param props.ctx - Editor context passed to the chosen item.
 */
export function SlashMenu({ host, state, ctx }: Props) {
  return <InsertCatalog host={host} state={state} ctx={ctx} usePosition={useMenuPosition} />;
}
