import { useState } from 'react';
import type { AcceptanceCriterion } from '../types';
import styles from './AcceptanceCriteriaSection.module.css';

interface AcceptanceCriteriaSectionProps {
  acceptanceCriteria: AcceptanceCriterion[];
  onAdd: (text: string) => void;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
}

export function AcceptanceCriteriaSection({ acceptanceCriteria, onAdd, onToggle, onDelete }: AcceptanceCriteriaSectionProps) {
  const [text, setText] = useState('');

  const completed = acceptanceCriteria.filter((s) => s.completed).length;
  const total = acceptanceCriteria.length;

  function handleAdd() {
    if (!text.trim()) return;
    onAdd(text.trim());
    setText('');
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') handleAdd();
  }

  return (
    <div className={styles.section}>
      <h3 className={styles.sectionHeader}>
        Acceptance Criteria {total > 0 ? `(${completed}/${total})` : ''}
      </h3>

      {total === 0 ? (
        <p className={styles.empty}>No acceptance criteria yet.</p>
      ) : (
        <div className={styles.list}>
          {acceptanceCriteria.map((s) => (
            <div key={s.id} className={styles.row}>
              <input
                type="checkbox"
                className={styles.checkbox}
                checked={s.completed}
                onChange={() => onToggle(s.id)}
                id={`ac-${s.id}`}
                aria-label={s.text}
              />
              <label
                htmlFor={`ac-${s.id}`}
                className={s.completed ? styles.textCompleted : styles.text}
              >
                {s.text}
              </label>
              <button
                type="button"
                className={styles.deleteBtn}
                onClick={() => onDelete(s.id)}
                aria-label={`Delete acceptance criterion: ${s.text}`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div className={styles.addArea}>
        <label htmlFor="ac-input" className={styles.srOnly}>New acceptance criterion</label>
        <input
          id="ac-input"
          type="text"
          className={styles.input}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Add acceptance criterion..."
        />
        <div className={styles.addRow}>
          <button
            type="button"
            className={styles.addBtn}
            onClick={handleAdd}
            disabled={!text.trim()}
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
