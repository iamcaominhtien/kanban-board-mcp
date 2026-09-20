import { useState } from 'react';
import type { WorkLogEntry } from '../types';
import { uploadDescriptionImage } from '../api/tickets';
import { MarkdownEditor } from './MarkdownEditor';
import { MarkdownRenderer } from './MarkdownRenderer';
import styles from './WorkLogSection.module.css';

// TODO(backend): the design calls for this to become a typed "Debug Space" timeline
// (kind: investigation/fix-attempt/root-cause/blocked/resolved, pinning, cross-links to
// Branches/Test Cases) — see design/ mockups (DebugSpace.dc.html). Not implemented; this
// restyle only updates the visual language of the existing free-text Work Log using
// current data.

const ROLES: WorkLogEntry['role'][] = ['PM', 'Developer', 'BA', 'Tester', 'Designer', 'Other'];

const ROLE_COLORS: Record<WorkLogEntry['role'], string> = {
  PM:        'var(--color-purple)',
  Developer: 'var(--color-blue)',
  BA:        'var(--color-orange)',
  Tester:    'var(--color-lime)',
  Designer:  'var(--color-pink)',
  Other:     'var(--color-text-secondary)',
};

function roleBadgeStyle(role: WorkLogEntry['role']): { backgroundColor: string; color: string } {
  const color = ROLE_COLORS[role];
  return { backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)`, color };
}

interface WorkLogSectionProps {
  entries: WorkLogEntry[];
  onAdd: (entry: Omit<WorkLogEntry, 'id'>) => void;
}

export function WorkLogSection({ entries, onAdd }: WorkLogSectionProps) {
  const [author, setAuthor] = useState('');
  const [role, setRole] = useState<WorkLogEntry['role']>('Developer');
  const [note, setNote] = useState('');
  const [isExpanded, setIsExpanded] = useState(false);

  function handleAdd() {
    if (!author.trim() || !note.trim()) return;
    onAdd({ author: author.trim(), role, note: note.trim(), at: new Date().toISOString() });
    setNote('');
    setAuthor('');
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

  return (
    <div className={styles.section}>
      <button
        type="button"
        className={styles.sectionToggle}
        onClick={() => setIsExpanded((v) => !v)}
        aria-expanded={isExpanded}
      >
        <span className={styles.sectionHeader}>
          {'Work Log (' + entries.length + ')'}
        </span>
        <span className={styles.chevron + ' ' + (!isExpanded ? styles.chevronCollapsed : '')}>▼</span>
      </button>

      {isExpanded && (
        <>
          {entries.length === 0 ? (
            <p className={styles.empty}>No work logged yet.</p>
          ) : (
            <div className={styles.entryList}>
              {[...entries].sort((a, b) => b.at.localeCompare(a.at)).map((entry) => (
                <div key={entry.id} className={styles.entry}>
                  <div className={styles.entryHeader}>
                    <span
                      className={styles.roleBadge}
                      style={roleBadgeStyle(entry.role)}
                    >
                      {entry.role}
                    </span>
                    <span className={styles.author}>{entry.author}</span>
                    <span className={styles.timestamp}>{formatDateTime(entry.at)}</span>
                  </div>
                  <div className={styles.note}>
                    <MarkdownRenderer>{entry.note}</MarkdownRenderer>
                  </div>
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
            <MarkdownEditor
              value={note}
              onChange={setNote}
              onBlur={setNote}
              onUploadImage={async (file) => {
                const result = await uploadDescriptionImage(file);
                return { markdown: result.markdown };
              }}
              onUploadComplete={setNote}
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
