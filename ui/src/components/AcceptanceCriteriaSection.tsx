import { useState, useRef, useEffect, useMemo } from 'react';
import type { AcceptanceCriterion } from '../types';
import { MarkdownRenderer } from './MarkdownRenderer';
import { TicketRefSuggester } from './docs/RefSuggester';
import { textareaAdapter } from './ai/editor/adapters';
import { EditorAiSelectionBar, useEditorAi } from './ai/editor/useEditorAi';
import styles from './AcceptanceCriteriaSection.module.css';

interface AcceptanceCriteriaSectionProps {
  acceptanceCriteria: AcceptanceCriterion[];
  onAdd: (text: string) => void;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
  /** AI on the criteria (Improve, Split, Draft more): the project and ticket they belong to. Left out, no AI. */
  ai?: { projectId: string; ticketId: string };
}

/**
 * Ticket's acceptance-criteria checklist, with doc-reference pills.
 * @param props.onAdd - Called with the text of a new criterion.
 * @param props.onToggle - Called with the id of the criterion whose done state is flipped.
 * @param props.onDelete - Called with the id of the criterion to delete.
 * @param props.ai - Turns on AI help (Improve, Split, Draft more) for the criteria of this ticket.
 */
export function AcceptanceCriteriaSection({
  acceptanceCriteria,
  onAdd,
  onToggle,
  onDelete,
  ai: aiProp,
}: AcceptanceCriteriaSectionProps) {
  const [isAdding, setIsAdding] = useState(false);
  const [newText, setNewText] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

  const addInputRef = useRef<HTMLInputElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  // AI on the criterion being written or edited: Improve, Split; "Draft more" asks for criteria that are missing
  const sectionRef = useRef<HTMLDivElement>(null);
  const aiAdapter = useMemo(
    () =>
      textareaAdapter(
        () => editInputRef.current ?? addInputRef.current,
        () => sectionRef.current,
      ),
    [],
  );
  const editingRef = useRef<string | null>(null);
  editingRef.current = editingId;
  const editorAi = useEditorAi({
    surface: 'acceptance_criteria',
    projectId: aiProp?.projectId,
    ticketId: aiProp?.ticketId,
    adapter: aiAdapter,
    enabled: !!aiProp,
    onAccepted: (action) => {
      // a split criterion is replaced by the smaller ones
      if (action === 'split' && editingRef.current) {
        onDelete(editingRef.current);
        setEditingId(null);
      }
    },
  });

  useEffect(() => {
    if (isAdding) {
      addInputRef.current?.focus();
    }
  }, [isAdding]);

  useEffect(() => {
    if (editingId) {
      editInputRef.current?.focus();
    }
  }, [editingId]);

  function handleSaveNew() {
    if (newText.trim()) {
      onAdd(newText.trim());
      setNewText('');
      // Keep input open for rapid consecutive entry
      addInputRef.current?.focus();
    }
  }

  function handleCancelNew() {
    setIsAdding(false);
    setNewText('');
  }

  function startEdit(item: AcceptanceCriterion) {
    setEditingId(item.id);
    setEditText(item.text);
  }

  function handleSaveEdit(id: string) {
    if (editText.trim() && editText.trim() !== acceptanceCriteria.find((c) => c.id === id)?.text) {
      // Delete old & re-add, or if there's an update API
      // Since backend currently has add/toggle/delete, we delete and re-add or toggle as needed
      onDelete(id);
      onAdd(editText.trim());
    }
    setEditingId(null);
  }

  function handleCancelEdit() {
    setEditingId(null);
  }

  return (
    <div className={styles.section} ref={sectionRef}>
      <div className={styles.label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span>Acceptance Criteria</span>
        {aiProp && editorAi.available && (
          <button
            type="button"
            data-testid="ac-draft-more"
            title="Draft more criteria with AI"
            onClick={() => editorAi.run('more_criteria')}
            style={{
              border: '1px solid #D9D1F6',
              background: '#F6F3FE',
              color: '#5A3FD0',
              borderRadius: 999,
              padding: '1px 9px',
              fontFamily: 'inherit',
              fontSize: 11.5,
              fontWeight: 600,
              cursor: 'pointer',
              textTransform: 'none',
              letterSpacing: 0,
            }}
          >
            ✦ Draft more
          </button>
        )}
      </div>
      {editorAi.layer}
      {aiProp && <EditorAiSelectionBar ai={editorAi} adapter={aiAdapter} />}

      <div className={styles.list}>
        {acceptanceCriteria.map((item) => {
          if (editingId === item.id) {
            return (
              <div key={item.id} className={styles.inputBox}>
                <div className={styles.uncheckedSquare} />
                <input
                  ref={editInputRef}
                  className={styles.inputField}
                  value={editText}
                  data-ai-editor={aiProp ? true : undefined}
                  onChange={(e) => {
                    setEditText(e.target.value);
                    editorAi.onInput();
                  }}
                  onKeyDown={(e) => {
                    if (editorAi.onKeyDown(e)) {
                      e.preventDefault();
                      e.stopPropagation();
                      return;
                    }
                    if (e.key === 'Enter') handleSaveEdit(item.id);
                    if (e.key === 'Escape') handleCancelEdit();
                  }}
                />
                <TicketRefSuggester targetRef={editInputRef} />
                <button
                  type="button"
                  className={styles.actionBtnCancel}
                  onClick={handleCancelEdit}
                  aria-label="Cancel edit"
                >
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
                <button
                  type="button"
                  className={styles.actionBtnSave}
                  onClick={() => handleSaveEdit(item.id)}
                  aria-label="Save criterion"
                >
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
            );
          }

          return (
            <div key={item.id} className={styles.row}>
              <button
                type="button"
                className={styles.checkboxBtn}
                onClick={() => onToggle(item.id)}
                aria-label={item.done ? 'Mark incomplete' : 'Mark complete'}
              >
                {item.done ? (
                  <svg className={styles.checkedCircle} viewBox="0 0 14 14" fill="none">
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
                  <div className={styles.uncheckedSquare} />
                )}
              </button>

              <span
                className={item.done ? styles.textCompleted : styles.text}
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest('.dk-chip')) return;
                  onToggle(item.id);
                }}
              >
                <MarkdownRenderer inline>{item.text}</MarkdownRenderer>
              </span>

              <div className={styles.rowActions}>
                <button
                  type="button"
                  className={styles.iconBtn}
                  onClick={() => startEdit(item)}
                  aria-label="Edit criterion"
                >
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 20H21" />
                    <path d="M16.5 3.5C17.3 2.7 18.6 2.7 19.4 3.5C20.2 4.3 20.2 5.6 19.4 6.4L7 18.8L3 19.8L4 15.8L16.5 3.5Z" />
                  </svg>
                </button>
                <button
                  type="button"
                  className={`${styles.iconBtn} ${styles.iconBtnDelete}`}
                  onClick={() => onDelete(item.id)}
                  aria-label="Delete criterion"
                >
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M4 7H20" />
                    <path d="M9 7V4.5C9 3.7 9.7 3 10.5 3H13.5C14.3 3 15 3.7 15 4.5V7" />
                    <path d="M6 7L7 20.5C7 21.3 7.7 22 8.5 22H15.5C16.3 22 17 21.3 17 20.5L18 7" />
                  </svg>
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {isAdding ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className={styles.inputBox}>
            <div className={styles.uncheckedSquare} />
            <input
              ref={addInputRef}
              className={styles.inputField}
              placeholder="New criterion…"
              value={newText}
              data-ai-editor={aiProp ? true : undefined}
              onChange={(e) => {
                setNewText(e.target.value);
                editorAi.onInput();
              }}
              onKeyDown={(e) => {
                if (editorAi.onKeyDown(e)) {
                  e.preventDefault();
                  e.stopPropagation();
                  return;
                }
                if (e.key === 'Enter') handleSaveNew();
                if (e.key === 'Escape') handleCancelNew();
              }}
            />
            <TicketRefSuggester targetRef={addInputRef} />
            <button type="button" className={styles.actionBtnCancel} onClick={handleCancelNew} aria-label="Cancel">
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
            <button type="button" className={styles.actionBtnSave} onClick={handleSaveNew} aria-label="Save">
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
          Add criterion
        </button>
      )}
    </div>
  );
}
