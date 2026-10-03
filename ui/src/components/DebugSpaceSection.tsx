import { useState, useRef, useEffect } from 'react';
import type { WorkLogEntry, DebugEntryKind, DebugAttachment } from '../types';
import { MarkdownRenderer } from './MarkdownRenderer';
import styles from './DebugSpaceSection.module.css';

interface DebugSpaceSectionProps {
  ticketId?: string;
  entries: WorkLogEntry[];
  onAdd: (entry: Omit<WorkLogEntry, 'id'>) => Promise<void> | void;
  onUpdate?: (entryId: string, data: Partial<WorkLogEntry>) => void;
  onDelete?: (entryId: string) => void;
  readOnly?: boolean;
  disabled?: boolean;
}

const KINDS: DebugEntryKind[] = [
  'investigation',
  'fix_attempt',
  'root_cause',
  'blocked',
  'resolved',
];

const KIND_CONFIG: Record<
  DebugEntryKind,
  { label: string; dot: string; color: string; bg: string }
> = {
  investigation: {
    label: 'Investigation',
    dot: '#2F6FB0',
    color: '#2F6FB0',
    bg: 'rgba(47,111,176,0.12)',
  },
  fix_attempt: {
    label: 'Fix attempt',
    dot: '#E2793D',
    color: '#B4571F',
    bg: 'rgba(226,121,61,0.14)',
  },
  root_cause: {
    label: 'Root cause',
    dot: '#6D5DD3',
    color: '#6D5DD3',
    bg: 'rgba(109,93,211,0.12)',
  },
  blocked: {
    label: 'Blocked',
    dot: '#C4432A',
    color: '#C4432A',
    bg: 'rgba(196,67,42,0.12)',
  },
  resolved: {
    label: 'Resolved',
    dot: '#2E6F40',
    color: '#2E6F40',
    bg: 'rgba(46,111,64,0.12)',
  },
};

const ROLES = ['Developer', 'Tester', 'BA', 'PM', 'Designer', 'Other'];

const ROLE_CONFIG: Record<string, { bg: string; color: string }> = {
  Developer: { bg: '#DBEAFE', color: '#2563EB' },
  Tester: { bg: '#D1FAE5', color: '#059669' },
  BA: { bg: '#FEF3C7', color: '#D97706' },
  PM: { bg: '#EDE9FE', color: '#7C3AED' },
  Designer: { bg: '#FCE7F3', color: '#DB2777' },
  Other: { bg: '#F3F4F6', color: '#6B7280' },
};

function formatTimeAgo(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffSec = Math.floor((now.getTime() - date.getTime()) / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay}d ago`;
}

function getInitials(name?: string | null): string {
  if (!name || !name.trim()) return 'DL';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function DebugSpaceSection({
  ticketId = 'KAN',
  entries,
  onAdd,
  onUpdate,
  onDelete,
  readOnly = false,
  disabled = false,
}: DebugSpaceSectionProps) {
  const [activeFilter, setActiveFilter] = useState<'all' | DebugEntryKind>('all');
  const [showAddForm, setShowAddForm] = useState(false);
  const [authorDraft, setAuthorDraft] = useState('');
  const [roleDraft, setRoleDraft] = useState('Developer');
  const [kindDraft, setKindDraft] = useState<DebugEntryKind>('investigation');
  const [noteDraft, setNoteDraft] = useState('');
  const [linkedBranchDraft, setLinkedBranchDraft] = useState('');
  const [linkedTestCaseDraft, setLinkedTestCaseDraft] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const noteInputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (showAddForm) {
      noteInputRef.current?.focus();
    }
  }, [showAddForm]);

  // Counts
  const counts: Record<DebugEntryKind, number> = {
    investigation: 0,
    fix_attempt: 0,
    root_cause: 0,
    blocked: 0,
    resolved: 0,
  };

  entries.forEach((e) => {
    const k = e.kind || 'investigation';
    if (counts[k] !== undefined) {
      counts[k]++;
    }
  });

  const pinnedEntries = entries.filter((e) => e.pinned);

  const filteredEntries = [...entries]
    .filter((e) => activeFilter === 'all' || (e.kind || 'investigation') === activeFilter)
    .sort((a, b) => {
      const timeB = b.at ?? (b as any).date ?? (b as any).createdAt ?? '';
      const timeA = a.at ?? (a as any).date ?? (a as any).createdAt ?? '';
      return String(timeB).localeCompare(String(timeA));
    });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!authorDraft.trim() || !noteDraft.trim()) return;
    setIsSubmitting(true);
    try {
      await onAdd({
        author: authorDraft.trim(),
        role: roleDraft,
        kind: kindDraft,
        note: noteDraft.trim(),
        linkedBranch: linkedBranchDraft.trim() || null,
        linkedTestCase: linkedTestCaseDraft.trim() || null,
        at: new Date().toISOString(),
        pinned: false,
      });
      setNoteDraft('');
      setLinkedBranchDraft('');
      setLinkedTestCaseDraft('');
      setShowAddForm(false);
    } finally {
      setIsSubmitting(false);
    }
  }

  function togglePin(entry: WorkLogEntry) {
    if (!onUpdate) return;
    onUpdate(entry.id, { pinned: !entry.pinned });
  }

  return (
    <div className={styles.container}>
      {/* Top Bar: Count & Add Button */}
      <div className={styles.topBar}>
        <span className={styles.tcLabel}>
          {entries.length} ENTRIES · {ticketId}
        </span>
        {!readOnly && (
          <button
            type="button"
            className={styles.tcAddBtn}
            onClick={() => setShowAddForm(true)}
            disabled={disabled || showAddForm}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <path d="M12 5V19" /><path d="M5 12H19" />
            </svg>
            Log entry
          </button>
        )}
      </div>

      {/* Filter Chips */}
      <div className={styles.filterRow}>
        <button
          type="button"
          className={`${styles.filterChip} ${activeFilter === 'all' ? styles.filterChipActive : ''}`}
          onClick={() => setActiveFilter('all')}
        >
          All ({entries.length})
        </button>
        {KINDS.map((kind) => {
          const cfg = KIND_CONFIG[kind];
          return (
            <button
              key={kind}
              type="button"
              className={`${styles.filterChip} ${activeFilter === kind ? styles.filterChipActive : ''}`}
              onClick={() => setActiveFilter(kind)}
            >
              <span className={styles.filterDot} style={{ background: cfg.dot }} />
              {cfg.label} ({counts[kind]})
            </button>
          );
        })}
      </div>

      {/* Pinned Entries Strip */}
      {pinnedEntries.length > 0 && (
        <div className={styles.pinnedSection}>
          <span className={styles.fieldLabel}>Pinned</span>
          {pinnedEntries.map((pe) => {
            const k = pe.kind || 'root_cause';
            const cfg = KIND_CONFIG[k];
            return (
              <div key={pe.id} className={styles.dbgPinRow}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="#C7A339" style={{ flexShrink: 0 }}>
                  <path d="M12 2L14.4 8.6L21.5 9.2L16 13.8L17.8 20.8L12 16.8L6.2 20.8L8 13.8L2.5 9.2L9.6 8.6Z" />
                </svg>
                <span
                  className={styles.dbgKindBadge}
                  style={{ background: cfg.bg, color: cfg.color }}
                >
                  {cfg.label}
                </span>
                <span className={styles.pinText}>{pe.note.replace(/[#*`\n]/g, ' ')}</span>
                <span className={styles.pinMeta}>
                  {pe.author} · {formatTimeAgo(pe.at)}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Inline Form (Log Entry) */}
      {showAddForm && (
        <form className={styles.inlineForm} onSubmit={handleSubmit}>
          {/* Kind Selector Badges */}
          <div className={styles.kindPicker}>
            {KINDS.map((k) => {
              const cfg = KIND_CONFIG[k];
              const isSelected = kindDraft === k;
              return (
                <button
                  key={k}
                  type="button"
                  className={`${styles.kindOption} ${isSelected ? styles.kindOptionSelected : ''}`}
                  style={{
                    background: isSelected ? cfg.bg : '#F6FAF7',
                    color: isSelected ? cfg.color : '#9AA8A0',
                    borderColor: isSelected ? cfg.color : '#E3E8E5',
                  }}
                  onClick={() => setKindDraft(k)}
                >
                  {cfg.label}
                </button>
              );
            })}
          </div>

          {/* Author & Role */}
          <div className={styles.authorRow}>
            <input
              className={styles.authorInput}
              value={authorDraft}
              onChange={(e) => setAuthorDraft(e.target.value)}
              placeholder="Your name…"
              required
            />
            <select
              className={styles.roleSelect}
              value={roleDraft}
              onChange={(e) => setRoleDraft(e.target.value)}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>

          {/* Note Input Box */}
          <div className={styles.noteInputBox}>
            <textarea
              ref={noteInputRef}
              className={styles.noteTextarea}
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              placeholder="Write what you found, tried, or ran into… (Markdown supported)"
              required
            />
          </div>

          {/* Optional Links */}
          <div className={styles.extraLinksRow}>
            <input
              className={styles.smallInput}
              value={linkedBranchDraft}
              onChange={(e) => setLinkedBranchDraft(e.target.value)}
              placeholder="Link branch (e.g. fix/storage)"
            />
            <input
              className={styles.smallInput}
              value={linkedTestCaseDraft}
              onChange={(e) => setLinkedTestCaseDraft(e.target.value)}
              placeholder="Link TC (e.g. TC-1)"
            />
          </div>

          {/* Actions */}
          <div className={styles.formActions}>
            <button
              type="button"
              className={styles.btnCancel}
              onClick={() => setShowAddForm(false)}
            >
              Cancel
            </button>
            <button
              type="submit"
              className={styles.btnSubmit}
              disabled={isSubmitting || !authorDraft.trim() || !noteDraft.trim()}
            >
              {isSubmitting ? 'Logging…' : 'Log entry'}
            </button>
          </div>
        </form>
      )}

      {/* Timeline List */}
      <div className={styles.timeline}>
        {filteredEntries.length === 0 ? (
          <div className={styles.emptyMsg}>No entries in this view.</div>
        ) : (
          filteredEntries.map((entry, idx) => {
            const kind = entry.kind || 'investigation';
            const cfg = KIND_CONFIG[kind];
            const roleCfg = ROLE_CONFIG[entry.role] || ROLE_CONFIG.Other;
            const isLast = idx === filteredEntries.length - 1;

            return (
              <div key={entry.id} className={styles.dbgItem}>
                {/* Vertical Rail with Dot */}
                <div className={styles.dbgRail}>
                  <span className={styles.dbgDot} style={{ background: cfg.dot }} />
                  {!isLast && <span className={styles.dbgLine} />}
                </div>

                {/* Card */}
                <div className={styles.dbgCard}>
                  <div className={styles.cardHeader}>
                    <span
                      className={styles.dbgKindBadge}
                      style={{ background: cfg.bg, color: cfg.color }}
                    >
                      {cfg.label}
                    </span>
                    <div
                      className={styles.dbgAvatar}
                      style={{ background: roleCfg.bg, color: roleCfg.color }}
                    >
                      {getInitials(entry.author || (entry as any).author_name)}
                    </div>
                    <span className={styles.authorName}>{entry.author || (entry as any).author_name || 'Developer'}</span>
                    <span
                      className={styles.dbgRoleBadge}
                      style={{ background: roleCfg.bg, color: roleCfg.color }}
                    >
                      {entry.role}
                    </span>
                    <span style={{ flexGrow: 1 }} />
                    <span className={styles.timestamp}>{formatTimeAgo(entry.at)}</span>

                    {/* Pin Button */}
                    {!readOnly && (
                      <button
                        type="button"
                        className={`${styles.dbgPinBtn} ${entry.pinned ? styles.dbgPinBtnPinned : ''}`}
                        onClick={() => togglePin(entry)}
                        title={entry.pinned ? 'Unpin entry' : 'Pin entry'}
                        aria-label={entry.pinned ? 'Unpin entry' : 'Pin entry'}
                      >
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 24 24"
                          fill={entry.pinned ? 'currentColor' : 'none'}
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M12 2L14.4 8.6L21.5 9.2L16 13.8L17.8 20.8L12 16.8L6.2 20.8L8 13.8L2.5 9.2L9.6 8.6Z" />
                        </svg>
                      </button>
                    )}

                    {/* Delete Button */}
                    {!readOnly && onDelete && (
                      <button
                        type="button"
                        className={styles.deleteBtn}
                        onClick={() => onDelete(entry.id)}
                        title="Delete entry"
                        aria-label="Delete entry"
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                          <path d="M18 6L6 18" /><path d="M6 6L18 18" />
                        </svg>
                      </button>
                    )}
                  </div>

                  {/* Note Body */}
                  <div className={styles.tcMd}>
                    <MarkdownRenderer>{entry.note}</MarkdownRenderer>
                  </div>

                  {/* Chips: Linked Branch, Linked TC, Attachments */}
                  {(entry.linkedBranch || entry.linkedTestCase || (entry.attachments?.length ?? 0) > 0) && (
                    <div className={styles.chipsRow}>
                      {entry.linkedBranch && (
                        <span className={styles.dbgLinkChip}>
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#5B6B60" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M6 3V21" /><path d="M18 3V21" />
                            <circle cx="6" cy="6" r="2.6" /><circle cx="18" cy="6" r="2.6" /><circle cx="6" cy="18" r="2.6" />
                            <path d="M6 8.6C6 14 10 16.5 15.4 17.3" />
                          </svg>
                          {entry.linkedBranch}
                        </span>
                      )}
                      {entry.linkedTestCase && (
                        <span className={styles.dbgLinkChip}>
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#5B6B60" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M9 11L12 14L22 4" />
                            <path d="M21 12V19A2 2 0 0 1 19 21H5A2 2 0 0 1 3 19V5A2 2 0 0 1 5 3H16" />
                          </svg>
                          {entry.linkedTestCase}
                        </span>
                      )}
                      {(entry.attachments ?? []).map((att: DebugAttachment) => (
                        <div key={att.id} className={styles.tcFileChip}>
                          <div className={styles.tcFileIcon} style={{ background: '#F1F1F1' }}>
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#5B6B60" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M14 3H7C5.9 3 5 3.9 5 5V19C5 20.1 5.9 21 7 21H17C18.1 21 19 20.1 19 19V8L14 3Z" />
                              <path d="M14 3V8H19" />
                            </svg>
                          </div>
                          <span style={{ fontSize: 11, fontWeight: 600, color: '#1E2A22' }}>{att.name}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
