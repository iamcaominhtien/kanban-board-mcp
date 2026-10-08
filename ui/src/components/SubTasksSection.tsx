import { useEffect, useRef, useState } from 'react';
import type { SubTask } from '../types';
import styles from './SubTasksSection.module.css';

interface SubTasksSectionProps {
  subTasks: SubTask[];
  onAdd: (text: string) => void;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
}

/**
 * Lightweight checklist inside a ticket. Real child tickets live in SubTicketsSection.
 * @param props.onAdd - Called with the text of a new sub-task.
 * @param props.onToggle - Called with the id of the sub-task whose done state is flipped.
 * @param props.onDelete - Called with the id of the sub-task to delete.
 */
export function SubTasksSection({ subTasks, onAdd, onToggle, onDelete }: SubTasksSectionProps) {
  const [isAdding, setIsAdding] = useState(false);
  const [newText, setNewText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isAdding) inputRef.current?.focus();
  }, [isAdding]);

  const doneCount = subTasks.filter((t) => t.done).length;
  const progressPercent = subTasks.length > 0 ? (doneCount / subTasks.length) * 100 : 0;

  function handleSave() {
    const trimmed = newText.trim();
    if (!trimmed) return;
    onAdd(trimmed);
    setNewText('');
    inputRef.current?.focus();
  }

  function handleCancel() {
    setIsAdding(false);
    setNewText('');
  }

  return (
    <div className={styles.section}>
      <div className={styles.headerRow}>
        <span className={styles.label}>SUB-TASKS</span>
        {subTasks.length > 0 && (
          <>
            <div className={styles.progressBarTrack}>
              <div className={styles.progressBarFill} style={{ width: `${progressPercent}%` }} />
            </div>
            <span className={styles.progressCount}>
              {doneCount}/{subTasks.length}
            </span>
          </>
        )}
      </div>

      {subTasks.length > 0 && (
        <div className={styles.cardContainer}>
          {subTasks.map((item) => (
            <div key={item.id} className={styles.row}>
              <button
                type="button"
                className={styles.checkBtn}
                onClick={() => onToggle(item.id)}
                aria-label={item.done ? 'Mark incomplete' : 'Mark complete'}
              >
                {item.done ? (
                  <svg className={styles.checkDone} viewBox="0 0 14 14" fill="none">
                    <circle cx="7" cy="7" r="6" stroke="#2E6F40" strokeWidth="1.4" />
                    <path
                      d="M4.3 7.2L6.1 9L9.8 5"
                      stroke="#2E6F40"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                ) : (
                  <div className={styles.checkOpen} />
                )}
              </button>
              <span className={item.done ? styles.textDone : styles.text} onClick={() => onToggle(item.id)}>
                {item.text}
              </span>
              <button
                type="button"
                className={styles.removeBtn}
                onClick={() => onDelete(item.id)}
                title="Delete sub-task"
                aria-label="Delete sub-task"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                >
                  <path d="M6 6L18 18" />
                  <path d="M18 6L6 18" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      {isAdding ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className={styles.inputBox}>
            <div className={styles.checkOpen} />
            <input
              ref={inputRef}
              className={styles.inputField}
              placeholder="New sub-task…"
              value={newText}
              onChange={(e) => setNewText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSave();
                if (e.key === 'Escape') handleCancel();
              }}
            />
            <button type="button" className={styles.actionBtnCancel} onClick={handleCancel} aria-label="Cancel">
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <path d="M6 6L18 18" />
                <path d="M18 6L6 18" />
              </svg>
            </button>
            <button type="button" className={styles.actionBtnSave} onClick={handleSave} aria-label="Save sub-task">
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#FFFFFF"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M5 13L10 18L19 6" />
              </svg>
            </button>
          </div>
          <div className={styles.helperText}>Enter to save and add another · Esc to cancel</div>
        </div>
      ) : (
        <button type="button" className={styles.addDashedBtn} onClick={() => setIsAdding(true)}>
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M12 5V19" />
            <path d="M5 12H19" />
          </svg>
          Add sub-task
        </button>
      )}
    </div>
  );
}
