/**
 * Resolves the backend base URL at runtime.
 *
 * Priority:
 *  1. http:  context  → use current page origin (Vite dev server proxy, or
 *                        production when backend serves the UI over http).
 *  2. file:  context  → Electron desktop: ask the preload bridge for the port.
 *  3. fallback        → VITE_API_URL env var, or http://127.0.0.1:8000.
 *
 * The cache can be updated via `setBackendPort()` which is called by the
 * `useBackendStatus` hook when the backend-ready IPC event fires.  This lets
 * early callers (before the backend is up) receive the correct origin once the
 * server is available without performing a full page reload.
 */

let _cache: string | null = null;

/** Called by the backend-ready IPC handler to wire in the confirmed port. */
export function setBackendPort(port: number): void {
  _cache = `http://127.0.0.1:${port}`;
}

export function resolveOrigin(): string {
  if (_cache) return _cache;

  if (typeof window !== 'undefined') {
    if (window.location.protocol === 'http:') {
      _cache = window.location.origin;
      return _cache;
    }
  }

  const fallback = import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:8000';
  return fallback;
}
