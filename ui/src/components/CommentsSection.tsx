import { useState, useRef } from 'react';
import type { Comment, Member } from '../types/ticket';
import { getAvatarColors } from './MemberAvatar';
import { MarkdownRenderer } from './MarkdownRenderer';
import { MarkdownEditor } from './MarkdownEditor';
import { uploadDescriptionImage } from '../api/tickets';
import styles from './CommentsSection.module.css';

interface CommentsSectionProps {
  comments: Comment[];
  members?: Member[];
  currentMember?: Member | null;
  onAdd: (text: string) => void;
  onEdit: (id: string, text: string) => void;
  onDelete: (id: string) => void;
}

function formatRelativeTime(iso?: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (isNaN(date.getTime())) return String(iso);
  const now = new Date();
  const diffSec = Math.floor((now.getTime() - date.getTime()) / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour === 1) return '1 hour ago';
  if (diffHour < 24) return `${diffHour} hours ago`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay === 1) return 'yesterday';
  if (diffDay < 7) return `${diffDay} days ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function getInitials(name?: string | null): string {
  if (!name || !name.trim()) return 'AN';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function CommentsSection({
  comments,
  members = [],
  currentMember,
  onAdd,
  onEdit,
  onDelete,
}: CommentsSectionProps) {
  const [text, setText] = useState('');
  const [isExpanded, setIsExpanded] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');

  const inputRef = useRef<HTMLInputElement>(null);

  function handleAdd() {
    if (!text.trim()) return;
    onAdd(text.trim());
    setText('');
    setIsExpanded(false);
  }

  function startEdit(comment: Comment) {
    setEditingId(comment.id);
    setEditingText(comment.text);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditingText('');
  }

  function saveEdit(id: string) {
    const trimmed = editingText.trim();
    if (!trimmed) return;
    onEdit(id, trimmed);
    setEditingId(null);
    setEditingText('');
  }

  // Find member info for avatar
  function getMemberInfo(author?: string | null) {
    if (!author) {
      return {
        name: 'Member',
        initials: 'MB',
        bg: '#EEF1EE',
        color: '#5B6B60',
      };
    }
    const found = members.find(
      (m) => m.id === author || m.name.toLowerCase() === author.toLowerCase()
    );
    if (found) {
      const colors = getAvatarColors(found.color);
      return {
        name: found.name,
        initials: getInitials(found.name),
        bg: colors.bg,
        color: colors.color,
      };
    }
    // Default fallback based on name initials ("user" is the GUI's anonymous author)
    const display = author.toLowerCase() === 'user' ? 'You' : author;
    return {
      name: display,
      initials: getInitials(display),
      bg: '#E6E9F5',
      color: '#5B5FA8',
    };
  }

  const currentUserInfo = currentMember
    ? {
        name: currentMember.name,
        initials: getInitials(currentMember.name),
        ...getAvatarColors(currentMember.color),
      }
    : {
        name: 'You',
        initials: 'AN',
        bg: '#DCEEE1',
        color: '#2E6F40',
      };

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>COMMENTS</div>

      {comments.length === 0 ? (
        <p className={styles.empty}>No comments yet.</p>
      ) : (
        <div className={styles.commentList}>
          {comments.map((c) => {
            const authorName = (c as any).author_name || c.author || 'User';
            const memberInfo = getMemberInfo(authorName);
            const timeAgo = formatRelativeTime((c as any).created_at || (c as any).date || c.at);

            return (
              <div key={c.id} className={styles.commentItem}>
                {/* 24x24 Avatar */}
                <div
                  className={styles.commentAvatar}
                  style={{ background: memberInfo.bg, color: memberInfo.color }}
                  title={memberInfo.name}
                >
                  {memberInfo.initials}
                </div>

                {/* Content */}
                {editingId === c.id ? (
                  <div className={styles.editBox}>
                    <MarkdownEditor
                      value={editingText}
                      onChange={setEditingText}
                      startInEditMode={true}
                      disableClickOutside={true}
                      compact={true}
                      placeholderText="Edit comment… (Markdown supported)"
                      onUploadImage={async (f: File) => {
                        const res = await uploadDescriptionImage(f);
                        return { markdown: `![${f.name}](${res.url})` };
                      }}
                      onSubmit={() => saveEdit(c.id)}
                      onCancel={cancelEdit}
                      actions={
                        <>
                          <button
                            type="button"
                            className={styles.btnCancel}
                            onClick={cancelEdit}
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            className={styles.btnSubmit}
                            onClick={() => saveEdit(c.id)}
                            disabled={!editingText.trim()}
                          >
                            Save
                          </button>
                        </>
                      }
                    />
                  </div>
                ) : (
                  <div className={styles.commentContent}>
                    <div className={styles.commentHeader}>
                      <span className={styles.authorName}>{memberInfo.name}</span>
                      <span className={styles.bullet}>•</span>
                      <span className={styles.timestamp}>{timeAgo}</span>

                      {/* Edit / Delete actions on hover */}
                      <div className={styles.commentActions}>
                        <button
                          type="button"
                          className={styles.actionBtn}
                          onClick={() => startEdit(c)}
                          title="Edit comment"
                          aria-label="Edit comment"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 20h9" />
                            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          className={`${styles.actionBtn} ${styles.deleteBtn}`}
                          onClick={() => onDelete(c.id)}
                          title="Delete comment"
                          aria-label="Delete comment"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        </button>
                      </div>
                    </div>
                    <div className={styles.commentBody}>
                      <MarkdownRenderer>{c.text}</MarkdownRenderer>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Add Comment Row matching TicketDetail.dc.html */}
      <div className={styles.composerRow}>
        <div
          className={styles.commentAvatar}
          style={{ background: currentUserInfo.bg, color: currentUserInfo.color }}
          title={currentUserInfo.name}
        >
          {currentUserInfo.initials}
        </div>

        <div className={isExpanded ? styles.composerBoxExpanded : styles.composerBox}>
          {isExpanded ? (
            <MarkdownEditor
              value={text}
              onChange={setText}
              startInEditMode={true}
              disableClickOutside={true}
              compact={true}
              placeholderText="Add a comment… (Markdown supported)"
              onUploadImage={async (f: File) => {
                const res = await uploadDescriptionImage(f);
                return { markdown: `![${f.name}](${res.url})` };
              }}
              onSubmit={handleAdd}
              onCancel={() => {
                setText('');
                setIsExpanded(false);
              }}
              actions={
                <>
                  <button
                    type="button"
                    className={styles.btnCancel}
                    onClick={() => {
                      setText('');
                      setIsExpanded(false);
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className={styles.btnSubmit}
                    onClick={handleAdd}
                    disabled={!text.trim()}
                  >
                    Comment
                  </button>
                </>
              }
            />
          ) : (
            <input
              ref={inputRef}
              type="text"
              className={styles.collapsedInput}
              placeholder="Add a comment…"
              value={text}
              onFocus={() => setIsExpanded(true)}
              onClick={() => setIsExpanded(true)}
              readOnly
            />
          )}
        </div>
      </div>
    </div>
  );
}
