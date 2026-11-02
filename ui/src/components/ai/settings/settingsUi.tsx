import { useState, type ReactNode } from 'react';

/** A whole number that saves on blur / Enter, only when it changed and is at least `min`. */
export function NumberSetting({
  value,
  min,
  label,
  testId,
  width = 64,
  disabled,
  onSave,
}: {
  value: number;
  min: number;
  label: string;
  testId: string;
  width?: number;
  disabled?: boolean;
  onSave: (n: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft == null) return;
    const n = Math.round(Number(draft));
    if (draft.trim() !== '' && Number.isFinite(n) && n >= min && n !== value) onSave(n);
    setDraft(null);
  };
  return (
    <input
      className="ai-input"
      type="number"
      min={min}
      style={{ width }}
      aria-label={label}
      data-testid={testId}
      disabled={disabled}
      value={draft ?? String(value)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
    />
  );
}

/** A row of a grouped settings section (Team on its own): a rule above, title and hint left, the control right. */
export function TeamRow({
  title,
  hint,
  children,
  testId,
}: {
  title: ReactNode;
  hint?: ReactNode;
  children?: ReactNode;
  testId?: string;
}) {
  return (
    <div className="to-row" data-testid={testId}>
      <div className="to-row-main">
        <div className="to-row-title">{title}</div>
        {hint && <div className="ai-hint">{hint}</div>}
      </div>
      {children && <div className="to-row-ctl">{children}</div>}
    </div>
  );
}

/** The head of a group of settings: what the rows below decide. */
export function GroupHead({ title, hint }: { title: string; hint: ReactNode }) {
  return (
    <div className="to-group-h">
      <span className="to-h">{title}</span>
      <div className="ai-hint" style={{ marginTop: 2 }}>
        {hint}
      </div>
    </div>
  );
}

const PATHS = {
  check: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.5l3 3 5-6" />
    </>
  ),
  tick: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 7.5v.5" />
    </>
  ),
  warn: (
    <>
      <path d="M12 3.5l9.5 16.5h-19z" />
      <path d="M12 10v4.5M12 17.2v.3" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="10" rx="2" />
      <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  eye: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
  update: <path d="M20 11a8 8 0 0 0-14.5-4M4 4v4h4M4 13a8 8 0 0 0 14.5 4M20 20v-4h-4" />,
  back: <path d="M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />,
  shield: <path d="M12 3l7.5 3v5.5c0 4.5-3.2 8.2-7.5 9.5-4.3-1.3-7.5-5-7.5-9.5V6z" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
};

/** A small line icon in the settings' look. */
export function Ico({
  name,
  size = 14,
  color = 'currentColor',
}: {
  name: keyof typeof PATHS;
  size?: number;
  color?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      {PATHS[name]}
    </svg>
  );
}

/** One setting row: title and hint on the left, the control on the right (the same row as {@link TeamRow}). */
export function SettingRow({ title, hint, children }: { title: string; hint?: ReactNode; children?: ReactNode }) {
  return (
    <TeamRow title={title} hint={hint}>
      {children}
    </TeamRow>
  );
}
