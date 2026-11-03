import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Engine, Finding, FindingLevel } from '../../../api/database';
import { SIcon } from '../settingsUi';
import settings from '../SettingsPage.module.css';
import { ENGINE_ABBR, splitTitle } from './dbFormat';
import styles from './Database.module.css';

/** Building blocks of the Database card and the move wizard (design/screens/ai-databases.md B to E). */

/** Line icons the Database screens need beyond the Settings set. */
export const DB_ICONS = {
  database: (
    <>
      <ellipse cx="12" cy="6" rx="7" ry="3" />
      <path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" />
    </>
  ),
  edit: <path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" />,
  refresh: <path d="M20 11a8 8 0 0 0-14.5-4M4 4v4h4M4 13a8 8 0 0 0 14.5 4M20 20v-4h-4" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5M12 7.5v.01" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6L6 18" />,
  pause: <path d="M9 5v14M15 5v14" />,
  play: <path d="M8 5l11 7-11 7z" />,
  eye: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
  eyeOff: (
    <path d="M3 3l18 18M10.6 6a9.6 9.6 0 0 1 1.4-.1c6 0 9.5 6.1 9.5 6.1a17 17 0 0 1-2.6 3.3M6.6 6.6C4 8.3 2.5 12 2.5 12S6 18.5 12 18.5c1.7 0 3.2-.5 4.5-1.2M9.9 9.9a3 3 0 0 0 4.2 4.2" />
  ),
  terminal: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="M7 9.5l3 2.5-3 2.5M12.5 15h4.5" />
    </>
  ),
  arrowRight: <path d="M5 12h14M13 6l6 6-6 6" />,
  chevronRight: <path d="M9 6l6 6-6 6" />,
  copy: (
    <>
      <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
      <path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" />
    </>
  ),
  warn: <path d="M12 4l9 16H3zM12 10v4.5M12 17.2v.01" />,
  sparkle: <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />,
  cloudOff: (
    <>
      <path d="M3 3l18 18" />
      <path d="M8.5 7.6A5.5 5.5 0 0 1 17 11a4 4 0 0 1 2.9 5.9M17 18H7a4.5 4.5 0 0 1-1.6-8.7" />
    </>
  ),
  chat: <path d="M21 12a8 8 0 0 1-11.5 7.2L4 20.5l1.4-4.6A8 8 0 1 1 21 12z" />,
  code: <path d="M9 7l-5 5 5 5M15 7l5 5-5 5" />,
  hide: (
    <path d="M3 3l18 18M10.6 6a9.6 9.6 0 0 1 1.4-.1c6 0 9.5 6.1 9.5 6.1a17 17 0 0 1-2.6 3.3M6.6 6.6C4 8.3 2.5 12 2.5 12S6 18.5 12 18.5c1.7 0 3.2-.5 4.5-1.2" />
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  checkCircle: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.5l3 3 5-6" />
    </>
  ),
  xCircle: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9 9l6 6M15 9l-6 6" />
    </>
  ),
  circle: <circle cx="12" cy="12" r="8" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  trash: <path d="M4 7h16M9 7V4h6v3M6.5 7l1 13h9l1-13M10 11v6M14 11v6" />,
  back: <path d="M19 12H5M11 6l-6 6 6 6" />,
} as const;

const LEVEL_COLOR: Record<FindingLevel, string> = {
  ok: '#2E6F40',
  info: '#5B6B60',
  warn: '#B4791E',
  error: '#C4432A',
};

/** The two-letter engine badge (SQ, PG, MY). */
export function EngineBadge({ engine, size = 'md' }: { engine: Engine; size?: 'sm' | 'md' }) {
  return (
    <span className={`${styles.badge} ${styles[`badge_${engine}`]} ${size === 'sm' ? styles.badgeSm : ''}`}>
      {ENGINE_ABBR[engine]}
    </span>
  );
}

/** A small turning circle while something is asked. */
export function Spinner({ size = 14 }: { size?: number }) {
  return <span className={styles.spinner} style={{ width: size, height: size }} aria-hidden="true" />;
}

/** Copy text to the clipboard (with the old way where the Clipboard API is missing). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

/** A button that copies `text` and says "Copied" for a moment. */
export function CopyButton({ text, label, testId }: { text: string; label: string; testId?: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1500);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button
      type="button"
      className={settings.btn}
      data-testid={testId}
      onClick={() => void copyText(text).then((ok) => setDone(ok))}
    >
      <SIcon d={done ? DB_ICONS.check : DB_ICONS.copy} size={14} />
      {done ? 'Copied' : label}
    </button>
  );
}

/** A title split on its first " · ", the first part bold. */
export function SplitTitle({ title }: { title: string }) {
  const [head, rest] = splitTitle(title);
  return (
    <>
      <b>{head}</b>
      {rest && <span className={styles.lineRest}> · {rest}</span>}
    </>
  );
}

/** The icon of a line by its level. */
export function LevelIcon({ level, size = 16 }: { level: FindingLevel; size?: number }) {
  const d =
    level === 'ok'
      ? DB_ICONS.checkCircle
      : level === 'error'
        ? DB_ICONS.close
        : level === 'warn'
          ? DB_ICONS.warn
          : DB_ICONS.info;
  return <SIcon d={d} size={size} stroke={LEVEL_COLOR[level]} width={level === 'error' ? 2.2 : 1.8} />;
}

/** One coloured line: an icon, a title (bold up to the first " · ") and a detail, with optional content under it. */
export function Line({
  level,
  title,
  detail,
  children,
  testId,
}: {
  level: FindingLevel;
  title: string;
  detail?: ReactNode;
  children?: ReactNode;
  testId?: string;
}) {
  return (
    <li className={`${styles.line} ${styles[`line_${level}`]}`} data-testid={testId} data-level={level}>
      <span className={styles.lineIcon}>
        <LevelIcon level={level} />
      </span>
      <div className={styles.lineBody}>
        <div>
          <SplitTitle title={title} />
        </div>
        {detail && <div className={styles.lineDetail}>{detail}</div>}
        {children}
      </div>
    </li>
  );
}

/** "What the test found": one line per finding; a fix comes in a code block with "Copy the statement". */
export function FindingList({ findings, title = 'What the test found' }: { findings: Finding[]; title?: string }) {
  return (
    <div className={styles.findings} data-testid="test-findings">
      <div className={styles.eyebrow}>{title}</div>
      <ul className={styles.lines}>
        {findings.map((f) => (
          <Line key={f.key} level={f.level} title={f.title} detail={f.detail || undefined} testId={`finding-${f.key}`}>
            {f.fix && (
              <div className={styles.fix}>
                <pre className={styles.fixCode}>{f.fix}</pre>
                <CopyButton text={f.fix} label={f.fixLabel || 'Copy the statement'} />
              </div>
            )}
          </Line>
        ))}
      </ul>
    </div>
  );
}

/** A dark code box with a small caption ("what the board knows", "proposed script"). */
export function DarkCode({ caption, children, testId }: { caption: string; children: ReactNode; testId?: string }) {
  return (
    <div className={styles.dark} data-testid={testId}>
      <div className={styles.darkHead}>
        <SIcon d={DB_ICONS.terminal} size={13} />
        {caption}
      </div>
      <div className={styles.darkBody}>{children}</div>
    </div>
  );
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal over the page: a portal, Escape closes it, Tab stays inside, and focus goes back to where it was when it
 * closes. The title row has an icon, the title, an optional line under it and a Close button.
 */
export function Modal({
  title,
  icon = DB_ICONS.database,
  sub,
  head,
  footer,
  onClose,
  children,
  width = 860,
  testId,
}: {
  title: string;
  icon?: ReactNode;
  sub?: ReactNode;
  /** More of the head (the step header). */
  head?: ReactNode;
  /** The button row; without it, the children draw their own ModalBody and ModalFoot. */
  footer?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  testId?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const box = ref.current;
    const first = box?.querySelector<HTMLElement>('[data-autofocus]') ?? box?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab' || !box) return;
      const items = Array.from(box.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      const a = items[0];
      const z = items[items.length - 1];
      if (e.shiftKey && document.activeElement === a) {
        e.preventDefault();
        z.focus();
      } else if (!e.shiftKey && document.activeElement === z) {
        e.preventDefault();
        a.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      before?.focus?.();
    };
  }, []);

  return createPortal(
    <div className={styles.overlay} role="presentation" onMouseDown={(e) => e.stopPropagation()}>
      <div
        ref={ref}
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{ width }}
        data-testid={testId}
      >
        <div className={styles.modalHead}>
          <div className={styles.modalTitleRow}>
            <SIcon d={icon} size={20} stroke="#2E6F40" />
            <h2 id={titleId} className={styles.modalTitle}>
              {title}
            </h2>
            <span className={styles.spacer} />
            <button type="button" className={settings.btn} onClick={onClose} aria-label="Close">
              <SIcon d={DB_ICONS.close} size={14} />
              Close
            </button>
          </div>
          {sub && <div className={styles.modalSub}>{sub}</div>}
          {head}
        </div>
        {footer ? (
          <>
            <ModalBody>{children}</ModalBody>
            <ModalFoot>{footer}</ModalFoot>
          </>
        ) : (
          children
        )}
      </div>
    </div>,
    document.body,
  );
}

/** The scrolling body of a modal (for a modal drawn without the `footer` prop). */
export function ModalBody({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div className={styles.modalBody} data-testid={testId}>
      {children}
    </div>
  );
}

/** The button row at the foot of a modal. */
export function ModalFoot({ children }: { children: ReactNode }) {
  return <div className={styles.modalFoot}>{children}</div>;
}

const STEPS = ['Where to', 'Check', 'Copy', 'Verify'] as const;

/** 1 Where to — 2 Check — 3 Copy — 4 Verify; steps before `step` get a check (all of them when `allDone`). */
export function StepHeader({ step, allDone = false }: { step: 1 | 2 | 3 | 4; allDone?: boolean }) {
  return (
    <ol className={styles.steps} aria-label="Steps">
      {STEPS.map((name, i) => {
        const n = i + 1;
        const done = n < step || allDone;
        const on = n === step && !allDone;
        return (
          <li
            key={name}
            className={`${styles.step} ${done ? styles.stepDone : ''} ${on ? styles.stepOn : ''}`}
            aria-current={on ? 'step' : undefined}
          >
            {i > 0 && <span className={styles.stepRule} aria-hidden="true" />}
            <span className={styles.stepDot}>{done ? <SIcon d={DB_ICONS.check} size={12} width={2.6} /> : n}</span>
            <span className={styles.stepName}>{name}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** Why Redis and MongoDB are not offered (design A). */
export function WhyOnlyThese({ tables }: { tables?: number | null }) {
  return (
    <div className={settings.notice} data-testid="why-only-these">
      <SIcon d={DB_ICONS.info} size={15} />
      <span>
        <b>Redis and MongoDB are not offered</b>, not even as an export target. The board is relational: projects,
        tickets, members, docs and AI runs refer to each other through {tables ? `${tables} tables` : 'many tables'}{' '}
        with foreign keys, kept in step by its migrations. A key-value or a document store would be a rewrite of the
        data layer, and it could not keep those guarantees. SQLite stays the default and needs no setup; PostgreSQL (14
        or newer) and MySQL 8 / MariaDB 10.6 or newer are for a server you already run.
      </span>
    </div>
  );
}
