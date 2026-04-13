/**
 * Resolves the backend base URL at runtime.
 *
 * Priority:
 *  1. http:  context  → use current page origin. In Vite dev/QC this relies on the
 *                        dev proxy covering every backend route the UI calls,
 *                        including /uploads. In production the backend serves the UI.
 *  2. file:  context  → Electron desktop app: ask the preload bridge for the backend port.
 *  3. fallback        → VITE_API_URL env var, or http://127.0.0.1:8000.
 */

let _cache: Promise<string> | null = null;

export function resolveOrigin(): Promise<string> {
  if (!_cache) {
    _cache = (async () => {
      if (typeof window !== 'undefined' && window.location.protocol === 'http:') {
        return window.location.origin;
      }
      if (typeof window !== 'undefined' && (window as any).electronAPI?.getBackendPort) {
        const port = await (window as any).electronAPI.getBackendPort();
        if (port) return `http://127.0.0.1:${port}`;
      }
      return import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:8000';
    })();
  }
  return _cache;
}
