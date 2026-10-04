import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { resolveOrigin } from '../api/resolveOrigin';
import { isElectron, type BackendStatus } from '../hooks/useBackendStatus';
import styles from './Splash.module.css';

/**
 * The splash is painted by index.html before any JS runs (logo, wordmark, progress bar).
 * This component takes it over once React is up: it decides when the app is reachable,
 * shows the error / slow states, and fades the splash out (200 ms) when it is time.
 */

export const SPLASH_TIMING = {
  minShowMs: 600, // never flash: the splash stays at least this long
  introMs: 1200, // on a cold start the intro plays once, so it also has to finish
  maxWaitMs: 8000, // after this the loading state is replaced by the error state
  probeTimeoutMs: 4000,
  fastRetryMs: 1000, // while still within the first maxWaitMs
  retryMs: 10000, // fixed retry while the splash is up (first minute)
  backoffAfterMs: 60000, // then 10 / 20 / 40 s, capped at 60 s, with jitter
  backoffCapMs: 60000,
  leaveMs: 200,
} as const;

/** Delay before the next reachability probe. `elapsedMs` is the time since the page started loading. */
export function nextRetryDelay(elapsedMs: number, slowFailures: number, random: () => number = Math.random): number {
  if (elapsedMs < SPLASH_TIMING.maxWaitMs) return SPLASH_TIMING.fastRetryMs;
  if (elapsedMs < SPLASH_TIMING.backoffAfterMs) return SPLASH_TIMING.retryMs;
  const base = Math.min(SPLASH_TIMING.backoffCapMs, SPLASH_TIMING.retryMs * 2 ** slowFailures);
  return Math.round(base * (0.9 + random() * 0.2));
}

async function probeHealth(): Promise<boolean> {
  const ctl = new AbortController();
  const timer = window.setTimeout(() => ctl.abort(), SPLASH_TIMING.probeTimeoutMs);
  try {
    const res = await fetch(`${resolveOrigin()}/health`, { cache: 'no-store', signal: ctl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timer);
  }
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

function formatClock(d: Date): string {
  return d.toLocaleTimeString([], { hour12: false });
}

type View = 'loading' | 'unreachable' | 'slow' | 'failed';

interface SplashProps {
  status: BackendStatus;
  errorMessage: string | null;
  onRetryBackend: () => void;
}

export function Splash({ status, errorMessage, onRetryBackend }: SplashProps) {
  const [rootEl] = useState(() => (typeof document === 'undefined' ? null : document.getElementById('kb-splash')));
  const [altEl] = useState(() => (typeof document === 'undefined' ? null : document.getElementById('kb-splash-alt')));
  const electron = isElectron();
  const queryClient = useQueryClient();

  const [healthy, setHealthy] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [gone, setGone] = useState(rootEl === null);
  const [lastAttempt, setLastAttempt] = useState<Date | null>(null);
  const [nextAt, setNextAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const probeNowRef = useRef<() => void>(() => {});
  const retryBtnRef = useRef<HTMLButtonElement>(null);

  const ready = electron ? status === 'ready' : healthy;
  const view: View = electron
    ? status === 'error'
      ? 'failed'
      : timedOut && !ready
        ? 'slow'
        : 'loading'
    : timedOut && !ready
      ? 'unreachable'
      : 'loading';

  // The page behind the splash must not be reachable by keyboard or screen reader while it is up
  useEffect(() => {
    if (gone) return;
    const appRoot = document.getElementById('root');
    appRoot?.setAttribute('inert', '');
    return () => appRoot?.removeAttribute('inert');
  }, [gone]);

  // Loading -> error after the maximum wait (the checks keep going in the background)
  useEffect(() => {
    if (ready || gone) return;
    const t = window.setTimeout(() => setTimedOut(true), Math.max(0, SPLASH_TIMING.maxWaitMs - performance.now()));
    return () => window.clearTimeout(t);
  }, [ready, gone]);

  // Web: poll GET /health until the server answers. (Electron waits for the backend-ready event instead.)
  useEffect(() => {
    if (electron || gone) return;
    let cancelled = false;
    let timer: number | undefined;
    let failures = 0;
    let slowFailures = 0;

    const run = async () => {
      window.clearTimeout(timer);
      setLastAttempt(new Date());
      const ok = await probeHealth();
      if (cancelled) return;
      if (ok) {
        if (failures > 0) void queryClient.invalidateQueries(); // data requests that failed meanwhile retry now
        setHealthy(true);
        return;
      }
      failures += 1;
      const elapsed = performance.now();
      if (elapsed >= SPLASH_TIMING.backoffAfterMs) slowFailures += 1;
      const delay = nextRetryDelay(elapsed, Math.max(0, slowFailures - 1));
      setNextAt(Date.now() + delay);
      timer = window.setTimeout(run, delay);
    };

    probeNowRef.current = () => void run();
    void run();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [electron, gone, queryClient]);

  // Countdown ("Retrying in 7s") only ticks while the error panel is visible
  useEffect(() => {
    if (view !== 'unreachable') return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [view]);

  // Swap the first-paint content for the error panel, and put focus on "Try again"
  useEffect(() => {
    if (!rootEl || gone) return;
    rootEl.classList.toggle('kb-state-alt', view !== 'loading');
    if (view === 'unreachable' || view === 'failed') retryBtnRef.current?.focus();
  }, [view, rootEl, gone]);

  const leave = useCallback(() => {
    if (!rootEl) return;
    const remove = () => {
      rootEl.remove();
      try {
        window.sessionStorage.setItem('kb-splash-seen', '1');
      } catch {
        /* storage blocked: the intro just plays again next time */
      }
      setGone(true);
    };
    if (prefersReducedMotion()) {
      remove();
      return;
    }
    rootEl.classList.add('kb-leave'); // 200 ms cross-fade, the app is already rendered underneath
    window.setTimeout(remove, SPLASH_TIMING.leaveMs + 30);
  }, [rootEl]);

  // Ready: wait out the minimum display time (longer while the cold-start intro is still playing), then fade out
  useEffect(() => {
    if (!ready || gone) return;
    const cold = document.documentElement.getAttribute('data-splash') === 'cold';
    const minShow = cold ? SPLASH_TIMING.introMs : SPLASH_TIMING.minShowMs;
    const wait = timedOut ? 0 : Math.max(0, minShow - performance.now());
    const t = window.setTimeout(leave, wait);
    return () => window.clearTimeout(t);
  }, [ready, gone, timedOut, leave]);

  if (gone || !altEl || view === 'loading') return null;

  const secondsLeft = nextAt === null ? null : Math.max(0, Math.ceil((nextAt - now) / 1000));
  const title =
    view === 'unreachable'
      ? "Can't reach the server"
      : view === 'slow'
        ? 'Kanban is taking longer than usual to start'
        : "Can't start the local server";
  const text =
    view === 'unreachable'
      ? "Check your connection. We'll keep trying every 10 seconds."
      : view === 'slow'
        ? 'Hang on. Kanban will open as soon as its local server is ready.'
        : "Kanban couldn't start its local server. Try again, or restart the app if the problem persists.";

  return createPortal(
    <div className={styles.panel}>
      <div className={styles.mark} aria-hidden="true">
        <div className={styles.markBack} />
        <div className={styles.markFront}>
          <div className={styles.markLine} style={{ width: '60%' }} />
          <div className={styles.markLine} style={{ width: '85%' }} />
        </div>
      </div>
      <div role="alert" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <h1 className={styles.title}>{title}</h1>
        <p className={styles.text}>{text}</p>
      </div>
      {view === 'failed' && errorMessage && <pre className={styles.detail}>{errorMessage}</pre>}
      {(view === 'unreachable' || view === 'failed') && (
        <button
          ref={retryBtnRef}
          type="button"
          className={styles.btn}
          onClick={() => (view === 'failed' ? onRetryBackend() : probeNowRef.current())}
        >
          Try again
        </button>
      )}
      {view === 'unreachable' && (
        <div className={styles.chips}>
          {lastAttempt && (
            <span className={styles.chip}>
              <span className={styles.dot} />
              Last attempt {formatClock(lastAttempt)}
            </span>
          )}
          {secondsLeft !== null && (
            <span className={styles.retrying} aria-hidden="true">
              <span className={styles.ring} />
              Retrying in {secondsLeft}s
            </span>
          )}
        </div>
      )}
    </div>,
    altEl,
  );
}
