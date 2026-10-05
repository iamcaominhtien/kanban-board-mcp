import { useEffect, useState } from 'react';

export type PillState = 'hidden' | 'loading' | 'slow';

export const PILL_TIMING = {
  showAfterMs: 300, // fast loads never flash the pill
  slowAfterMs: 3000, // then it turns into the "Still loading..." warning with a Retry link
} as const;

/**
 * Drives the status pill while the app loads. `phase` is e.g. 'projects' or 'tickets'
 * (null when nothing is loading); the timers restart whenever the phase changes.
 */
export function useLoadingPill(phase: string | null): PillState {
  const [state, setState] = useState<PillState>('hidden');

  useEffect(() => {
    setState('hidden');
    if (!phase) return;
    const show = window.setTimeout(() => setState('loading'), PILL_TIMING.showAfterMs);
    const slow = window.setTimeout(() => setState('slow'), PILL_TIMING.slowAfterMs);
    return () => {
      window.clearTimeout(show);
      window.clearTimeout(slow);
    };
  }, [phase]);

  return state;
}
