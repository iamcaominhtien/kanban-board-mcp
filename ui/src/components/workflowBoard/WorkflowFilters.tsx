import { useState } from 'react';
import type { WorkflowFilterState } from '../../types/aiWorkflowBoard';
import type { WorkflowFilterOptions } from './workflowFilter';
import { isFilterActive, roleName } from './workflowFilter';
import styles from '../FilterBar.module.css';

type Menu = 'role' | 'template' | 'step' | null;

/**
 * The filters wave 2 adds to the board's filter bar (ai-team-process.md, K): Waiting for me, Role, Workflow, Step.
 * "I have to review" is not here: it reads the Reviewer field of an odd job, which has no data behind it yet.
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
  if (options.templates.length === 0) return null;

  const dropdown = (
    id: Exclude<Menu, null>,
    label: string,
    current: string,
    currentLabel: string,
    items: { value: string; label: string }[],
  ) => (
    <div className={styles.dropdownContainer}>
      <button
        type="button"
        className={`${styles.dropdownBtn} ${open === id ? styles.dropdownBtnActive : ''}`}
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
