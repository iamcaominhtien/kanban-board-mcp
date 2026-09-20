import { useEffect, useRef, useState } from 'react';
import type { TestCase, TestCaseStatus } from '../types';
import { uploadDescriptionImage } from '../api/tickets';
import { MarkdownEditor } from './MarkdownEditor';
import styles from './TestCasesSection.module.css';

// TODO(backend): TestCases.dc.html's rev-2 mockup describes a richer data model that is
// intentionally NOT implemented here pending a backend decision — do not add these fields
// without one: a 4th `running` status (with `startedAt`), `description`/`expectedResult`
// (the "pass bar") as separate markdown fields, `proof`+`note` merging into a single markdown
// `notes` field, `updatedAt`, per-field file attachments (on expectedResult/notes plus a
// dedicated testDataFiles bucket), a per-row assignee, and short human-readable `TC-N` codes.
// The mockup's own closing note calls these "open questions" (structured vs. free-text
// expected result, run history, who can set "Running") that need a QA-workflow check first.
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
  /** This ticket's own id/code, used as the "this ticket" group header in rollup mode. */
  ownTicketId?: string;
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

const STATUS_CHIPS: { label: string; value: TestCaseStatus | 'all' }[] = [
  { label: 'All', value: 'all' },
  { label: 'Pass', value: 'pass' },
  { label: 'Fail', value: 'fail' },
  { label: 'Pending', value: 'pending' },
];

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
}: {
  tc: TestCase;
  onUpdate: (updated: TestCase) => void;
  onDelete: () => void;
  readOnly: boolean;
  disabled?: boolean;
}) {
  const [expanded, setExpanded] = useState(() => !!(tc.proof || tc.note));
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

        {!readOnly && !expanded && (tc.proof || tc.note) && (
          <span className={styles.hasMetaIndicator} title="Has proof or note — click ▼ to view">
            📎
          </span>
        )}

        {/* Read-only rows (rolled up from a sub-ticket) show no expand/delete controls at
            all — view or edit them from that sub-ticket's own Test Cases panel instead. */}
        {!readOnly && (
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
            <button
              type="button"
              className={styles.deleteBtn}
              onClick={onDelete}
              disabled={disabled}
              aria-label={`Delete test case: ${tc.title}`}
            >
              🗑
            </button>
          </div>
        )}
      </div>

      {!readOnly && expanded && (
        <div className={styles.details}>
          <label className={styles.detailLabel}>Proof</label>
          <MarkdownEditor
            value={tc.proof ?? ''}
            onChange={(value) => onUpdate({ ...tc, proof: value || null })}
            onBlur={(value) => onUpdate({ ...tc, proof: value || null })}
            onUploadImage={async (file) => {
              const result = await uploadDescriptionImage(file);
              return { markdown: result.markdown };
            }}
            onUploadComplete={(value) => onUpdate({ ...tc, proof: value || null })}
            readOnly={readOnly}
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

export function TestCasesSection({ testCases, onChange, onAdd, readOnly = false, disabled = false, childTestCaseSources, ownTicketId }: TestCasesSectionProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [activeFilter, setActiveFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<TestCaseStatus | 'all'>('all');
  const [showAddForm, setShowAddForm] = useState(false);
  const [addTitle, setAddTitle] = useState('');
  const [addPending, setAddPending] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const addTitleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (showAddForm) addTitleRef.current?.focus();
  }, [showAddForm]);

  const sourcesWithTCs = (childTestCaseSources ?? []).filter((s) => s.testCases.length > 0);

  useEffect(() => {
    setActiveFilter('all');
  }, [sourcesWithTCs.length]);

  const isRollupMode = sourcesWithTCs.length > 0;

  // Build groups (one per ticket) based on the current "Show" filter. In rollup mode each
  // group renders as its own labeled, bordered block instead of one flat interleaved list.
  interface Group {
    key: string;
    kind: 'own' | 'child';
    ticketId?: string;
    ticketTitle?: string;
    testCases: TestCase[];
    isReadOnly: boolean;
  }

  const groups: Group[] = [];
  if (!isRollupMode) {
    groups.push({ key: 'own', kind: 'own', testCases, isReadOnly: readOnly });
  } else {
    const showOwn = activeFilter === 'all' || activeFilter === 'parent';
    if (showOwn) {
      groups.push({ key: 'own', kind: 'own', testCases, isReadOnly: false });
    }
    const showAllChildren = activeFilter === 'all' || activeFilter === 'child';
    sourcesWithTCs.forEach((source) => {
      const show = showAllChildren || activeFilter === `child:${source.ticketId}`;
      if (show) {
        groups.push({
          key: source.ticketId,
          kind: 'child',
          ticketId: source.ticketId,
          ticketTitle: source.ticketTitle,
          testCases: source.testCases,
          isReadOnly: true,
        });
      }
    });
  }

  const displayItems: { tc: TestCase; isReadOnly: boolean }[] = groups.flatMap((g) =>
    g.testCases.map((tc) => ({ tc, isReadOnly: g.isReadOnly }))
  );

  const passCount = displayItems.filter((i) => i.tc.status === 'pass').length;
  const failCount = displayItems.filter((i) => i.tc.status === 'fail').length;
  const todoCount = displayItems.filter((i) => i.tc.status === 'pending').length;
  const totalCount = displayItems.length;
  const totalAllCount = testCases.length + sourcesWithTCs.reduce((sum, s) => sum + s.testCases.length, 0);

  const visibleItems = statusFilter === 'all'
    ? displayItems
    : displayItems.filter((i) => i.tc.status === statusFilter);

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
                <option value="all">All ({totalAllCount})</option>
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
          {totalCount > 0 && (
            <div className={styles.statusChips} role="group" aria-label="Filter by status">
              {STATUS_CHIPS.map((chip) => {
                const count = chip.value === 'all' ? totalCount
                  : chip.value === 'pass' ? passCount
                  : chip.value === 'fail' ? failCount
                  : todoCount;
                return (
                  <button
                    key={chip.value}
                    type="button"
                    className={`${styles.statusChip} ${statusFilter === chip.value ? styles.statusChipActive : ''}`}
                    onClick={() => setStatusFilter(chip.value)}
                    aria-pressed={statusFilter === chip.value}
                  >
                    {chip.label} ({count})
                  </button>
                );
              })}
            </div>
          )}
          <div className={styles.groups}>
            {totalCount === 0 ? (
              <p className={styles.empty}>No test cases yet.</p>
            ) : visibleItems.length === 0 ? (
              <p className={styles.empty}>No test cases match this filter.</p>
            ) : (
              groups.map((group) => {
                const filtered = statusFilter === 'all'
                  ? group.testCases
                  : group.testCases.filter((tc) => tc.status === statusFilter);
                if (filtered.length === 0) return null;
                return (
                  <div key={group.key} className={styles.group}>
                    {isRollupMode && group.kind === 'own' && (
                      <div className={styles.groupHeaderOwn}>{ownTicketId ?? 'This ticket'} — this ticket</div>
                    )}
                    {isRollupMode && group.kind === 'child' && (
                      <div className={styles.groupHeaderChild}>
                        <span className={styles.groupHeaderChildId}>{group.ticketId}</span>
                        <span className={styles.groupHeaderSep}>·</span>
                        <span>{group.ticketTitle} — read-only here</span>
                      </div>
                    )}
                    <div className={`${styles.list} ${group.isReadOnly ? styles.listReadOnly : ''}`}>
                      {filtered.map((tc) => (
                        <TestCaseRow
                          key={tc.id}
                          tc={tc}
                          onUpdate={handleUpdate}
                          onDelete={() => handleDelete(tc.id)}
                          readOnly={group.isReadOnly}
                          disabled={disabled}
                        />
                      ))}
                    </div>
                  </div>
                );
              })
            )}
          </div>
          {isRollupMode && totalCount > 0 && (
            <p className={styles.rollupNote}>
              Grouped by ticket instead of a flat mixed list — own test cases first, then each
              sub-ticket&apos;s in its own block. Sub-ticket groups are read-only here — edited
              from that ticket&apos;s own Test Cases board.
            </p>
          )}
        </>
      )}
    </div>
  );
}
