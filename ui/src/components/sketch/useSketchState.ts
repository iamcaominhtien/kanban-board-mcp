import { useSyncExternalStore } from 'react';
import type { Sketcher, SketchState } from './sketcher';

const never = () => () => undefined;

/**
 * The screen state of a sketcher, re-read whenever it changes.
 * @param sketcher - The drawing engine, or null before the canvas exists.
 */
export function useSketchState(sketcher: Sketcher | null): SketchState | null {
  return useSyncExternalStore(sketcher ? sketcher.subscribe : never, sketcher ? sketcher.getState : () => null);
}

/**
 * Whether a media query matches, kept up to date.
 * @param query - CSS media query.
 */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(query);
      m.addEventListener('change', cb);
      return () => m.removeEventListener('change', cb);
    },
    () => window.matchMedia(query).matches,
  );
}
