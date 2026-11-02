import { useState, type ReactNode } from 'react';

/** One setting row: title and hint on the left, the control on the right. */
export function SettingRow({ title, hint, children }: { title: string; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{title}</div>
        {hint && <div className="ai-hint">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

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
