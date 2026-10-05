import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { setBackendPort } from '../api/resolveOrigin';

export type BackendStatus = 'connecting' | 'ready' | 'error';

interface ElectronAPI {
  onBackendReady?: (cb: (port: number) => void) => () => void;
  onBackendError?: (cb: (message: string) => void) => () => void;
  getBackendPort?: () => Promise<number | null>;
  retryBackend?: () => Promise<void>;
}

function electronAPI(): ElectronAPI | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

/** True when running inside the Electron shell (the Python backend is started by the main process). */
export function isElectron(): boolean {
  return !!electronAPI()?.onBackendReady;
}

/**
 * Tracks whether the Electron Python backend is ready to accept requests.
 *
 * - Outside Electron (web dev, Vite proxy): always returns 'ready'.
 * - Inside Electron: starts as 'connecting', transitions to 'ready' or 'error'
 *   based on the backend-ready / backend-error IPC events sent by main.js.
 *   The events are one-shot, so after a window reload (backend already up) the
 *   port is also asked for directly, otherwise the UI would wait forever.
 *
 * On transition to 'ready' it also:
 *   1. Updates the resolveOrigin cache with the confirmed port.
 *   2. Invalidates all React Query caches so data fetches immediately retry.
 */
export function useBackendStatus(): {
  status: BackendStatus;
  errorMessage: string | null;
  retry: () => void;
} {
  const queryClient = useQueryClient();

  const [status, setStatus] = useState<BackendStatus>(() => (isElectron() ? 'connecting' : 'ready'));
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const api = electronAPI();
    if (!api?.onBackendReady) return;

    const markReady = (port: number) => {
      if (cancelled) return;
      setBackendPort(port);
      setStatus('ready');
      setErrorMessage(null);
      queryClient.invalidateQueries();
    };

    const unsubReady = api.onBackendReady(markReady);
    const unsubError = api.onBackendError?.((msg: string) => {
      if (cancelled) return;
      setStatus('error');
      setErrorMessage(msg);
    });

    // The backend may already be up (window reload / re-created window): the ready event won't fire again
    api.getBackendPort?.().then((port) => {
      if (port) markReady(port);
    }).catch(() => { /* keep waiting for the event */ });

    return () => {
      cancelled = true;
      unsubReady?.();
      unsubError?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  const retry = useCallback(() => {
    const api = electronAPI();
    if (!api?.retryBackend) return;
    setStatus('connecting');
    setErrorMessage(null);
    setAttempt((n) => n + 1); // re-subscribe: the IPC events are one-shot
    void api.retryBackend().catch(() => { /* the error event reports the failure */ });
  }, []);

  return { status, errorMessage, retry };
}
