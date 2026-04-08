import { useEffect, useRef, useState } from 'react';
import type { TestCase, TestCaseStatus } from '../types';
import styles from './TestCasesSection.module.css';

interface ChildTestCaseSource {
  ticketId: string;
  ticketTitle: string;
  testCases: TestCase[];
}

interface TestCasesSectionProps {
  testCases: TestCase[];
  onChange: (updated: TestCase[]) => void;
  onAdd?: (title: string) => Promise<void>;
  readOnly?: boolean;
  disabled?: boolean;
  childTestCaseSources?: ChildTestCaseSource[];
}

const STATUS_CYCLE: Record<TestCaseStatus, TestCaseStatus> = {
  pending: 'pass',
  pass: 'fail',
  fail: 'pending',
};

const STATUS_LABEL: Record<TestCaseStatus, string> = {
  pending: 'PENDING',
  pass: 'PASS',
  fail: 'FAIL',
};

const STATUS_CLASS: Record<TestCaseStatus, string> = {
  pending: styles.status_todo,
  pass: styles.status_pass,
  fail: styles.status_fail,
};

function genId() {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function TestCaseRow({
  tc,
  onUpdate,
  onDelete,
  readOnly,
  disabled,
  sourceBadge,
}: {
  tc: TestCase;
  onUpdate: (updated: TestCase) => void;
  onDelete: () => void;
  readOnly: boolean;
  disabled?: boolean;
  sourceBadge?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editingTitle, setEditingTitle] = useState(tc.title === '');
  const [titleDraft, setTitleDraft] = useState(tc.title);
  const [titleError, setTitleError] = useState(false);

  function cycleStatus() {
    if (readOnly) return;
    onUpdate({ ...tc, status: STATUS_CYCLE[tc.status] });
  }

  function commitTitle() {
    if (titleDraft.trim() === '') {
      setTitleError(true);
      return;
    }
    setTitleError(false);
    setEditingTitle(false);
    if (titleDraft.trim() !== tc.title) {
      onUpdate({ ...tc, title: titleDraft.trim() });
    }
  }

  function handleTitleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') commitTitle();
    if (e.key === 'Escape') {
      if (tc.title === '') return; // new row: keep open until a title is given
      setTitleDraft(tc.title);
      setTitleError(false);
      setEditingTitle(false);
    }
  }

  return (
    <div className={styles.row}>
      <div className={styles.rowMain}>
        <button
          type="button"
          className={`${styles.statusBadge} ${STATUS_CLASS[tc.status]}`}
          onClick={cycleStatus}
          disabled={readOnly}
          aria-label={`Status: ${tc.status}. Click to cycle.`}
          title="Click to cycle status"
        >
          {STATUS_LABEL[tc.status]}
        </button>

        {editingTitle && !readOnly ? (
          <>
            <input
              className={`${styles.titleInput}${titleError ? ` ${styles.titleInputError}` : ''}`}
              value={titleDraft}
              autoFocus
              disabled={disabled}
              onChange={(e) => { setTitleDraft(e.target.value); setTitleError(false); }}
              onBlur={commitTitle}
              onKeyDown={handleTitleKeyDown}
              aria-label="Edit test case title"
            />
            {titleError && <span className={styles.titleErrorMsg}>Title is required</span>}
          </>
        ) : (
          <span
            className={styles.title}
            onClick={() => { if (!readOnly) { setTitleDraft(tc.title); setEditingTitle(true); } }}
            title={readOnly ? undefined : 'Click to edit'}
          >
            {tc.title || <em className={styles.placeholder}>Untitled test case</em>}
          </span>
        )}

        {sourceBadge && (
          <span className={styles.sourceBadge}>{sourceBadge}</span>
        )}

        <div className={styles.rowActions}>
          <button
            type="button"
            className={`${styles.expandBtn} ${expanded ? styles.expandBtnOpen : ''}`}
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-label={expanded ? 'Collapse details' : 'Expand details'}
          >
            ▼
          </button>
          {!readOnly && (
            <button
              type="button"
              className={styles.deleteBtn}
              onClick={onDelete}
              disabled={disabled}
              aria-label={`Delete test case: ${tc.title}`}
            >
              🗑
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div className={styles.details}>
          <label className={styles.detailLabel} htmlFor={`proof-${tc.id}`}>Proof</label>
          <textarea
            id={`proof-${tc.id}`}
            className={styles.textarea}
            rows={2}
            value={tc.proof ?? ''}
            readOnly={readOnly}
            onChange={(e) => onUpdate({ ...tc, proof: e.target.value })}
            placeholder="Screenshot URL, test run ID, or any proof..."
          />
          <label className={styles.detailLabel} htmlFor={`note-${tc.id}`}>Note</label>
          <textarea
            id={`note-${tc.id}`}
            className={styles.textarea}
            rows={2}
            value={tc.note ?? ''}
            readOnly={readOnly}
            onChange={(e) => onUpdate({ ...tc, note: e.target.value })}
            placeholder="Additional notes..."
          />
        </div>
      )}
    </div>
  );
}

export function TestCasesSection({ testCases, onChange, onAdd, readOnly = false, disabled = false, childTestCaseSources }: TestCasesSectionProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [activeFilter, setActiveFilter] = useState<string>('all');
  const [showAddForm, setShowAddForm] = useState(false);
  const [addTitle, setAddTitle] = useState('');
  const [addPending, setAddPending] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const addTitleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (showAddForm) addTitleRef.current?.focus();
  }, [showAddForm]);

  const sourcesWithTCs = (childTestCaseSources ?? []).filter((s) => s.testCases.length > 0);
  const isRollupMode = sourcesWithTCs.length > 0;

  // Build display items based on current filter
  const displayItems: { tc: TestCase; sourceBadge?: string; isReadOnly: boolean }[] = [];
  if (!isRollupMode) {
    testCases.forEach((tc) => displayItems.push({ tc, isReadOnly: readOnly }));
  } else {
    const showOwn = activeFilter === 'all' || activeFilter === 'parent';
    if (showOwn) {
      testCases.forEach((tc) => displayItems.push({ tc, isReadOnly: false }));
    }
    if (activeFilter === 'all') {
      sourcesWithTCs.forEach((source) => {
        source.testCases.forEach((tc) =>
          displayItems.push({ tc, sourceBadge: source.ticketId, isReadOnly: true })
        );
      });
    } else if (activeFilter === 'child') {
      // single child: show all its TCs
      sourcesWithTCs.forEach((source) => {
        source.testCases.forEach((tc) =>
          displayItems.push({ tc, sourceBadge: source.ticketId, isReadOnly: true })
        );
      });
    } else if (activeFilter.startsWith('child:')) {
      // multi-child: show specific child
      const targetId = activeFilter.slice(6);
      const source = sourcesWithTCs.find((s) => s.ticketId === targetId);
      source?.testCases.forEach((tc) =>
        displayItems.push({ tc, sourceBadge: source.ticketId, isReadOnly: true })
      );
    }
    // 'parent' only shows own TCs (already pushed above)
  }

  const passCount = displayItems.filter((i) => i.tc.status === 'pass').length;
  const failCount = displayItems.filter((i) => i.tc.status === 'fail').length;
  const todoCount = displayItems.filter((i) => i.tc.status === 'pending').length;
  const totalCount = displayItems.length;

  function handleAdd() {
    if (onAdd) {
      setShowAddForm(true);
      setAddTitle('');
      setAddError(null);
      setIsExpanded(true);
    } else {
      const newCase: TestCase = {
        id: genId(),
        title: '',
        status: 'pending',
        proof: null,
        note: null,
      };
      onChange([...testCases, newCase]);
      setIsExpanded(true);
    }
  }

  function handleCancelAdd() {
    setShowAddForm(false);
    setAddTitle('');
    setAddError(null);
  }

  async function handleSubmitAdd(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = addTitle.trim();
    if (!trimmed || !onAdd) return;
    setAddPending(true);
    setAddError(null);
    try {
      await onAdd(trimmed);
      setShowAddForm(false);
      setAddTitle('');
    } catch {
      setAddError('Failed to add test case. Please try again.');
    } finally {
      setAddPending(false);
    }
  }

  function handleUpdate(updated: TestCase) {
    onChange(testCases.map((tc) => (tc.id === updated.id ? updated : tc)));
  }

  function handleDelete(id: string) {
    onChange(testCases.filter((tc) => tc.id !== id));
  }

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeaderRow}>
        <button
          type="button"
          className={styles.sectionToggle}
          onClick={() => {
            if (isExpanded) {
              setShowAddForm(false);
              setAddTitle('');
              setAddError(null);
            }
            setIsExpanded((v) => !v);
          }}
          aria-expanded={isExpanded}
        >
          <span className={styles.sectionHeader}>Test Cases</span>
          {isRollupMode ? (
            <span className={styles.statusSummary}>
              {passCount > 0 && (
                <span className={`${styles.statusCount} ${styles.statusCountPass}`}>{passCount} pass</span>
              )}
              {failCount > 0 && (
                <span className={`${styles.statusCount} ${styles.statusCountFail}`}>{failCount} fail</span>
              )}
              {todoCount > 0 && (
                <span className={`${styles.statusCount} ${styles.statusCountTodo}`}>{todoCount} todo</span>
              )}
              {totalCount === 0 && (
                <span className={`${styles.statusCount} ${styles.statusCountTodo}`}>0</span>
              )}
            </span>
          ) : (
            totalCount > 0 && <span className={styles.countBadge}>{totalCount}</span>
          )}
          <span className={`${styles.chevron} ${!isExpanded ? styles.chevronCollapsed : ''}`}>▼</span>
        </button>
        {!readOnly && (
          <button type="button" className={styles.addBtn} onClick={handleAdd} disabled={disabled}>
            ＋ Add
          </button>
        )}
      </div>

      {showAddForm && onAdd && (
        <form className={styles.addForm} onSubmit={handleSubmitAdd}>
          <input
            ref={addTitleRef}
            className={styles.addFormInput}
            value={addTitle}
            onChange={(e) => { setAddTitle(e.target.value); setAddError(null); }}
            placeholder="Test case title…"
            disabled={addPending}
            aria-label="New test case title"
          />
          {addError && <p className={styles.addFormError}>{addError}</p>}
          <div className={styles.addFormActions}>
            <button
              type="submit"
              className={styles.addFormSubmit}
              disabled={addPending || !addTitle.trim()}
            >
              {addPending ? 'Adding…' : 'Add'}
            </button>
            <button
              type="button"
              className={styles.addFormCancel}
              onClick={handleCancelAdd}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {isExpanded && (
        <>
          {isRollupMode && (
            <div className={styles.filterBar}>
              <select
                className={styles.filterSelect}
                value={activeFilter}
                onChange={(e) => setActiveFilter(e.target.value)}
                aria-label="Filter test cases"
              >
                <option value="all">All ({totalCount})</option>
                <option value="parent">Parent only ({testCases.length})</option>
                {sourcesWithTCs.length === 1 ? (
                  <option value="child">Child only ({sourcesWithTCs[0].testCases.length})</option>
                ) : (
                  sourcesWithTCs.map((source) => (
                    <option key={source.ticketId} value={`child:${source.ticketId}`}>
                      Child: {source.ticketId} ({source.testCases.length})
                    </option>
                  ))
                )}
              </select>
            </div>
          )}
          <div className={styles.list}>
            {displayItems.length === 0 ? (
              <p className={styles.empty}>No test cases yet.</p>
            ) : (
              displayItems.map(({ tc, sourceBadge, isReadOnly }) => (
                <TestCaseRow
                  key={`${sourceBadge ?? 'own'}-${tc.id}`}
                  tc={tc}
                  onUpdate={handleUpdate}
                  onDelete={() => handleDelete(tc.id)}
                  readOnly={isReadOnly}
                  disabled={disabled}
                  sourceBadge={sourceBadge}
                />
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
