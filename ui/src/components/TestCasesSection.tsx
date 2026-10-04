import { useState, useRef, useEffect } from 'react';
import type { TestCase, TestCaseStatus, TestCaseFileData } from '../types';
import { uploadAttachment, uploadUrl } from '../api/tickets';
import { extractError } from '../api/extractError';
import styles from './TestCasesSection.module.css';

interface ChildTestCaseSource {
  ticketId: string;
  ticketTitle: string;
  testCases: TestCase[];
}

interface TestCasesSectionProps {
  ticketId?: string;
  testCases: TestCase[];
  onChange: (updated: TestCase[]) => void;
  onAdd?: (title: string) => Promise<void>;
  readOnly?: boolean;
  disabled?: boolean;
  childTestCaseSources?: ChildTestCaseSource[];
}

const STATUS_CYCLE: Record<TestCaseStatus, TestCaseStatus> = {
  pending: 'running',
  running: 'pass',
  pass: 'fail',
  fail: 'pending',
};

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTimeAgo(isoString?: string | null): string {
  if (!isoString) return '';
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
  if (!name) return 'QA';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function TestCaseRowItem({
  tc,
  index,
  onUpdate,
  onDelete,
  readOnly,
  disabled,
}: {
  tc: TestCase;
  index: number;
  onUpdate: (updated: TestCase) => void;
  onDelete: () => void;
  readOnly: boolean;
  disabled?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(tc.title);

  // Edit sub-fields
  const [editingField, setEditingField] = useState<'desc' | 'exp' | 'notes' | null>(null);
  const [fileBusy, setFileBusy] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function attachFiles(files: FileList | null) {
    if (!files?.length) return;
    setFileBusy(true);
    setFileError(null);
    try {
      const uploaded: TestCaseFileData[] = [];
      for (const file of Array.from(files)) uploaded.push(await uploadAttachment(file));
      onUpdate({
        ...tc,
        testDataFiles: [...(tc.testDataFiles || []), ...uploaded],
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      setFileError(extractError(err));
    } finally {
      setFileBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  const codeDisplay = tc.code || `TC-${index + 1}`;

  function cycleStatus() {
    if (readOnly || disabled) return;
    const nextStatus = STATUS_CYCLE[tc.status];
    const updates: Partial<TestCase> = { status: nextStatus };
    if (nextStatus === 'running' && !tc.startedAt) {
      updates.startedAt = new Date().toISOString();
    }
    updates.updatedAt = new Date().toISOString();
    onUpdate({ ...tc, ...updates });
  }

  function commitTitle() {
    setIsEditingTitle(false);
    if (titleDraft.trim() && titleDraft.trim() !== tc.title) {
      onUpdate({ ...tc, title: titleDraft.trim(), updatedAt: new Date().toISOString() });
    } else {
      setTitleDraft(tc.title);
    }
  }

  return (
    <div className={styles.rowItem}>
      <div className={`${styles.tcRow} ${expanded ? styles.tcRowExpanded : ''}`}>
        {/* Status Icon */}
        <button
          type="button"
          className={styles.tcStatusIc}
          onClick={cycleStatus}
          disabled={readOnly || disabled}
          aria-label={`Status: ${tc.status}. Click to cycle.`}
          title={`Status: ${tc.status}. Click to cycle.`}
        >
          {tc.status === 'pass' && (
            <svg width="15" height="15" viewBox="0 0 14 14" fill="none">
              <circle cx="7" cy="7" r="6" stroke="#2E6F40" strokeWidth="1.6" />
              <path d="M4.3 7.2L6.1 9L9.8 5" stroke="#2E6F40" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
          {tc.status === 'fail' && (
            <svg width="15" height="15" viewBox="0 0 14 14" fill="none">
              <circle cx="7" cy="7" r="6" stroke="#C4432A" strokeWidth="1.6" />
              <path d="M5 5L9 9M9 5L5 9" stroke="#C4432A" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          )}
          {tc.status === 'running' && (
            <span className={`${styles.tcStatusDot} ${styles.tcStatusDotRunning}`} />
          )}
          {tc.status === 'pending' && (
            <span className={`${styles.tcStatusDot} ${styles.tcStatusDotPending}`} />
          )}
        </button>

        {/* Code mono */}
        <span className={styles.codeMono}>{codeDisplay}</span>

        {/* Title */}
        <div className={styles.titleArea}>
          {isEditingTitle && !readOnly ? (
            <input
              className={styles.titleInputEdit}
              value={titleDraft}
              autoFocus
              disabled={disabled}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitTitle();
                if (e.key === 'Escape') {
                  setTitleDraft(tc.title);
                  setIsEditingTitle(false);
                }
              }}
            />
          ) : (
            <span
              className={`${styles.titleText} ${expanded ? styles.titleTextExpanded : ''}`}
              onClick={() => {
                if (!readOnly && !disabled) {
                  setTitleDraft(tc.title);
                  setIsEditingTitle(true);
                }
              }}
              title={readOnly ? undefined : 'Click to edit title'}
            >
              {tc.title || 'Untitled test case'}
            </span>
          )}
        </div>

        {/* Time / Status meta */}
        <span className={styles.timeMeta}>
          {tc.status === 'pass' && (tc.updatedAt ? `passed ${formatTimeAgo(tc.updatedAt)}` : 'passed')}
          {tc.status === 'fail' && (tc.updatedAt ? `failed ${formatTimeAgo(tc.updatedAt)}` : 'failed')}
          {tc.status === 'running' && (tc.startedAt ? `started ${formatTimeAgo(tc.startedAt)}` : 'running')}
          {tc.status === 'pending' && (tc.createdAt ? formatTimeAgo(tc.createdAt) : '')}
        </span>

        {/* Assignee Avatar */}
        <div className={styles.avatarBadge} title={tc.assignee || 'Assigned QA'}>
          {getInitials(tc.assignee)}
        </div>

        {/* Expand / Collapse Button */}
        <button
          type="button"
          className={`${styles.iconBtn} ${expanded ? styles.iconBtnActive : ''}`}
          onClick={() => setExpanded(!expanded)}
          aria-label={expanded ? 'Collapse details' : 'Expand details'}
          title={expanded ? 'Collapse details' : 'Expand details'}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            {expanded ? <path d="M18 15L12 9L6 15" /> : <path d="M6 9L12 15L18 9" />}
          </svg>
        </button>

        {/* Delete Button */}
        {!readOnly && (
          <button
            type="button"
            className={styles.iconBtn}
            onClick={onDelete}
            disabled={disabled}
            aria-label="Delete test case"
            title="Delete test case"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6H21" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M19 6L18 20a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            </svg>
          </button>
        )}
      </div>

      {/* Expanded Details */}
      {expanded && (
        <div className={styles.detailsBody}>
          {/* Description */}
          <div className={styles.fieldGroup}>
            <span className={styles.fieldLabel}>Description</span>
            {editingField === 'desc' && !readOnly ? (
              <textarea
                className={styles.fieldBox}
                style={{ width: '100%', boxSizing: 'border-box', minHeight: 70, outline: 'none' }}
                value={tc.description || ''}
                autoFocus
                placeholder="What does this test case cover?"
                onChange={(e) => onUpdate({ ...tc, description: e.target.value })}
                onBlur={() => setEditingField(null)}
              />
            ) : (
              <div
                className={styles.fieldBox}
                onClick={() => !readOnly && setEditingField('desc')}
                title={readOnly ? undefined : 'Click to edit description'}
              >
                {tc.description || <span style={{ color: '#9AA8A0', fontStyle: 'italic' }}>Click to add description...</span>}
              </div>
            )}
          </div>

          {/* Expected Result */}
          <div className={styles.fieldGroup}>
            <span className={styles.fieldLabel}>Expected result</span>
            {editingField === 'exp' && !readOnly ? (
              <textarea
                className={styles.fieldBox}
                style={{ width: '100%', boxSizing: 'border-box', minHeight: 70, outline: 'none' }}
                value={tc.expectedResult || ''}
                autoFocus
                placeholder="What is the expected behavior or pass bar?"
                onChange={(e) => onUpdate({ ...tc, expectedResult: e.target.value })}
                onBlur={() => setEditingField(null)}
              />
            ) : (
              <div
                className={styles.fieldBox}
                onClick={() => !readOnly && setEditingField('exp')}
                title={readOnly ? undefined : 'Click to edit expected result'}
              >
                {tc.expectedResult || <span style={{ color: '#9AA8A0', fontStyle: 'italic' }}>Click to add expected result...</span>}
              </div>
            )}
          </div>

          {/* Test Data */}
          <div className={styles.fieldGroup}>
            <span className={styles.fieldLabel}>Test data</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {(tc.testDataFiles ?? []).map((file, i) => {
                const href = uploadUrl(file.url, file.name);
                const chip = (
                  <>
                    <div className={styles.fileIcon} style={{ background: '#F1F8F3' }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#2E6F40" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14 3H7C5.9 3 5 3.9 5 5V19C5 20.1 5.9 21 7 21H17C18.1 21 19 20.1 19 19V8L14 3Z" />
                        <path d="M14 3V8H19" />
                      </svg>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: '#1E2A22' }}>{file.name}</span>
                      <span style={{ fontSize: 10, color: '#9AA8A0' }}>{file.size ? formatFileSize(file.size) : 'file'}</span>
                    </div>
                  </>
                );
                return (
                  <div key={file.id || i} className={styles.fileChip}>
                    {href ? (
                      <a href={href} download={file.name} title={`Download ${file.name}`} style={{ display: 'flex', alignItems: 'center', gap: 8, textDecoration: 'none' }}>
                        {chip}
                      </a>
                    ) : chip}
                    {!readOnly && (
                      <button
                        type="button"
                        className={styles.fileRemoveBtn}
                        aria-label={`Remove ${file.name}`}
                        onClick={() =>
                          onUpdate({
                            ...tc,
                            testDataFiles: (tc.testDataFiles ?? []).filter((f) => f !== file),
                            updatedAt: new Date().toISOString(),
                          })
                        }
                      >
                        ×
                      </button>
                    )}
                  </div>
                );
              })}
              {!readOnly && (
                <>
                  <button
                    type="button"
                    className={styles.fileAddBtn}
                    onClick={() => fileInputRef.current?.click()}
                    disabled={fileBusy}
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                      <path d="M12 5V19" /><path d="M5 12H19" />
                    </svg>
                    {fileBusy ? 'Uploading…' : 'Attach file'}
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    hidden
                    data-testid="tc-attach-input"
                    onChange={(e) => attachFiles(e.target.files)}
                  />
                </>
              )}
            </div>
            {fileError && <span style={{ fontSize: 11.5, color: '#A93226' }} role="alert">{fileError}</span>}
          </div>

          {/* Notes */}
          <div className={styles.fieldGroup}>
            <span className={styles.fieldLabel}>Notes</span>
            {editingField === 'notes' && !readOnly ? (
              <textarea
                className={styles.fieldBox}
                style={{ width: '100%', boxSizing: 'border-box', minHeight: 60, outline: 'none' }}
                value={tc.notes || tc.note || ''}
                autoFocus
                placeholder="Additional notes, screenshots, or environment details..."
                onChange={(e) => onUpdate({ ...tc, notes: e.target.value, note: e.target.value })}
                onBlur={() => setEditingField(null)}
              />
            ) : (
              <div
                className={styles.fieldBox}
                onClick={() => !readOnly && setEditingField('notes')}
                title={readOnly ? undefined : 'Click to edit notes'}
              >
                {tc.notes || tc.note || <span style={{ color: '#9AA8A0', fontStyle: 'italic' }}>Click to add run notes...</span>}
              </div>
            )}
          </div>

          {/* Footer Info */}
          <div className={styles.detailsFooter}>
            {tc.startedAt && <span>Started {formatTimeAgo(tc.startedAt)}</span>}
            {tc.startedAt && tc.updatedAt && <span>·</span>}
            {tc.updatedAt && <span>Last edited {formatTimeAgo(tc.updatedAt)}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

export function TestCasesSection({
  ticketId = 'KAN',
  testCases,
  onChange,
  onAdd,
  readOnly = false,
  disabled = false,
  childTestCaseSources = [],
}: TestCasesSectionProps) {
  const [statusFilter, setStatusFilter] = useState<'all' | TestCaseStatus>('all');
  const [rollupSource, setRollupSource] = useState<string>('all');
  const [rollupDropdownOpen, setRollupDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [addTitle, setAddTitle] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const addInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (showAddForm) {
      addInputRef.current?.focus();
    }
  }, [showAddForm]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setRollupDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  const hasChildren = childTestCaseSources.length > 0;

  // Counts across all test cases
  const allTestCases = [
    ...testCases,
    ...childTestCaseSources.flatMap((c) => c.testCases),
  ];

  // Active source list according to rollup selection
  const sourceTestCases = !hasChildren
    ? testCases
    : rollupSource === 'all'
    ? allTestCases
    : rollupSource === 'parent'
    ? testCases
    : childTestCaseSources.find((c) => c.ticketId === rollupSource)?.testCases ?? [];

  const passCount = sourceTestCases.filter((tc) => tc.status === 'pass').length;
  const failCount = sourceTestCases.filter((tc) => tc.status === 'fail').length;
  const runningCount = sourceTestCases.filter((tc) => tc.status === 'running').length;
  const pendingCount = sourceTestCases.filter((tc) => tc.status === 'pending').length;

  const currentRollupLabel =
    rollupSource === 'all'
      ? `All (${allTestCases.length})`
      : rollupSource === 'parent'
      ? `Parent only (${testCases.length})`
      : `Child: ${rollupSource} (${childTestCaseSources.find((c) => c.ticketId === rollupSource)?.testCases.length ?? 0})`;

  function filterList(list: TestCase[]) {
    if (statusFilter === 'all') return list;
    return list.filter((tc) => tc.status === statusFilter);
  }

  async function handleAddSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = addTitle.trim();
    if (!trimmed) return;
    setIsSubmitting(true);
    try {
      if (onAdd) {
        await onAdd(trimmed);
      } else {
        const nextCode = `TC-${testCases.length + 1}`;
        const newTC: TestCase = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          code: nextCode,
          title: trimmed,
          status: 'pending',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        onChange([...testCases, newTC]);
      }
      setAddTitle('');
      setShowAddForm(false);
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleUpdate(updated: TestCase) {
    onChange(testCases.map((tc) => (tc.id === updated.id ? updated : tc)));
  }

  function handleDelete(id: string) {
    onChange(testCases.filter((tc) => tc.id !== id));
  }

  return (
    <div className={styles.container}>
      {/* Top Bar: Count & Add Button (or Rollup Show row if parent ticket) */}
      {hasChildren ? (
        <div className={styles.topBar}>
          <div className={styles.rollupShowGroup}>
            <span className={styles.rollupShowLabel}>Show</span>
            <div className={styles.rollupDropdownWrapper} ref={dropdownRef}>
              <button
                type="button"
                className={styles.rollupDropdownBtn}
                onClick={() => setRollupDropdownOpen((prev) => !prev)}
                aria-haspopup="listbox"
                aria-expanded={rollupDropdownOpen}
              >
                {currentRollupLabel}
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#9AA8A0" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 9L12 15L18 9" />
                </svg>
              </button>
              {rollupDropdownOpen && (
                <div className={styles.rollupDropdownMenu} role="listbox">
                  <button
                    type="button"
                    className={`${styles.rollupMenuItem} ${rollupSource === 'all' ? styles.rollupMenuItemActive : ''}`}
                    onClick={() => {
                      setRollupSource('all');
                      setRollupDropdownOpen(false);
                    }}
                  >
                    All ({allTestCases.length})
                  </button>
                  <button
                    type="button"
                    className={`${styles.rollupMenuItem} ${rollupSource === 'parent' ? styles.rollupMenuItemActive : ''}`}
                    onClick={() => {
                      setRollupSource('parent');
                      setRollupDropdownOpen(false);
                    }}
                  >
                    Parent only ({testCases.length})
                  </button>
                  {childTestCaseSources.map((child) => (
                    <button
                      key={child.ticketId}
                      type="button"
                      className={`${styles.rollupMenuItem} ${rollupSource === child.ticketId ? styles.rollupMenuItemActive : ''}`}
                      onClick={() => {
                        setRollupSource(child.ticketId);
                        setRollupDropdownOpen(false);
                      }}
                    >
                      Child: {child.ticketId} ({child.testCases.length})
                    </button>
                  ))}
                </div>
              )}
            </div>
            <span className={styles.rollupSep}>·</span>
            <span className={styles.rollupBreakdown}>
              Parent only ({testCases.length})
              {childTestCaseSources.map((c) => ` · Child: ${c.ticketId} (${c.testCases.length})`).join('')}
            </span>
          </div>

          {!readOnly && (
            <button
              type="button"
              className={styles.tcAddBtn}
              title={`Adds to ${ticketId} itself — open a sub-ticket's own Test Cases panel to add one there`}
              onClick={() => setShowAddForm(true)}
              disabled={disabled || showAddForm}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                <path d="M12 5V19" /><path d="M5 12H19" />
              </svg>
              Add test case
            </button>
          )}
        </div>
      ) : (
        <div className={styles.topBar}>
          <span className={styles.tcLabel}>
            {testCases.length} test cases · {ticketId}
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
              Add test case
            </button>
          )}
        </div>
      )}

      {/* Filter Chips */}
      <div className={styles.filterRow}>
        <button
          type="button"
          className={`${styles.filterChip} ${statusFilter === 'all' ? styles.filterChipActive : ''}`}
          onClick={() => setStatusFilter('all')}
        >
          All ({sourceTestCases.length})
        </button>
        <button
          type="button"
          className={`${styles.filterChip} ${statusFilter === 'pass' ? styles.filterChipActive : ''}`}
          onClick={() => setStatusFilter('pass')}
        >
          <span className={styles.filterDot} style={{ background: '#2E6F40' }} />
          Pass ({passCount})
        </button>
        {(failCount > 0 || statusFilter === 'fail') && (
          <button
            type="button"
            className={`${styles.filterChip} ${statusFilter === 'fail' ? styles.filterChipActive : ''}`}
            onClick={() => setStatusFilter('fail')}
          >
            <span className={styles.filterDot} style={{ background: '#C4432A' }} />
            Fail ({failCount})
          </button>
        )}
        <button
          type="button"
          className={`${styles.filterChip} ${statusFilter === 'running' ? styles.filterChipActive : ''}`}
          onClick={() => setStatusFilter('running')}
        >
          <span className={styles.filterDot} style={{ background: '#2F6FB0' }} />
          Running ({runningCount})
        </button>
        <button
          type="button"
          className={`${styles.filterChip} ${statusFilter === 'pending' ? styles.filterChipActive : ''}`}
          onClick={() => setStatusFilter('pending')}
        >
          <span className={styles.filterDot} style={{ background: '#9AA8A0' }} />
          Pending ({pendingCount})
        </button>
      </div>

      {/* Inline Add Test Case Form */}
      {showAddForm && (
        <form className={styles.inlineAddCard} onSubmit={handleAddSubmit}>
          <input
            ref={addInputRef}
            className={styles.inlineAddInput}
            value={addTitle}
            placeholder="Test case title…"
            onChange={(e) => setAddTitle(e.target.value)}
            disabled={isSubmitting}
          />
          <div className={styles.inlineAddActions}>
            <button
              type="submit"
              className={styles.btnSubmit}
              disabled={isSubmitting || !addTitle.trim()}
            >
              {isSubmitting ? 'Adding…' : 'Add'}
            </button>
            <button
              type="button"
              className={styles.btnCancel}
              onClick={() => {
                setShowAddForm(false);
                setAddTitle('');
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Main Ticket Test Cases */}
      {(rollupSource === 'all' || rollupSource === 'parent') && (
        <div className={styles.groupSection}>
          {hasChildren && (
            <div className={styles.groupHeader}>
              <span>{ticketId} — this ticket</span>
            </div>
          )}
          <div className={styles.groupTable}>
            {filterList(testCases).length === 0 ? (
              <div className={styles.emptyMsg}>No test cases in this view.</div>
            ) : (
              filterList(testCases).map((tc, idx) => (
                <TestCaseRowItem
                  key={tc.id}
                  tc={tc}
                  index={idx}
                  onUpdate={handleUpdate}
                  onDelete={() => handleDelete(tc.id)}
                  readOnly={readOnly}
                  disabled={disabled}
                />
              ))
            )}
          </div>
        </div>
      )}

      {/* Sub-ticket groups (if rollup) */}
      {hasChildren &&
        childTestCaseSources.map((child) => {
          if (rollupSource !== 'all' && rollupSource !== child.ticketId) return null;
          const childFiltered = filterList(child.testCases);
          return (
            <div key={child.ticketId} className={styles.groupSection}>
              <div className={styles.groupHeader}>
                <span>{child.ticketId}</span>
                <span style={{ color: '#C7D2CB' }}>·</span>
                <span>{child.ticketTitle} — read-only here</span>
              </div>
              <div className={styles.groupTable}>
                {childFiltered.length === 0 ? (
                  <div className={styles.emptyMsg}>No test cases for this child.</div>
                ) : (
                  childFiltered.map((tc, idx) => (
                    <TestCaseRowItem
                      key={tc.id}
                      tc={tc}
                      index={idx}
                      onUpdate={() => {}}
                      onDelete={() => {}}
                      readOnly={true}
                      disabled={true}
                    />
                  ))
                )}
              </div>
            </div>
          );
        })}
    </div>
  );
}
