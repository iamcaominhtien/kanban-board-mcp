import { useState } from 'react';
import type { TestCase, TestCaseStatus } from '../types';
import styles from './TestCasesSection.module.css';

interface TestCasesSectionProps {
  testCases: TestCase[];
  onChange: (updated: TestCase[]) => void;
  readOnly?: boolean;
}

const STATUS_CYCLE: Record<TestCaseStatus, TestCaseStatus> = {
  todo: 'pass',
  pass: 'fail',
  fail: 'todo',
};

const STATUS_LABEL: Record<TestCaseStatus, string> = {
  todo: 'TODO',
  pass: 'PASS',
  fail: 'FAIL',
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
}: {
  tc: TestCase;
  onUpdate: (updated: TestCase) => void;
  onDelete: () => void;
  readOnly: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(tc.title);

  function cycleStatus() {
    if (readOnly) return;
    onUpdate({ ...tc, status: STATUS_CYCLE[tc.status] });
  }

  function commitTitle() {
    setEditingTitle(false);
    if (titleDraft.trim() !== tc.title) {
      onUpdate({ ...tc, title: titleDraft.trim() || tc.title });
    }
  }

  function handleTitleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') commitTitle();
    if (e.key === 'Escape') {
      setTitleDraft(tc.title);
      setEditingTitle(false);
    }
  }

  return (
    <div className={styles.row}>
      <div className={styles.rowMain}>
        <button
          type="button"
          className={`${styles.statusBadge} ${styles[`status_${tc.status}`]}`}
          onClick={cycleStatus}
          disabled={readOnly}
          aria-label={`Status: ${tc.status}. Click to cycle.`}
          title="Click to cycle status"
        >
          {STATUS_LABEL[tc.status]}
        </button>

        {editingTitle && !readOnly ? (
          <input
            className={styles.titleInput}
            value={titleDraft}
            autoFocus
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={handleTitleKeyDown}
            aria-label="Edit test case title"
          />
        ) : (
          <span
            className={styles.title}
            onClick={() => { if (!readOnly) { setEditingTitle(true); setTitleDraft(tc.title); } }}
            title={readOnly ? undefined : 'Click to edit'}
          >
            {tc.title || <em className={styles.placeholder}>Untitled test case</em>}
          </span>
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
            value={tc.proof}
            readOnly={readOnly}
            onChange={(e) => onUpdate({ ...tc, proof: e.target.value })}
            placeholder="Screenshot URL, test run ID, or any proof..."
          />
          <label className={styles.detailLabel} htmlFor={`note-${tc.id}`}>Note</label>
          <textarea
            id={`note-${tc.id}`}
            className={styles.textarea}
            rows={2}
            value={tc.note}
            readOnly={readOnly}
            onChange={(e) => onUpdate({ ...tc, note: e.target.value })}
            placeholder="Additional notes..."
          />
        </div>
      )}
    </div>
  );
}

export function TestCasesSection({ testCases, onChange, readOnly = false }: TestCasesSectionProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  function handleAdd() {
    const newCase: TestCase = {
      id: genId(),
      title: '',
      status: 'todo',
      proof: '',
      note: '',
      createdAt: new Date().toISOString(),
    };
    onChange([...testCases, newCase]);
    setIsExpanded(true);
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
          onClick={() => setIsExpanded((v) => !v)}
          aria-expanded={isExpanded}
        >
          <span className={styles.sectionHeader}>Test Cases</span>
          {testCases.length > 0 && (
            <span className={styles.countBadge}>{testCases.length}</span>
          )}
          <span className={`${styles.chevron} ${!isExpanded ? styles.chevronCollapsed : ''}`}>▼</span>
        </button>
        {!readOnly && (
          <button type="button" className={styles.addBtn} onClick={handleAdd}>
            ＋ Add
          </button>
        )}
      </div>

      {isExpanded && (
        <div className={styles.list}>
          {testCases.length === 0 ? (
            <p className={styles.empty}>No test cases yet.</p>
          ) : (
            testCases.map((tc) => (
              <TestCaseRow
                key={tc.id}
                tc={tc}
                onUpdate={handleUpdate}
                onDelete={() => handleDelete(tc.id)}
                readOnly={readOnly}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}
