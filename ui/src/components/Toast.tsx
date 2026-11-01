import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import styles from './Toast.module.css';

export type ToastVariant = 'success' | 'error' | 'warning' | 'info';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastItem {
  id: string;
  variant: ToastVariant;
  title: string;
  message?: string;
  duration?: number;
  /** Optional button on the toast (e.g. Undo). */
  action?: ToastAction;
  /** Optional second button (e.g. Review and Deny). */
  secondaryAction?: ToastAction;
  /** Called once when the toast goes away: closed, timed out, collapsed into "+N more" or removed. */
  onClose?: () => void;
}

interface ToastContextValue {
  showToast: (props: Omit<ToastItem, 'id'>) => string;
  removeToast: (id: string) => void;
  success: (title: string, message?: string, duration?: number, action?: ToastAction) => string;
  error: (title: string, message?: string, duration?: number, action?: ToastAction) => string;
  warning: (title: string, message?: string, duration?: number, action?: ToastAction) => string;
  info: (title: string, message?: string, duration?: number, action?: ToastAction) => string;
  /** The quiet line: a small grey line at the bottom of the window for 2 s (no icon, no close, no history). */
  quiet: (text: string, action?: ToastAction) => string;
}

/** Real toasts on screen at once; a further one collapses the oldest into "+N more". */
export const MAX_TOASTS = 3;
/** How long the quiet line stays. */
export const QUIET_MS = 2000;

interface QuietItem {
  id: string;
  text: string;
  action?: ToastAction;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const newId = () => `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

/** Runs `onDone` after `ms`, unless the pointer is over the element: hovering stops the timer and it resumes with what was left. */
function useHoverTimer(ms: number, onDone: () => void) {
  const [hover, setHover] = useState(false);
  const left = useRef(ms);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (hover || ms <= 0) return;
    const started = Date.now();
    const t = setTimeout(() => done.current(), left.current);
    return () => {
      clearTimeout(t);
      left.current = Math.max(0, left.current - (Date.now() - started));
    };
  }, [hover, ms]);
  return { onMouseEnter: () => setHover(true), onMouseLeave: () => setHover(false) };
}

const ICON_PROPS = {
  width: 13,
  height: 13,
  viewBox: '0 0 24 24',
  fill: 'none',
  strokeWidth: 2.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

function VariantIcon({ variant }: { variant: ToastVariant }) {
  switch (variant) {
    case 'success':
      return (
        <svg {...ICON_PROPS} stroke="#2E6F40">
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
      );
    case 'error':
      return (
        <svg {...ICON_PROPS} stroke="#C4432A">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      );
    case 'warning':
      return (
        <svg {...ICON_PROPS} stroke="#B8860B">
          <path d="M12 4l9 16H3L12 4z" />
          <path d="M12 10v4M12 17v.5" />
        </svg>
      );
    case 'info':
      return (
        <svg {...ICON_PROPS} stroke="#244E78">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v5M12 8h.01" />
        </svg>
      );
  }
}

const ICON_CLASS: Record<ToastVariant, string> = {
  success: styles.iconSuccess,
  error: styles.iconError,
  warning: styles.iconWarning,
  info: styles.iconInfo,
};

function ToastCard({ toast, onClose }: { toast: ToastItem; onClose: (id: string) => void }) {
  const hover = useHoverTimer(toast.duration ?? 0, () => onClose(toast.id));
  return (
    <div className={styles.toast} role="alert" {...hover}>
      <span className={`${styles.icon} ${ICON_CLASS[toast.variant]}`}>
        <VariantIcon variant={toast.variant} />
      </span>
      <div className={styles.content}>
        <div className={styles.title} title={toast.title}>
          {toast.title}
        </div>
        {toast.message && <div className={styles.message}>{toast.message}</div>}
      </div>
      {[toast.action, toast.secondaryAction].map(
        (a) =>
          a && (
            <button
              key={a.label}
              type="button"
              className={styles.actionButton}
              onClick={() => {
                a.onClick();
                onClose(toast.id);
              }}
            >
              {a.label}
            </button>
          ),
      )}
      <button
        type="button"
        className={styles.closeButton}
        onClick={() => onClose(toast.id)}
        aria-label="Close notification"
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  );
}

function QuietLine({ item, onClose }: { item: QuietItem; onClose: (id: string) => void }) {
  const hover = useHoverTimer(QUIET_MS, () => onClose(item.id));
  return (
    <div className={styles.quiet} role="status" {...hover}>
      <span className={styles.quietText}>{item.text}</span>
      {item.action && (
        <>
          <span className={styles.quietDot}>&middot;</span>
          <button
            type="button"
            className={styles.quietAction}
            onClick={() => {
              item.action?.onClick();
              onClose(item.id);
            }}
          >
            {item.action.label}
          </button>
        </>
      )}
    </div>
  );
}

/**
 * Context provider that renders toasts and the quiet line.
 *
 * Rule for action feedback: `success(...)` / `info(...)` (and `showToast` with those variants) WITHOUT a
 * `secondaryAction` and with a duration other than 0 become the quiet line, keeping a single `action` (Undo) as a
 * link. `error` / `warning`, anything with two actions and anything that asks to stay (duration 0) stay real toasts.
 * Nothing makes a sound.
 */
export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [more, setMore] = useState(0);
  const [quietItem, setQuietItem] = useState<QuietItem | null>(null);

  // mirrors `toasts` so the list can be changed (and `onClose` called) outside a state updater
  const toastsRef = useRef<ToastItem[]>([]);

  const removeToast = useCallback((id: string) => {
    const gone = toastsRef.current.find((t) => t.id === id);
    if (gone) {
      toastsRef.current = toastsRef.current.filter((t) => t.id !== id);
      setToasts(toastsRef.current);
      gone.onClose?.();
    }
    setQuietItem((prev) => (prev && prev.id === id ? null : prev));
  }, []);

  const quiet = useCallback((text: string, action?: ToastAction) => {
    const id = newId();
    setQuietItem({ id, text, action });
    return id;
  }, []);

  const showToast = useCallback(
    ({ variant, title, message, duration, action, secondaryAction, onClose }: Omit<ToastItem, 'id'>) => {
      if ((variant === 'success' || variant === 'info') && !secondaryAction && duration !== 0) {
        return quiet(message ? `${title} · ${message}` : title, action);
      }
      // a toast with an action button stays a little longer so it can be used
      if (duration === undefined) duration = action ? 8000 : 4000;
      const id = newId();
      const next = [...toastsRef.current, { id, variant, title, message, duration, action, secondaryAction, onClose }];
      const over = next.length - MAX_TOASTS;
      toastsRef.current = over > 0 ? next.slice(over) : next;
      setToasts(toastsRef.current);
      if (over > 0) {
        setMore((m) => m + over);
        next.slice(0, over).forEach((t) => t.onClose?.());
      }
      return id;
    },
    [quiet],
  );

  // "+N more" lasts as long as the toasts it stands for
  useEffect(() => {
    if (toasts.length === 0) setMore(0);
  }, [toasts.length]);

  const success = useCallback(
    (title: string, message?: string, duration?: number, action?: ToastAction) =>
      showToast({ variant: 'success', title, message, duration, action }),
    [showToast],
  );

  const error = useCallback(
    (title: string, message?: string, duration?: number, action?: ToastAction) =>
      showToast({ variant: 'error', title, message, duration, action }),
    [showToast],
  );

  const warning = useCallback(
    (title: string, message?: string, duration?: number, action?: ToastAction) =>
      showToast({ variant: 'warning', title, message, duration, action }),
    [showToast],
  );

  const info = useCallback(
    (title: string, message?: string, duration?: number, action?: ToastAction) =>
      showToast({ variant: 'info', title, message, duration, action }),
    [showToast],
  );

  return (
    <ToastContext.Provider value={{ showToast, removeToast, success, error, warning, info, quiet }}>
      {children}
      <div className={styles.toastContainer} aria-live="polite">
        {toasts.map((toast) => (
          <ToastCard key={toast.id} toast={toast} onClose={removeToast} />
        ))}
        {more > 0 && (
          <div className={styles.more} data-testid="toast-more">
            <b className={styles.moreCount}>+{more} more</b>
            <span className={styles.moreHint}>in Notifications</span>
            <span className={styles.moreSpacer} />
            <button
              type="button"
              className={styles.actionButton}
              onClick={() => {
                window.dispatchEvent(new CustomEvent('kanban:notifications', { detail: { open: 'panel' } }));
                setMore(0);
              }}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M6 17V11a6 6 0 0 1 12 0v6l1.5 2h-15L6 17zM10 21h4" />
              </svg>
              Open
            </button>
          </div>
        )}
      </div>
      {quietItem && <QuietLine key={quietItem.id} item={quietItem} onClose={removeToast} />}
    </ToastContext.Provider>
  );
};

/**
 * Access the toast API; must be used inside `ToastProvider`.
 * @throws Error when used outside `ToastProvider`.
 */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return ctx;
}

export interface InlineBannerProps {
  message: string;
  icon?: string;
  className?: string;
}

/** Inline confirmation banner. */
export const InlineBanner: React.FC<InlineBannerProps> = ({ message, icon = '✓', className }) => {
  return (
    <div className={`${styles.inlineBanner} ${className ?? ''}`}>
      <span className={styles.bannerIcon}>{icon}</span>
      <span className={styles.bannerText}>{message}</span>
    </div>
  );
};
