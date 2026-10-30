import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import type { ResizablePanel } from '../hooks/useResizablePanel';
import './PanelResizer.css';

/** The `style`/`className` a docked panel applies from its `useResizablePanel` state. */
export function panelSizing(p: ResizablePanel): { className: string; style?: { width: number } } {
  return p.maximized ? { className: 'pr-panel pr-maximized' } : { className: 'pr-panel', style: { width: p.width } };
}

/**
 * The drag handle on the left edge of a right-docked panel: drag to widen, arrow keys to nudge,
 * double-click to go back to the default width. Hidden while the panel is maximized.
 * @param props.panel - State from `useResizablePanel`.
 * @param props.label - Accessible name, e.g. "Resize Board AI".
 */
export function PanelResizer({ panel, label }: { panel: ResizablePanel; label: string }) {
  const drag = useRef<{ x: number; w: number } | null>(null);
  if (panel.maximized) return null;

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, w: panel.width };
    document.body.classList.add('pr-dragging');
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current) panel.setWidth(drag.current.w + (drag.current.x - e.clientX));
  };
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = null;
    document.body.classList.remove('pr-dragging');
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 96 : 24;
    if (e.key === 'ArrowLeft') panel.setWidth(panel.width + step);
    else if (e.key === 'ArrowRight') panel.setWidth(panel.width - step);
    else if (e.key === 'Home' || e.key === 'Enter') panel.reset();
    else return;
    e.preventDefault();
  };

  return (
    <div
      className="pr-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={panel.width}
      aria-valuemin={panel.min}
      aria-valuemax={panel.max}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      data-testid="panel-resizer"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onDoubleClick={panel.reset}
      onKeyDown={onKey}
    />
  );
}

/**
 * Maximize / restore button for a docked panel's header.
 * @param props.panel - State from `useResizablePanel`.
 * @param props.className - Header button class of the panel (so it looks like its neighbours).
 */
export function PanelMaxButton({ panel, className = 'ai-icobtn' }: { panel: ResizablePanel; className?: string }) {
  const label = panel.maximized ? 'Restore size' : 'Maximize';
  return (
    <button
      type="button"
      className={className}
      title={label}
      aria-label={label}
      aria-pressed={panel.maximized}
      data-testid="panel-maximize"
      onClick={panel.toggleMaximized}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {panel.maximized ? (
          <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
        ) : (
          <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
        )}
      </svg>
    </button>
  );
}
