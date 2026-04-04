import { useState } from 'react';
import type { Comment } from '../types';
import styles from './CommentsSection.module.css';

interface CommentsSectionProps {
  comments: Comment[];
  onAdd: (text: string) => void;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function CommentsSection({ comments, onAdd }: CommentsSectionProps) {
  const [text, setText] = useState('');

  function handleAdd() {
    if (!text.trim()) return;
    onAdd(text.trim());
    setText('');
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
              <div className={styles.commentTop}>
                <p className={styles.commentText}>{c.text}</p>
              </div>
              <span className={styles.timestamp}>{formatDate(c.at)}</span>
            </div>
          ))}
        </div>
      )}

      <div className={styles.addArea}>
        <label htmlFor="comment-input" className={styles.srOnly}>New comment</label>
        <textarea
          id="comment-input"
          className={styles.textarea}
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Add a comment..."
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
