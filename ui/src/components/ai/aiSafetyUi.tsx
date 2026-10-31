import type { CSSProperties, ReactNode } from 'react';
import './aiSafety.css';

/** Small shared pieces of the safety and cost screens: risk and result chips, countdowns, segmented pickers. */

export const RISK: Record<string, { bg: string; color: string; label: string }> = {
  low: { bg: '#F1F8F3', color: '#2E6F40', label: 'Low risk' },
  medium: { bg: '#FDF5E6', color: '#8A5A12', label: 'Medium risk' },
  high: { bg: '#FBEEEA', color: '#C4432A', label: 'High risk' },
};

export const RESULT_STYLE: Record<string, { bg: string; color: string; label: string }> = {
  allowed: { bg: '#F1F8F3', color: '#2E6F40', label: 'Allowed' },
  approved: { bg: '#E5F2E9', color: '#2E6F40', label: 'Approved' },
  needs_approval: { bg: '#FDF5E6', color: '#8A5A12', label: 'Needs approval' },
  denied: { bg: '#FBEEEA', color: '#C4432A', label: 'Denied' },
  blocked: { bg: '#FBEEEA', color: '#C4432A', label: 'Blocked' },
  reverted: { bg: '#EEF2F6', color: '#34455A', label: 'Reverted' },
  info: { bg: '#EEF1EE', color: '#5B6B60', label: 'Event' },
};

export const ACTION_LABEL: Record<string, string> = {
  read: 'Read tickets',
  change_status: 'Change status',
  edit_fields: 'Edit fields',
  change_assignee: 'Change assignee',
  create_tickets: 'Create tickets',
  delete_tickets: 'Delete tickets',
  edit_docs: 'Edit docs',
  delete_docs: 'Delete docs',
  comment: 'Comment',
  manage_test_cases: 'Test cases',
  create_branches: 'Branches',
  manage_project: 'Manage project',
  raise_cap: 'Raise cap',
  run_queued: 'Run queued',
  run_finished: 'Run finished',
  run_failed: 'Run failed',
  run_cancelled: 'Run cancelled',
  run_timed_out: 'Run timed out',
  ask_person: 'Asked a person',
  member_created: 'AI member added',
  member_updated: 'Settings changed',
  member_paused: 'Paused',
  member_resumed: 'Resumed',
  member_removed: 'Removed',
  kill_switch: 'Pause all AI',
  resume_all: 'Resume AI',
  auto_trip: 'Auto-paused',
  run_restarted: 'Run restarted',
  run_stopped_memory: 'Run stopped: memory',
  run_control: 'Run control approved',
  run_stop_dismissed: 'Memory stop dismissed',
  mention: 'Mention',
  settings_updated: 'Project AI settings',
  autopilot_decision: 'Autopilot decided',
  autopilot_changed: 'Autopilot settings',
  token_revoked: 'Token revoked',
  token_reconnected: 'Token reconnected',
  injection_detected: 'Flagged text read',
  grant_revoked: 'Remembered approval revoked',
  access_requested: 'Access requested',
  workspace_defaults_updated: 'Workspace defaults',
  extra_runs_allowed: 'More runs allowed',
};

export const MODE_LABEL: Record<string, string> = {
  allowed: 'Allowed',
  approval: 'Needs approval',
  blocked: 'Blocked',
};

/** "23h 58m" until an ISO time, "expired" when it has passed. */
export function expiresIn(iso: string | null | undefined): string {
  if (!iso) return '';
  const s = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  if (s <= 0) return 'expired';
  if (s >= 3 * 86400) return `${Math.floor(s / 86400)} days`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

/** "Oct 21 15:02". */
export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** "$1.84" with a dash for nothing. */
export function usd(v: number | null | undefined, digits = 2): string {
  return v == null ? '—' : `$${v.toFixed(digits)}`;
}

/** "3.4M", "133k", "950". */
export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/** Show a value that may be a person id, text or list as one short line. */
export function shown(v: unknown): string {
  if (v == null || v === '') return '—';
  if (Array.isArray(v)) return v.join(', ') || '—';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** camelCase key back to the snake_case the API and the AI used (the client converts response keys). */
export function snake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/** Round chip. */
export function Pill({
  children,
  bg = '#EEF1EE',
  color = '#5B6B60',
  title,
  style,
}: {
  children: ReactNode;
  bg?: string;
  color?: string;
  title?: string;
  style?: CSSProperties;
}) {
  return (
    <span className="ai-chip" title={title} style={{ background: bg, color, ...style }}>
      {children}
    </span>
  );
}

/** Risk chip. */
export function RiskChip({ risk }: { risk: string }) {
  const r = RISK[risk] ?? RISK.medium;
  return (
    <Pill bg={r.bg} color={r.color}>
      {r.label}
    </Pill>
  );
}

/** Trust label of a text source (F1). */
export function TrustChip({ trust }: { trust: 'trusted' | 'data_only' | 'untrusted' | null | undefined }) {
  if (!trust) return null;
  const s =
    trust === 'trusted'
      ? { bg: '#F1F8F3', color: '#2E6F40', label: '✓ Trusted' }
      : trust === 'data_only'
        ? { bg: '#EEF1EE', color: '#5B6B60', label: 'Data only' }
        : { bg: '#FDF5E6', color: '#8A5A12', label: 'Untrusted' };
  return (
    <Pill bg={s.bg} color={s.color}>
      {s.label}
    </Pill>
  );
}

/** Result chip of an audit entry. */
export function ResultChip({ result, reverted }: { result: string; reverted?: boolean }) {
  const r = RESULT_STYLE[reverted ? 'reverted' : result] ?? RESULT_STYLE.info;
  return (
    <Pill bg={r.bg} color={r.color}>
      {r.label}
    </Pill>
  );
}

/** Row of toggle chips (single choice). */
export function ChipChoice<T extends string | number>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="ai-chips">
      {options.map(([v, label]) => (
        <button
          key={String(v)}
          type="button"
          disabled={disabled}
          className={`ai-choice ${value === v ? 'ai-choice-on' : ''}`}
          onClick={() => onChange(v)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** Radio row with a title and a hint. */
export function RadioRow({
  on,
  onClick,
  title,
  hint,
  disabled,
}: {
  on: boolean;
  onClick: () => void;
  title: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button type="button" disabled={disabled} className={`ai-option ${on ? 'ai-option-active' : ''}`} onClick={onClick}>
      <span className={`ai-radio ${on ? 'ai-radio-on' : ''}`} />
      <span style={{ textAlign: 'left' }}>
        <b style={{ fontSize: 13 }}>{title}</b>
        {hint && <div className="ai-muted">{hint}</div>}
      </span>
    </button>
  );
}

/** A titled card with an optional right-hand slot. */
export function SafetyCard({
  title,
  sub,
  right,
  children,
  id,
}: {
  title: ReactNode;
  sub?: ReactNode;
  right?: ReactNode;
  children?: ReactNode;
  id?: string;
}) {
  return (
    <div className="ai-card" style={{ padding: 16 }} id={id}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 10 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700 }}>{title}</div>
          {sub && <div className="ai-hint">{sub}</div>}
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}
