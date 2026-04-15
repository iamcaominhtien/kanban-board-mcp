import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { setBackendPort } from '../api/resolveOrigin';

export type BackendStatus = 'connecting' | 'ready' | 'error';

/**
 * Tracks whether the Electron Python backend is ready to accept requests.
 *
 * - Outside Electron (web dev, Vite proxy): always returns 'ready'.
 * - Inside Electron: starts as 'connecting', transitions to 'ready' or 'error'
 *   based on the backend-ready / backend-error IPC events sent by main.js.
 *
 * On transition to 'ready' it also:
 *   1. Updates the resolveOrigin cache with the confirmed port.
 *   2. Invalidates all React Query caches so data fetches immediately retry.
 */
export function useBackendStatus(): { status: BackendStatus; errorMessage: string | null } {
  const queryClient = useQueryClient();

  const [status, setStatus] = useState<BackendStatus>(() => {
    // In a non-Electron context (Vite dev / web) the backend is already reachable.
    if (typeof window === 'undefined') return 'ready';
    if (!(window as any).electronAPI?.onBackendReady) return 'ready';
    return 'connecting';
  });

  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const api = (window as any).electronAPI;
    if (!api?.onBackendReady) return;

    const unsubReady = api.onBackendReady((port: number) => {
      if (cancelled) return;
      setBackendPort(port);
      setStatus('ready');
      queryClient.invalidateQueries();
    });
    const unsubError = api.onBackendError?.((msg: string) => {
      if (cancelled) return;
      setStatus('error');
      setErrorMessage(msg);
    });

    return () => {
      cancelled = true;
      unsubReady?.();
      unsubError?.();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { status, errorMessage };
}
