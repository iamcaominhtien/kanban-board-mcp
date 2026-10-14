import { resolveOrigin } from '../api/resolveOrigin';

const DEDUPE_MS = 10_000;
const MAX_PER_MINUTE = 30;

const recent = new Map<string, number>();
let sentTimes: number[] = [];
let installed = false;

function describe(value: unknown): { message: string; stack?: string } {
  if (value instanceof Error) return { message: `${value.name}: ${value.message}`, stack: value.stack };
  if (typeof value === 'string') return { message: value };
  try {
    return { message: JSON.stringify(value) ?? String(value) };
  } catch {
    return { message: String(value) };
  }
}

/**
 * Report a UI problem to the server's application log. Never throws and never reports
 * the same message twice within 10 s, so a render loop cannot flood the log.
 * @param level - Severity of the problem.
 * @param message - What went wrong.
 * @param stack - Optional stack trace.
 */
export function reportClientLog(level: 'error' | 'warning', message: string, stack?: string): void {
  try {
    const now = Date.now();
    const key = `${level}:${message}`;
    const last = recent.get(key);
    if (last !== undefined && now - last < DEDUPE_MS) return;
    recent.set(key, now);
    if (recent.size > 200) recent.clear();
    sentTimes = sentTimes.filter((t) => now - t < 60_000);
    if (sentTimes.length >= MAX_PER_MINUTE) return;
    sentTimes.push(now);

    void fetch(`${resolveOrigin()}/logs/client`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        level,
        message: message.slice(0, 2000),
        stack: stack?.slice(0, 8000),
        url: window.location.href.slice(0, 500),
      }),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // Logging must never break the app.
  }
}

/** Forward uncaught errors, unhandled promise rejections and `console.error` to the server log. */
export function installClientLogging(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  window.addEventListener('error', (event) => {
    const detail = event.error ? describe(event.error) : { message: event.message };
    const where = event.filename ? ` (${event.filename}:${event.lineno}:${event.colno})` : '';
    reportClientLog('error', `Uncaught ${detail.message}${where}`, detail.stack);
  });

  window.addEventListener('unhandledrejection', (event) => {
    const detail = describe(event.reason);
    reportClientLog('error', `Unhandled rejection: ${detail.message}`, detail.stack);
  });

  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    original(...args);
    const parts = args.map(describe);
    const stack = parts.find((p) => p.stack)?.stack;
    reportClientLog('error', parts.map((p) => p.message).join(' '), stack);
  };
}
