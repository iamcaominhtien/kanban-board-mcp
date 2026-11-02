import type { ReactNode } from 'react';
import styles from './SettingsPage.module.css';

/**
 * The building blocks every Settings page is drawn with (design/screens/settings-structure.md B,
 * settings-pages.md F and G): a section card with its title, one line on what it does and a status
 * on the right; a setting row with a switch; a labelled field; and the line icons of the list.
 */

/** A 24px-grid line icon, drawn like the design's (stroke 1.7, round caps). */
export function SIcon({
  d,
  size = 16,
  stroke = 'currentColor',
  width = 1.7,
}: {
  d: ReactNode;
  size?: number;
  stroke?: string;
  width?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={stroke}
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      {d}
    </svg>
  );
}

/** The icon paths of the design, by name. */
export const ICONS = {
  back: <path d="M19 12H5M11 6l-6 6 6 6" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </>
  ),
  chevronDown: <path d="M6 9l6 6 6-6" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  checkCircle: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.5l3 3 5-6" />
    </>
  ),
  alert: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5M12 16.5v.01" />
    </>
  ),
  repositories: (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="9" r="2.5" />
      <path d="M6 8.5v7M18 11.5c0 4-6 3-12 4.5" />
    </>
  ),
  docs: <path d="M5 4h10a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h10" />,
  ai: <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />,
  assistant: <path d="M21 12a8 8 0 0 1-11.5 7.2L4 20.5l1.4-4.6A8 8 0 1 1 21 12z" />,
  ideas: (
    <>
      <path d="M9 18h6M10 21h4" />
      <path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V16h5v-.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z" />
    </>
  ),
  appearance: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="8.5" cy="10" r="1.2" />
      <circle cx="12" cy="7.5" r="1.2" />
      <circle cx="15.5" cy="10" r="1.2" />
      <path d="M12 21c-1.5 0-2-1.5-1-3 .8-1.2 2-1.5 3-1.5h2.5a3 3 0 0 0 3-3" />
    </>
  ),
  notifications: <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0" />,
  storage: (
    <>
      <ellipse cx="12" cy="6" rx="8" ry="3" />
      <path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
    </>
  ),
  integrations: <path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4" />,
  updates: <path d="M20 11a8 8 0 0 0-14.5-4M4 4v4h4M4 13a8 8 0 0 0 14.5 4M20 20v-4h-4" />,
  diagnostics: (
    <>
      <path d="M6 3v6a4 4 0 0 0 8 0V3M10 13v2a5 5 0 0 0 10 0v-1" />
      <circle cx="20" cy="12" r="2" />
    </>
  ),
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  download: <path d="M12 4v11M7 11l5 5 5-5M5 20h14" />,
  upload: <path d="M12 16V5M7 9l5-5 5 5M5 20h14" />,
  external: <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  trash: <path d="M4 7h16M9 7V4h6v3M6.5 7l1 13h9l1-13M10 11v6M14 11v6" />,
} as const;

export type IconName = keyof typeof ICONS;

/** "Saved" with a check, or the error, beside a section's title (G: SAVED / ERROR). */
export function SaveNote({ status }: { status: { ok: boolean; text: string } | null | undefined }) {
  if (!status) return null;
  return (
    <span className={status.ok ? styles.saved : styles.saveErr} role="status">
      <SIcon d={status.ok ? ICONS.checkCircle : ICONS.alert} size={13} width={2.2} />
      {status.text}
    </span>
  );
}

/**
 * One section of a page: a card with its title, one line on what it does, and a status on the right.
 * The title also goes in the page's "On this page" list.
 */
export function SettingsCard({
  title,
  hint,
  status,
  aside,
  setting,
  toc = true,
  children,
  testId,
}: {
  title: ReactNode;
  hint?: ReactNode;
  status?: { ok: boolean; text: string } | null;
  /** Anything else for the right of the title row (a chip, a switch). */
  aside?: ReactNode;
  /** `data-setting` anchor search results and links jump to. */
  setting?: string;
  /** Listed in "On this page" (default) — off for a card that is not a section of its own. */
  toc?: boolean;
  children?: ReactNode;
  testId?: string;
}) {
  const label = typeof title === 'string' ? title : undefined;
  return (
    <section className={styles.card} data-setting={setting} data-toc={toc ? label : undefined} data-testid={testId}>
      <div className={styles.cardHead}>
        <div className={styles.cardHeadText}>
          <h2 className={styles.cardTitle}>{title}</h2>
          {hint && <div className={styles.cardHint}>{hint}</div>}
        </div>
        {aside}
        <SaveNote status={status} />
      </div>
      {children}
    </section>
  );
}

/** An on/off switch (34 × 19, as drawn). */
export function Switch({
  on,
  onChange,
  label,
  disabled,
  testId,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  label: string;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      data-testid={testId}
      className={`${styles.switch} ${on ? styles.switchOn : ''}`}
      onClick={() => onChange(!on)}
    >
      <i />
    </button>
  );
}

/** A setting with a name and one line, and its control on the right (a switch, a select). */
export function SettingRow({
  title,
  hint,
  children,
  setting,
}: {
  title: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  setting?: string;
}) {
  return (
    <div className={styles.settingRow} data-setting={setting}>
      <div className={styles.settingRowText}>
        <div className={styles.settingName}>{title}</div>
        {hint && <div className={styles.hint}>{hint}</div>}
      </div>
      <div className={styles.settingControl}>{children}</div>
    </div>
  );
}

/** A labelled field: the label, the control, and a hint under it. */
export function Field({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className={styles.field}>
      <label className={styles.fieldLab} htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && <span className={styles.hint}>{hint}</span>}
    </div>
  );
}

/** Pill options, one of which is chosen (retention, approvals expiry, log range). */
export function Pills<T extends string | number>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly (readonly [T, string])[];
  value: T | null;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className={styles.pills} role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <button
          key={String(v)}
          type="button"
          role="radio"
          aria-checked={value === v}
          className={`${styles.pill} ${value === v ? styles.pillOn : ''}`}
          onClick={() => onChange(v)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}
