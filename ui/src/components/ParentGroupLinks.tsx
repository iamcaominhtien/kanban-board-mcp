import { useLayoutEffect, useState, type RefObject } from 'react';

interface Link {
  d: string;
  /** "cross": a dashed connector to a sub-ticket in another column; "elbow": to the one indented under the parent. */
  kind: 'cross' | 'elbow';
}

/**
 * The connectors of a selected parent group (Sub-task Grouping 1, comp-1 BG-1): a dashed curve to every sub-ticket
 * in another column and an elbow to each one indented under the parent in its own column. Drawn under the cards, in
 * the coordinates of the columns container, and redrawn when a column scrolls or the board changes size.
 */
export function ParentGroupLinks({
  containerRef,
  parentId,
  childIds,
  version,
}: Readonly<{
  containerRef: RefObject<HTMLDivElement | null>;
  parentId: string;
  childIds: string[];
  /** Changes when the cards may have moved (tickets changed), so the links are measured again. */
  version: unknown;
}>) {
  const [links, setLinks] = useState<Link[]>([]);
  const childKey = childIds.join(',');

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // A card scrolled out of its column has no connector (the line would run off into the column's hidden part)
    const rectOf = (id: string) => {
      const card = el.querySelector<HTMLElement>(`[data-ticket-id="${CSS.escape(id)}"]`);
      if (!card) return null;
      const r = card.getBoundingClientRect();
      const body = card.closest<HTMLElement>('[data-column-body]')?.getBoundingClientRect();
      if (body && (r.bottom < body.top + 8 || r.top > body.bottom - 8)) return null;
      return r;
    };

    const measure = () => {
      const base = el.getBoundingClientRect();
      const ox = el.scrollLeft - base.left;
      const oy = el.scrollTop - base.top;
      const p = rectOf(parentId);
      if (!p) {
        setLinks([]);
        return;
      }
      const next: Link[] = [];
      for (const id of childKey ? childKey.split(',') : []) {
        const c = rectOf(id);
        if (!c) continue;
        const sameColumn = c.left < p.right && c.right > p.left;
        if (sameColumn) {
          // Elbow: from under the parent's left edge, down, then into the indented card
          const x = (p.left + c.left) / 2 + ox;
          const y2 = c.top + Math.min(c.height / 2, 20) + oy;
          next.push({ d: `M${x},${p.bottom + oy} L${x},${y2} L${c.left + ox},${y2}`, kind: 'elbow' });
        } else {
          const right = c.left >= p.right;
          const x1 = (right ? p.right : p.left) + ox;
          const x2 = (right ? c.left : c.right) + ox;
          const y1 = p.top + Math.min(p.height / 2, 40) + oy;
          const y2 = c.top + Math.min(c.height / 2, 40) + oy;
          const mx = (x1 + x2) / 2;
          next.push({ d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`, kind: 'cross' });
        }
      }
      setLinks(next);
    };

    measure();
    el.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
      ro?.disconnect();
    };
  }, [containerRef, parentId, childKey, version]);

  if (links.length === 0) return null;
  return (
    <svg
      aria-hidden="true"
      data-testid="parent-group-links"
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: '100%',
        height: '100%',
        overflow: 'visible',
        pointerEvents: 'none',
      }}
    >
      {links.map((l, i) =>
        l.kind === 'cross' ? (
          <path key={i} d={l.d} fill="none" stroke="#68BA7F" strokeWidth={1.5} strokeDasharray="3 3" />
        ) : (
          <path
            key={i}
            d={l.d}
            fill="none"
            stroke="#9BB3A4"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ),
      )}
    </svg>
  );
}
