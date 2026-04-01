import { useState } from 'react';
import type { WorkLogEntry } from '../types';
import styles from './WorkLogSection.module.css';

const ROLES: WorkLogEntry['role'][] = ['PM', 'Developer', 'BA', 'Tester', 'Designer', 'Other'];

const ROLE_COLORS: Record<WorkLogEntry['role'], { bg: string; color: string }> = {
  PM:        { bg: '#EDE9FE', color: '#7C3AED' },
  Developer: { bg: '#DBEAFE', color: '#2563EB' },
  BA:        { bg: '#FEF3C7', color: '#D97706' },
  Tester:    { bg: '#D1FAE5', color: '#059669' },
  Designer:  { bg: '#FCE7F3', color: '#DB2777' },
  Other:     { bg: '#F3F4F6', color: '#6B7280' },
};

interface WorkLogSectionProps {
  entries: WorkLogEntry[];
  onAdd: (entry: Omit<WorkLogEntry, 'id'>) => void;
}

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function WorkLogSection({ entries, onAdd }: WorkLogSectionProps) {
  const [author, setAuthor] = useState('');
  const [role, setRole] = useState<WorkLogEntry['role']>('Developer');
  const [note, setNote] = useState('');
  const [isExpanded, setIsExpanded] = useState(false);

  function handleAdd() {
    if (!author.trim() || !note.trim()) return;
    onAdd({ author: author.trim(), role, note: note.trim(), loggedAt: new Date().toISOString() });
    setNote('');
    setAuthor('');
  }

  return (
    <div className={styles.section}>
      <button
        type="button"
        className={styles.sectionToggle}
        onClick={() => setIsExpanded((v) => !v)}
        aria-expanded={isExpanded}
      >
        <h3 className={styles.sectionHeader}>
          {`Work Log (${entries.length})`}
        </h3>
        <span className={`${styles.chevron} ${!isExpanded ? styles.chevronCollapsed : ''}`}>▼</span>
      </button>

      {isExpanded && (
        <>
          {entries.length === 0 ? (
            <p className={styles.empty}>No work logged yet.</p>
          ) : (
            <div className={styles.entryList}>
              {[...entries].sort((a, b) => b.loggedAt.localeCompare(a.loggedAt)).map((entry) => (
                <div key={entry.id} className={styles.entry}>
                  <div className={styles.entryHeader}>
                    <span
                      className={styles.roleBadge}
                      style={{ backgroundColor: ROLE_COLORS[entry.role].bg, color: ROLE_COLORS[entry.role].color }}
                    >
                      {entry.role}
                    </span>
                    <span className={styles.author}>{entry.author}</span>
                    <span className={styles.timestamp}>{formatDateTime(entry.loggedAt)}</span>
                  </div>
                  <p className={styles.note}>{entry.note}</p>
                </div>
              ))}
            </div>
          )}

          <div className={styles.addArea}>
            <div className={styles.addRow}>
              <div className={styles.inputGroup}>
                <label htmlFor="wl-author" className={styles.srOnly}>Author</label>
                <input
                  id="wl-author"
                  className={styles.input}
                  value={author}
                  onChange={(e) => setAuthor(e.target.value)}
                  placeholder="Your name..."
                />
              </div>
              <div className={styles.inputGroup}>
                <label htmlFor="wl-role" className={styles.srOnly}>Role</label>
                <select
                  id="wl-role"
                  className={styles.select}
                  value={role}
                  onChange={(e) => setRole(e.target.value as WorkLogEntry['role'])}
                >
                  {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
            </div>
            <label htmlFor="wl-note" className={styles.srOnly}>Note</label>
            <textarea
              id="wl-note"
              className={styles.textarea}
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Describe the work done..."
            />
            <div className={styles.submitRow}>
              <button
                type="button"
                className={styles.addBtn}
                onClick={handleAdd}
                disabled={!author.trim() || !note.trim()}
              >
                Log Work
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
