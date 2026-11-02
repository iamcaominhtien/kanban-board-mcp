import { useEffect, useRef, useState } from 'react';
import type { WorkflowFilterState } from '../../types/aiWorkflowBoard';
import type { WorkflowFilterOptions } from './workflowFilter';
import { isFilterActive, roleName } from './workflowFilter';
import styles from '../FilterBar.module.css';
import { LineIcon } from '../ui/LineIcon';

type Menu = 'role' | 'template' | 'step' | null;

/**
 * The filters wave 2 adds to the board's filter bar (ai-team-process.md, K): Waiting for me, Role, Workflow, Step.
 * "I have to review" is not here: it reads the Reviewer field of an odd job, which has no data behind it yet.
 *
 * Role, Workflow and Step sit in one "More filters" dropdown (with a count of the ones set), so the bar keeps one
 * line at 1440 px (main-board.md: "the bar stays one line instead of three", board MB-3).
 */
export function WorkflowFilters({
  options,
  value,
  onChange,
}: {
  options: WorkflowFilterOptions;
  value: WorkflowFilterState;
  onChange: (next: WorkflowFilterState) => void;
}) {
  const [open, setOpen] = useState<Menu>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setMoreOpen(false);
        setOpen(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMoreOpen(false);
        setOpen(null);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [moreOpen]);
  if (options.templates.length === 0) return null;

  const dropdown = (
    id: Exclude<Menu, null>,
    label: string,
    current: string,
    currentLabel: string,
    items: { value: string; label: string }[],
  ) => (
    <div className={styles.dropdownContainer} style={{ width: '100%' }}>
      <button
        type="button"
        className={`${styles.dropdownBtn} ${open === id ? styles.dropdownBtnActive : ''}`}
        style={{ width: '100%', justifyContent: 'flex-start' }}
        aria-expanded={open === id}
        data-testid={`workflow-filter-${id}`}
        onClick={() => setOpen(open === id ? null : id)}
      >
        <span className={styles.labelMuted}>{label}:</span> {current === 'all' ? 'All' : currentLabel}
      </button>
      {open === id && (
        <div className={styles.dropdownMenu}>
          {[{ value: 'all', label: 'All' }, ...items].map((it) => (
            <button
              key={it.value}
              type="button"
              className={`${styles.dropdownItem} ${current === it.value ? styles.dropdownItemActive : ''}`}
              onClick={() => {
                onChange({ ...value, [id]: it.value });
                setOpen(null);
              }}
            >
              <span className={styles.itemLabel}>{it.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );

  const waiting = value.waitingForMe;
  const moreCount = (['role', 'template', 'step'] as const).filter((k) => value[k] !== 'all').length;
  return (
    <>
      <span className={styles.divider} />
      <button
        type="button"
        aria-pressed={waiting}
        data-testid="workflow-filter-waiting"
        onClick={() => onChange({ ...value, waitingForMe: !waiting })}
        title="Tickets at a step that stops for a person"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          height: 28,
          padding: '0 11px',
          borderRadius: 999,
          border: waiting ? '1px solid #2E6F40' : '1px solid #D5DED8',
          background: waiting ? '#2E6F40' : '#fff',
          color: waiting ? '#fff' : '#3A4A3E',
          fontSize: 12,
          fontWeight: 600,
          whiteSpace: 'nowrap',
          cursor: 'pointer',
        }}
      >
        Waiting for me <b style={{ fontWeight: 700, opacity: 0.8 }}>{options.waitingCount}</b>
      </button>
      <div ref={moreRef} className={styles.dropdownContainer}>
        <button
          type="button"
          className={`${styles.dropdownBtn} ${moreOpen ? styles.dropdownBtnActive : ''}`}
          aria-expanded={moreOpen}
          aria-haspopup="dialog"
          data-testid="workflow-filter-more"
          onClick={() => {
            setMoreOpen(!moreOpen);
            setOpen(null);
          }}
        >
          More filters
          {moreCount > 0 && (
            <span className={styles.moreCount} data-testid="workflow-filter-more-count">
              {moreCount}
            </span>
          )}
          <LineIcon name="chevronDown" size={11} color="#5B6B60" />
        </button>
        {moreOpen && (
          <div className={styles.morePanel} role="dialog" aria-label="More filters">
            {options.roles.length > 0 &&
              dropdown(
                'role',
                'Role',
                value.role,
                roleName(value.role),
                options.roles.map((r) => ({ value: r, label: roleName(r) })),
              )}
            {dropdown(
              'template',
              'Workflow',
              value.template,
              options.templates.find((t) => t.key === value.template)?.name ?? value.template,
              options.templates.map((t) => ({ value: t.key, label: t.name })),
            )}
            {options.steps.length > 0 &&
              dropdown(
                'step',
                'Step',
                value.step,
                value.step,
                options.steps.map((s) => ({ value: s, label: s })),
              )}
          </div>
        )}
      </div>
      {isFilterActive(value) && (
        <button
          type="button"
          onClick={() => onChange({ waitingForMe: false, role: 'all', template: 'all', step: 'all' })}
          style={{
            border: 'none',
            background: 'none',
            color: '#2E6F40',
            fontSize: 12.5,
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          Clear
        </button>
      )}
    </>
  );
}
