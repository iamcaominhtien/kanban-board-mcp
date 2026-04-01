import { useState } from 'react';
import type { ActivityEntry } from '../types';
import styles from './ActivityLog.module.css';

interface ActivityLogProps {
  entries: ActivityEntry[];
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function ActivityLog({ entries }: ActivityLogProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={styles.section}>
      <button
        type="button"
        className={styles.header}
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className={styles.headerLabel}>Activity ({entries.length})</span>
        <span className={styles.chevron}>{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className={styles.list}>
          {entries.length === 0 ? (
            <p className={styles.empty}>No activity yet.</p>
          ) : (
            [...entries].reverse().map((entry) => (
              <div key={entry.id} className={styles.entry}>
                <span className={styles.icon}>🕐</span>
                <span className={styles.action}>{entry.action}</span>
                <span className={styles.timestamp}>{formatRelative(entry.timestamp)}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
