/**
 * Extracts a human-readable error message from an Axios error response or any Error.
 * Prefers the backend's `detail` field, then falls back to `message`.
 */
export function extractError(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as any;
    const detail = e?.response?.data?.detail;
    // Idea Space rules answer with {code, message}
    if (detail && typeof detail === 'object' && typeof detail.message === 'string') return detail.message;
    return detail || e?.response?.data?.traceback || e?.message || 'Unknown error';
  }
  return String(err);
}
