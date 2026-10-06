import { useEffect, type CSSProperties, type ReactNode } from 'react';
import { Icon } from './Icon';

/** Scrim colour used by every Docs dialog in the boards (never burgundy). */
export const DOCS_SCRIM = 'rgba(37,61,44,0.5)';

const AVATARS = [
  { bg: '#E6E9F5', fg: '#5B5FA8' },
  { bg: '#DCEEE1', fg: '#2E6F40' },
  { bg: '#FBE4E9', fg: '#B0446E' },
  { bg: '#F3E7DC', fg: '#B4791E' },
];

export function initialsOf(name: string): string {
  if (name === 'agent') return 'AI';
  if (name === 'user') return 'ME';
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase())
      .join('') || '?'
  );
}

export function displayName(name: string): string {
  return name === 'agent' ? 'AI agent' : name === 'user' ? 'You' : name;
}

export function Avatar({ name, size = 18 }: { name: string; size?: number }) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const c = AVATARS[h % AVATARS.length];
  return (
    <span
      title={displayName(name)}
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: c.bg,
        color: c.fg,
        fontSize: size >= 22 ? 11 : 11,
        fontWeight: 700,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      {initialsOf(name)}
    </span>
  );
}

export function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
export function fmtDate(iso: string, year = false): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(year ? { year: 'numeric' } : {}) });
}
export function fmtTimeOnly(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

export function agoText(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days} ${days === 1 ? 'day' : 'days'} ago`;
  return fmtDate(iso);
}

export function plural(n: number, one: string, many?: string): string {
  return `${n} ${n === 1 ? one : (many ?? `${one}s`)}`;
}

export function useEscape(onEscape: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onEscape();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onEscape]);
}

export function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label="Close"
      onClick={onClick}
      style={{
        width: 28,
        height: 28,
        borderRadius: 6,
        border: 'none',
        background: 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        color: '#9AA8A0',
        flexShrink: 0,
      }}
    >
      <Icon name="i08" size={16} strokeWidth={1.8} />
    </button>
  );
}

interface ModalShellProps {
  width: number;
  ariaLabel: string;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Icon id for the round badge left of the title (omit for none). */
  icon?: string;
  iconTone?: 'green' | 'red';
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  bodyStyle?: CSSProperties;
  zIndex?: number;
  testId?: string;
}

/** Centered dialog with the board's scrim, header (icon badge, title, subtitle, close) and grey footer. */
export function ModalShell({
  width,
  ariaLabel,
  title,
  subtitle,
  icon,
  iconTone = 'green',
  onClose,
  children,
  footer,
  bodyStyle,
  zIndex = 1100,
  testId,
}: ModalShellProps) {
  useEscape(onClose);
  return (
    <div
      className="docs-root"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex,
        background: DOCS_SCRIM,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        data-testid={testId}
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'relative',
          width,
          maxWidth: '100%',
          maxHeight: 'calc(100vh - 32px)',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: 12,
          border: '1px solid #E3E8E5',
          boxShadow: '0 24px 64px rgba(30,42,34,0.28)',
          background: '#FFFFFF',
          overflow: 'hidden',
          boxSizing: 'border-box',
          color: '#1E2A22',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 12,
            padding: '16px 22px',
            borderBottom: '1px solid #E3E8E5',
            flexShrink: 0,
          }}
        >
          {icon && (
            <div
              style={{
                width: 34,
                height: 34,
                borderRadius: '50%',
                background: iconTone === 'red' ? '#FBE7E4' : '#DCEEE1',
                color: iconTone === 'red' ? '#C4432A' : '#2E6F40',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <Icon name={icon} size={16} strokeWidth={iconTone === 'red' ? 1.9 : 1.8} />
            </div>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#1E2A22' }}>{title}</div>
            {subtitle && <div style={{ fontSize: 12, color: '#5B6B60', marginTop: 2 }}>{subtitle}</div>}
          </div>
          <CloseButton onClick={onClose} />
        </div>
        <div style={{ overflowY: 'auto', minHeight: 0, ...bodyStyle }}>{children}</div>
        {footer && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '14px 22px',
              borderTop: '1px solid #E3E8E5',
              background: '#FBFCFB',
              flexShrink: 0,
            }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

export function FooterNote({ children }: { children: ReactNode }) {
  return <span style={{ fontSize: 12, color: '#5B6B60', lineHeight: 1.45 }}>{children}</span>;
}

export function Spacer() {
  return <div style={{ flex: 1 }} />;
}

/** `+12 −3` pair in mono, green / red. */
export function PlusMinus({ added, removed, size = 12 }: { added: number; removed: number; size?: number }) {
  return (
    <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: size }}>
      <span style={{ color: '#2E6F40', fontWeight: 700 }}>+{added}</span>{' '}
      <span style={{ color: '#C4432A', fontWeight: 700 }}>−{removed}</span>
    </span>
  );
}

export const blueInfoBox: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 10,
  padding: '11px 13px',
  borderRadius: 10,
  background: '#E8F1FB',
  border: '1px solid #B9D3EE',
  fontSize: 13,
  lineHeight: 1.5,
  color: '#1E2A22',
};
