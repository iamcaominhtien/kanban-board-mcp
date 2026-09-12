import { useState } from 'react';
import type { Comment } from '../types';
import { MarkdownEditor } from './MarkdownEditor';
import { MarkdownRenderer } from './MarkdownRenderer';
import styles from './CommentsSection.module.css';

interface CommentsSectionProps {
  comments: Comment[];
  onAdd: (text: string) => void;
  onEdit: (id: string, text: string) => void;
  onDelete: (id: string) => void;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function CommentsSection({ comments, onAdd, onEdit, onDelete }: CommentsSectionProps) {
  const [text, setText] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');

  function handleAdd() {
    if (!text.trim()) return;
    onAdd(text.trim());
    setText('');
  }

  function startEdit(comment: Comment) {
    setEditingId(comment.id);
    setEditingText(comment.text);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditingText('');
  }

  function saveEdit(id: string, nextText: string) {
    const trimmed = nextText.trim();
    setEditingId(null);
    setEditingText('');
    if (!trimmed) return;
    onEdit(id, trimmed);
  }

  return (
    <div className={styles.section}>
      <h3 className={styles.sectionHeader}>Comments ({comments.length})</h3>

      {comments.length === 0 ? (
        <p className={styles.empty}>No comments yet.</p>
      ) : (
        <div className={styles.commentList}>
          {comments.map((c) => (
            <div key={c.id} className={styles.comment}>
              {editingId === c.id ? (
                <>
                  <MarkdownEditor
                    value={editingText}
                    onChange={setEditingText}
                    onBlur={(nextText) => saveEdit(c.id, nextText)}
                    startInEditMode
                  />
                  <div className={styles.addRow}>
                    <button
                      type="button"
                      className={styles.actionBtn}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        cancelEdit();
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className={styles.commentTop}>
                    <div className={styles.commentText}>
                      <MarkdownRenderer>{c.text}</MarkdownRenderer>
                    </div>
                    <div className={styles.commentActions}>
                      <button
                        type="button"
                        className={styles.actionBtn}
                        onClick={() => startEdit(c)}
                        aria-label="Edit comment"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className={styles.deleteBtn}
                        onClick={() => onDelete(c.id)}
                        aria-label="Delete comment"
                      >
                        ×
                      </button>
                    </div>
                  </div>
                  <span className={styles.timestamp}>{formatDate(c.at)}</span>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      <div className={styles.addArea}>
        <MarkdownEditor
          value={text}
          onChange={setText}
          placeholderText="Click to add a comment..."
          editAriaLabel="Add a comment"
          viewClassName={styles.composerView}
        />
        <div className={styles.addRow}>
          <button
            type="button"
            className={styles.addBtn}
            onClick={handleAdd}
            disabled={!text.trim()}
          >
            Add Comment
          </button>
        </div>
      </div>
    </div>
  );
}
