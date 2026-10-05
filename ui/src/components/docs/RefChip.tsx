import type { DocsRefResult } from '../../types/docs';
import styles from './RefChip.module.css';

const STATUS_COLORS: Record<string, string> = {
  backlog: 'var(--color-backlog)',
  todo: 'var(--color-todo)',
  'in-progress': 'var(--color-inprogress)',
  review: 'var(--color-review)',
  testing: 'var(--color-testing)',
  done: 'var(--color-done)',
  wont_do: 'var(--color-wontdo)',
};

interface Props {
  kind: 'page' | 'ticket';
  label: string;
  result?: DocsRefResult;
  onOpenPage?: (pageId: string, anchor?: string | null) => void;
  onOpenTicket?: (ticketId: string) => void;
}

/** A rendered [[page]] or ticket-key reference. Broken references stay readable and say why. */
export function RefChip({ kind, label, result, onOpenPage, onOpenTicket }: Props) {
  if (kind === 'ticket') {
    if (result && result.status !== 'ok') return <>{label}</>;
    const dot = STATUS_COLORS[result?.ticketStatus ?? ''] ?? 'var(--color-backlog)';
    return (
      <button
        type="button"
        className={`${styles.chip} ${styles.ticket}`}
        title={result?.title ? `${result.key} · ${result.title}` : label}
        onClick={() => onOpenTicket?.(label)}
      >
        <span className={styles.dot} style={{ background: dot }} aria-hidden="true" />
        {label}
      </button>
    );
  }

  const status = result?.status ?? 'ok';
  if (status === 'missing' || status === 'in_bin') {
    return (
      <span
        className={`${styles.chip} ${styles.broken}`}
        title={status === 'in_bin' ? 'This page is in the Recycle Bin' : 'No page with this title yet'}
      >
        {label}
        <span className={styles.note}>{status === 'in_bin' ? 'In Recycle Bin' : 'Missing page'}</span>
      </span>
    );
  }
  const warn = status === 'section_missing' || status === 'ambiguous';
  return (
    <button
      type="button"
      className={`${styles.chip} ${styles.page} ${warn ? styles.warn : ''}`}
      title={
        status === 'section_missing'
          ? `The page exists, but has no section “${result?.anchor ?? ''}”`
          : status === 'ambiguous'
            ? 'Several pages share this title; showing the shallowest'
            : result?.path
      }
      onClick={() => result?.pageId && onOpenPage?.(result.pageId, status === 'ok' ? result.anchor : null)}
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
        <path d="M14 3v5h5" />
      </svg>
      {label}
      {status === 'section_missing' && <span className={styles.note}>Section missing</span>}
    </button>
  );
}
