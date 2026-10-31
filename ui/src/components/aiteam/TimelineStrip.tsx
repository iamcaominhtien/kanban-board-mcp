import { useRef, useState } from 'react';
import type { Timeline } from '../../types/aiTeam';
import { clock, type Axis } from './timelineLayout';

const ms = (iso: string): number => new Date(iso).getTime();
const MIN_WINDOW_MS = 5 * 60000;

/**
 * The range at a glance (design/screens/ai-team-timeline-cases.md, E4): a density chart of the whole window with a box
 * for what is on screen. Drag the box to move, drag an edge to zoom, click a spike to jump to it; ctrl + scroll zooms
 * around the pointer. Zooming sets a custom window; zooming out past the start returns to the range.
 * @param props.data - The Timeline.
 * @param props.axis - Its vertical axis.
 * @param props.view - What the diagram shows now: scroll position and height in px (below the header).
 * @param props.onScrollTo - Scroll the diagram to a y position.
 * @param props.onZoom - Show only [since, until] (ms); null returns to the chosen range.
 * @param props.zoomed - A custom window is on.
 */
export function TimelineStrip({
  data,
  axis,
  view,
  onScrollTo,
  onZoom,
  zoomed,
}: {
  data: Timeline;
  axis: Axis;
  view: { top: number; height: number };
  onScrollTo: (y: number) => void;
  onZoom: (win: { since: number; until: number } | null) => void;
  zoomed: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const since = ms(data.since);
  const until = ms(data.until);
  const span = Math.max(until - since, 1);
  const [drag, setDrag] = useState<{ kind: 'move' | 'left' | 'right'; grab: number; l: number; r: number } | null>(
    null,
  );

  const t0 = axis.timeAt(view.top);
  const t1 = axis.timeAt(view.top + view.height);
  const frac = (t: number) => Math.min(Math.max((t - since) / span, 0), 1);
  const l = drag ? drag.l : frac(t0);
  const r = drag ? drag.r : frac(t1);
  const at = (clientX: number): number => {
    const box = ref.current?.getBoundingClientRect();
    if (!box || box.width === 0) return 0;
    return Math.min(Math.max((clientX - box.left) / box.width, 0), 1);
  };
  const jump = (f: number) => onScrollTo(Math.max(axis.y(since + f * span) - 40, 0));

  const start = (kind: 'move' | 'left' | 'right') => (e: React.PointerEvent) => {
    e.stopPropagation();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* a pointer that is already gone: the drag still follows the moves */
    }
    setDrag({ kind, grab: at(e.clientX) - l, l, r });
  };
  const move = (e: React.PointerEvent) => {
    if (!drag) return;
    const f = at(e.clientX);
    if (drag.kind === 'move') {
      const w = drag.r - drag.l;
      const nl = Math.min(Math.max(f - drag.grab, 0), 1 - w);
      setDrag({ ...drag, l: nl, r: nl + w });
      jump(nl);
    } else if (drag.kind === 'left') setDrag({ ...drag, l: Math.min(f, drag.r - 0.02) });
    else setDrag({ ...drag, r: Math.max(f, drag.l + 0.02) });
  };
  const end = () => {
    if (!drag) return;
    if (drag.kind !== 'move') {
      const a = since + drag.l * span;
      const b = since + drag.r * span;
      if (b - a >= MIN_WINDOW_MS) onZoom({ since: a, until: b });
    }
    setDrag(null);
  };
  const wheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const f = at(e.clientX);
    const centre = since + f * span;
    const k = e.deltaY > 0 ? 1.4 : 1 / 1.4;
    const nextSpan = span * k;
    if (nextSpan < MIN_WINDOW_MS) return;
    const a = centre - f * nextSpan;
    onZoom({ since: a, until: a + nextSpan });
  };

  return (
    <div className="tl-strip-wrap">
      <div
        ref={ref}
        className="tl-density"
        data-testid="tl-density"
        role="slider"
        tabIndex={0}
        aria-label="The range at a glance: drag the box to move it, drag an edge to zoom"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(l * 100)}
        onWheel={wheel}
        onClick={(e) => jump(at(e.clientX))}
        onKeyDown={(e) => {
          if (e.key === 'Home') onScrollTo(0);
          if (e.key === 'End') onScrollTo(axis.height);
          if (e.key === 'ArrowLeft') jump(Math.max(l - 0.05, 0));
          if (e.key === 'ArrowRight') jump(Math.min(l + 0.05, 1));
        }}
      >
        {data.density.map((n, i) => (
          <i key={i} style={{ height: Math.min(4 + n * 6, 26), opacity: n ? 0.4 + Math.min(n, 5) * 0.1 : 0.15 }} />
        ))}
        <div
          className="tl-box"
          data-testid="tl-box"
          style={{ left: `${l * 100}%`, width: `${Math.max(r - l, 0.015) * 100}%` }}
          onPointerDown={start('move')}
          onPointerMove={move}
          onPointerUp={end}
          onClick={(e) => e.stopPropagation()}
        >
          <span
            className="tl-edge left"
            data-testid="tl-edge-left"
            onPointerDown={start('left')}
            onPointerMove={move}
            onPointerUp={end}
          />
          <span
            className="tl-edge right"
            data-testid="tl-edge-right"
            onPointerDown={start('right')}
            onPointerMove={move}
            onPointerUp={end}
          />
        </div>
      </div>
      <div className="tl-strip-labels">
        <span>{clock(since)}</span>
        <span>
          Drag the box to move it, drag an edge to zoom · ctrl + scroll zooms · Home and End go to the start and to now
        </span>
        {zoomed ? (
          <button type="button" className="tl-link" onClick={() => onZoom(null)} data-testid="tl-zoom-reset">
            Reset zoom
          </button>
        ) : (
          <span>now</span>
        )}
      </div>
    </div>
  );
}
