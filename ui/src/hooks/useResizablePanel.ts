import { useCallback, useEffect, useState } from 'react';

const STORAGE_PREFIX = 'kanban.panel-width.';

/** Keeps a width inside [min, max]; `max` wins when the window is too small for `min`. */
export function clampWidth(width: number, min: number, max: number): number {
  return Math.round(Math.max(Math.min(min, max), Math.min(width, max)));
}

function readWidth(key: string): number | null {
  try {
    const n = Number(window.localStorage.getItem(STORAGE_PREFIX + key));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function writeWidth(key: string, width: number | null) {
  try {
    if (width == null) window.localStorage.removeItem(STORAGE_PREFIX + key);
    else window.localStorage.setItem(STORAGE_PREFIX + key, String(width));
  } catch {
    /* private mode / blocked storage: the width just isn't remembered */
  }
}

export interface ResizablePanel {
  /** Current width in px (ignored while maximized). */
  width: number;
  min: number;
  max: number;
  maximized: boolean;
  /** Set the width (clamped) and remember it. */
  setWidth: (w: number) => void;
  /** Back to the default width. */
  reset: () => void;
  toggleMaximized: () => void;
  setMaximized: (v: boolean) => void;
}

/**
 * Width and maximize state of a docked side panel (Board AI, ticket chat, inline comments…).
 * The width is remembered per `key`; maximize is not. Escape leaves maximize.
 * @param key - Storage key, one per kind of panel.
 * @param initial - Default width in px.
 * @param opts.min - Narrowest the panel can be dragged.
 * @param opts.max - Widest the panel can be dragged (also limited by the window).
 */
export function useResizablePanel(
  key: string,
  initial: number,
  opts: { min?: number; max?: number } = {},
): ResizablePanel {
  const min = opts.min ?? Math.min(300, initial);
  const hardMax = opts.max ?? 1100;
  const limit = () => Math.min(hardMax, Math.max(min, window.innerWidth - 240));
  const [raw, setRaw] = useState<number>(() => readWidth(key) ?? initial);
  const [maximized, setMaximized] = useState(false);
  const [max, setMax] = useState(limit);

  useEffect(() => {
    const onResize = () => setMax(limit());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hardMax, min]);

  useEffect(() => {
    if (!maximized) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setMaximized(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [maximized]);

  const setWidth = useCallback(
    (w: number) => {
      const next = clampWidth(w, min, limit());
      setRaw(next);
      writeWidth(key, next);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, min, hardMax],
  );
  const reset = useCallback(() => {
    setRaw(initial);
    writeWidth(key, null);
  }, [key, initial]);
  const toggleMaximized = useCallback(() => setMaximized((v) => !v), []);

  return { width: clampWidth(raw, min, max), min, max, maximized, setWidth, reset, toggleMaximized, setMaximized };
}
