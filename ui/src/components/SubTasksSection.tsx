import { useState } from 'react';
import type { SubTask } from '../types';
import styles from './SubTasksSection.module.css';

interface SubTasksSectionProps {
  subTasks: SubTask[];
  onAdd: (text: string) => void;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
}

export function SubTasksSection({ subTasks, onAdd, onToggle, onDelete }: SubTasksSectionProps) {
  const [text, setText] = useState('');

  const completed = subTasks.filter((s) => s.completed).length;
  const total = subTasks.length;

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
        Sub-tasks {total > 0 ? `(${completed}/${total})` : ''}
      </h3>

      {total === 0 ? (
        <p className={styles.empty}>No sub-tasks yet.</p>
      ) : (
        <div className={styles.list}>
          {subTasks.map((s) => (
            <div key={s.id} className={styles.row}>
              <input
                type="checkbox"
                className={styles.checkbox}
                checked={s.completed}
                onChange={() => onToggle(s.id)}
                id={`subtask-${s.id}`}
                aria-label={s.text}
              />
              <label
                htmlFor={`subtask-${s.id}`}
                className={s.completed ? styles.textCompleted : styles.text}
              >
                {s.text}
              </label>
              <button
                type="button"
                className={styles.deleteBtn}
                onClick={() => onDelete(s.id)}
                aria-label={`Delete sub-task: ${s.text}`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div className={styles.addArea}>
        <label htmlFor="subtask-input" className={styles.srOnly}>New sub-task</label>
        <input
          id="subtask-input"
          type="text"
          className={styles.input}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Add a sub-task..."
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
