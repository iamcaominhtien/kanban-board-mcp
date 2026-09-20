import { useEffect, useRef, useState } from 'react';
import type { AcceptanceCriterion } from '../types';
import styles from './AcceptanceCriteriaSection.module.css';

interface AcceptanceCriteriaSectionProps {
  acceptanceCriteria: AcceptanceCriterion[];
  onAdd: (text: string) => void;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
  // Optional: lets the parent implement "edit" without changing the add/toggle/delete
  // signatures above. See TicketModal's handleEditAC for why this is a delete+add
  // (rather than a single PATCH) under the hood.
  onEdit?: (id: string, newText: string) => void;
}

type RowMode = { kind: 'view' } | { kind: 'edit' } | { kind: 'confirm-delete' };

export function AcceptanceCriteriaSection({
  acceptanceCriteria,
  onAdd,
  onToggle,
  onDelete,
  onEdit,
}: AcceptanceCriteriaSectionProps) {
  const [adding, setAdding] = useState(false);
  const [addText, setAddText] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

  const addInputRef = useRef<HTMLInputElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  const completed = acceptanceCriteria.filter((s) => s.done).length;
  const total = acceptanceCriteria.length;

  useEffect(() => {
    if (adding) addInputRef.current?.focus();
  }, [adding]);

  useEffect(() => {
    if (editingId) editInputRef.current?.focus();
  }, [editingId]);

  function modeOf(id: string): RowMode['kind'] {
    if (editingId === id) return 'edit';
    if (confirmDeleteId === id) return 'confirm-delete';
    return 'view';
  }

  function openAdd() {
    setAdding(true);
    setAddText('');
  }

  function closeAdd() {
    setAdding(false);
    setAddText('');
  }

  function handleAddSave() {
    const trimmed = addText.trim();
    if (!trimmed) return;
    onAdd(trimmed);
    // Keep the row open/cleared so the person can immediately add another,
    // matching the mockup's "Enter to save and add another" helper text.
    setAddText('');
    addInputRef.current?.focus();
  }

  function handleAddKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') handleAddSave();
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeAdd();
    }
  }

  function openEdit(criterion: AcceptanceCriterion) {
    setEditingId(criterion.id);
    setEditText(criterion.text);
  }

  function closeEdit() {
    setEditingId(null);
    setEditText('');
  }

  function handleEditSave(id: string) {
    const trimmed = editText.trim();
    if (!trimmed) return;
    onEdit?.(id, trimmed);
    setEditingId(null);
    setEditText('');
  }

  function handleEditKeyDown(e: React.KeyboardEvent<HTMLInputElement>, id: string) {
    if (e.key === 'Enter') handleEditSave(id);
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeEdit();
    }
  }

  function openDeleteConfirm(id: string) {
    setConfirmDeleteId(id);
  }

  function cancelDeleteConfirm() {
    setConfirmDeleteId(null);
  }

  function confirmDelete(id: string) {
    onDelete(id);
    setConfirmDeleteId(null);
  }

  return (
    <div className={styles.section}>
      <h3 className={styles.sectionHeader}>
        Acceptance Criteria {total > 0 ? `(${completed}/${total})` : ''}
      </h3>

      {total === 0 && !adding ? (
        <p className={styles.empty}>No acceptance criteria yet.</p>
      ) : (
        <div className={styles.list}>
          {acceptanceCriteria.map((s) => {
            const mode = modeOf(s.id);

            if (mode === 'edit') {
              return (
                <div key={s.id} className={styles.editRow}>
                  <span
                    className={s.done ? styles.checkboxPlaceholderDone : styles.checkboxPlaceholder}
                    aria-hidden="true"
                  />
                  <input
                    ref={editInputRef}
                    type="text"
                    className={styles.inlineInput}
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    onKeyDown={(e) => handleEditKeyDown(e, s.id)}
                    aria-label="Edit acceptance criterion"
                  />
                  <button
                    type="button"
                    className={styles.iconBtnCancel}
                    onClick={() => closeEdit()}
                    aria-label="Cancel edit"
                    title="Cancel"
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <path d="M6 6L18 18" />
                      <path d="M18 6L6 18" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className={styles.iconBtnSave}
                    onClick={() => handleEditSave(s.id)}
                    disabled={!editText.trim()}
                    aria-label="Save edit"
                    title="Save"
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 13L10 18L19 6" />
                    </svg>
                  </button>
                </div>
              );
            }

            if (mode === 'confirm-delete') {
              return (
                <div key={s.id} className={styles.confirmRow}>
                  <span className={styles.confirmCheckboxPlaceholder} aria-hidden="true" />
                  <span className={styles.confirmText}>{s.text}</span>
                  <button
                    type="button"
                    className={styles.confirmCancelBtn}
                    onClick={() => cancelDeleteConfirm()}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className={styles.confirmDeleteBtn}
                    onClick={() => confirmDelete(s.id)}
                  >
                    Delete
                  </button>
                </div>
              );
            }

            return (
              <div key={s.id} className={styles.row}>
                <input
                  type="checkbox"
                  className={styles.checkbox}
                  checked={s.done}
                  onChange={() => onToggle(s.id)}
                  id={`ac-${s.id}`}
                  aria-label={s.text}
                />
                <label
                  htmlFor={`ac-${s.id}`}
                  className={s.done ? styles.textCompleted : styles.text}
                >
                  {s.text}
                </label>
                <span className={styles.rowActions}>
                  <button
                    type="button"
                    className={styles.iconBtn}
                    onClick={() => openEdit(s)}
                    aria-label={`Edit acceptance criterion: ${s.text}`}
                    title="Edit"
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 20H21" />
                      <path d="M16.5 3.5C17.3 2.7 18.6 2.7 19.4 3.5C20.2 4.3 20.2 5.6 19.4 6.4L7 18.8L3 19.8L4 15.8L16.5 3.5Z" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className={styles.iconBtn}
                    onClick={() => openDeleteConfirm(s.id)}
                    aria-label={`Delete acceptance criterion: ${s.text}`}
                    title="Delete"
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M4 7H20" />
                      <path d="M9 7V4.5C9 3.7 9.7 3 10.5 3H13.5C14.3 3 15 3.7 15 4.5V7" />
                      <path d="M6 7L7 20.5C7 21.3 7.7 22 8.5 22H15.5C16.3 22 17 21.3 17 20.5L18 7" />
                    </svg>
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      )}

      <div className={styles.addArea}>
        {!adding && (
          <button type="button" className={styles.addBtn} onClick={openAdd}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M12 5V19" />
              <path d="M5 12H19" />
            </svg>
            Add criterion
          </button>
        )}

        {adding && (
          <>
            <div className={styles.editRow}>
              <span className={styles.checkboxPlaceholder} aria-hidden="true" />
              <input
                ref={addInputRef}
                type="text"
                className={styles.inlineInput}
                value={addText}
                onChange={(e) => setAddText(e.target.value)}
                onKeyDown={handleAddKeyDown}
                placeholder="New criterion…"
                aria-label="New acceptance criterion"
              />
              <button
                type="button"
                className={styles.iconBtnCancel}
                onClick={closeAdd}
                aria-label="Cancel"
                title="Cancel"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M6 6L18 18" />
                  <path d="M18 6L6 18" />
                </svg>
              </button>
              <button
                type="button"
                className={styles.iconBtnSave}
                onClick={handleAddSave}
                disabled={!addText.trim()}
                aria-label="Save"
                title="Save"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 13L10 18L19 6" />
                </svg>
              </button>
            </div>
            <span className={styles.helperText}>Enter to save and add another · Esc to cancel</span>
          </>
        )}
      </div>
    </div>
  );
}
