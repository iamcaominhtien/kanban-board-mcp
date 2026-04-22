import { useEffect, useRef, useState } from 'react';
import type { IdeaColor, IdeaStatus, IdeaTicket } from '../types';
import { useUpdateIdeaTicket, useDropIdeaTicket, usePromoteIdeaTicket } from '../api/useIdeaTickets';
import { extractError } from '../api/extractError';
import styles from './IdeaTicketModal.module.css';

function parseTagsInput(value: string) {
  return value.split(',').map(tag => tag.trim()).filter(Boolean);
}

const EMOJIS = [
  '💡','🚀','⚡','🎯','🔥','✨','🌟','💎','🎨','🛠️',
  '📦','🔧','🐛','🎉','🌈','🔮','💬','📈','🏆','🎪',
  '🌍','🔑','🎵','🎸','🎭','🌺','🍀','⭐','🦄','🐉',
  '🌙','☀️','❄️','🌊','🌋','🎠','🎡','🏔️','🗺️','🧩',
  '🔐','📝','💻','🖥️','📱','🎮','🕹️','🎲','🃏','🧪',
];

const COLOR_OPTIONS: { value: IdeaColor; hex: string; label: string }[] = [
  { value: 'yellow', hex: '#F5C518', label: 'Yellow' },
  { value: 'orange', hex: '#E8441A', label: 'Orange' },
  { value: 'lime',   hex: '#AACC2E', label: 'Lime' },
  { value: 'pink',   hex: '#F472B6', label: 'Pink' },
  { value: 'blue',   hex: '#5BB8F5', label: 'Blue' },
  { value: 'purple', hex: '#8B5CF6', label: 'Purple' },
  { value: 'teal',   hex: '#14B8A6', label: 'Teal' },
];

const STATUS_LABELS: Record<IdeaStatus, string> = {
  draft: 'Draft',
  approved: 'Approved',
  dropped: 'Dropped',
};

const STATUS_COLORS: Record<IdeaStatus, { bg: string; color: string }> = {
  draft:    { bg: '#F5C518', color: '#3D0C11' },
  approved: { bg: '#AACC2E', color: '#3D0C11' },
  dropped:  { bg: '#9CA3AF', color: 'white' },
};

interface IdeaTicketModalProps {
  ticket: IdeaTicket;
  projectId: string;
  onClose: () => void;
}

export function IdeaTicketModal({ ticket, projectId, onClose }: IdeaTicketModalProps) {
  const isDraft = ticket.ideaStatus === 'draft';
  const isApproved = ticket.ideaStatus === 'approved';
  const isDropped = ticket.ideaStatus === 'dropped';

  const [title, setTitle] = useState(ticket.title);
  const [description, setDescription] = useState(ticket.description ?? '');
  const [tagsInput, setTagsInput] = useState(ticket.tags.join(', '));
  const [emoji, setEmoji] = useState(ticket.ideaEmoji || '💡');
  const [color, setColor] = useState<IdeaColor>(ticket.ideaColor ?? 'yellow');
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showPromoteConfirm, setShowPromoteConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);

  const updateMutation = useUpdateIdeaTicket(projectId);
  const dropMutation = useDropIdeaTicket(projectId);
  const promoteIdeaTicketMutation = usePromoteIdeaTicket(projectId);
  const isPromotionPending = promoteIdeaTicketMutation.isPending;

  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  const closeBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
  }, []);

  useEffect(() => {
    if (visible) {
      closeBtnRef.current?.focus();
    }
  }, [visible]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (showEmojiPicker) { setShowEmojiPicker(false); return; }
        if (showPromoteConfirm) { setShowPromoteConfirm(false); return; }
        onCloseRef.current();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [showEmojiPicker, showPromoteConfirm]);

  async function runActionAndClose(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      onClose();
    } catch (err) {
      setError(extractError(err));
    }
  }

  async function handleSave() {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) { setError('Title is required.'); return; }

    await runActionAndClose(() => updateMutation.mutateAsync({
        ticketId: ticket.id,
        data: {
          title: trimmedTitle,
          description,
          tags: parseTagsInput(tagsInput),
          ideaEmoji: emoji,
          ideaColor: color,
        },
      }));
  }

  async function handleApprove() {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) { setError('Title is required.'); return; }
    await runActionAndClose(() => updateMutation.mutateAsync({
        ticketId: ticket.id,
        data: {
          ideaStatus: 'approved',
          title: trimmedTitle,
          description,
          tags: parseTagsInput(tagsInput),
          ideaEmoji: emoji,
          ideaColor: color,
        },
      }));
  }

  async function handleDrop() {
    await runActionAndClose(() => dropMutation.mutateAsync(ticket.id));
  }

  // In approved state, all fields are read-only — ticket prop reflects server state
  // No need to save edits before promote
  async function handleConfirmPromote() {
    await runActionAndClose(() =>
      promoteIdeaTicketMutation.mutateAsync(ticket.id)
    );
  }

  const accentHex = COLOR_OPTIONS.find(c => c.value === color)?.hex ?? '#F5C518';
  const statusStyle = STATUS_COLORS[ticket.ideaStatus] ?? STATUS_COLORS.draft;

  return (
    <div
      className={`${styles.overlay} ${visible ? styles.overlayVisible : ''}`}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-label={`Idea: ${ticket.title}`}
    >
      <div className={`${styles.modal} ${visible ? styles.modalVisible : ''}`} style={{ borderTopColor: accentHex }}>
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <span className={styles.ticketId}>{ticket.id}</span>
            <span
              className={styles.statusPill}
              style={{ background: statusStyle.bg, color: statusStyle.color }}
            >
              {STATUS_LABELS[ticket.ideaStatus] ?? 'Draft'}
            </span>
          </div>
          <button ref={closeBtnRef} type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close">×</button>
        </div>

        {/* Emoji + Color row */}
        <div className={styles.emojiColorRow}>
          <div className={styles.emojiWrapper}>
            <button
              type="button"
              className={styles.emojiBtn}
              onClick={() => isDraft && setShowEmojiPicker(v => !v)}
              disabled={!isDraft}
              aria-label="Pick emoji"
              title={isDraft ? 'Click to change emoji' : undefined}
            >
              {emoji}
            </button>
            {showEmojiPicker && isDraft && (
              <div className={styles.emojiPicker}>
                {EMOJIS.map(e => (
                  <button
                    key={e}
                    type="button"
                    className={`${styles.emojiOption} ${e === emoji ? styles.emojiOptionActive : ''}`}
                    onClick={() => { setEmoji(e); setShowEmojiPicker(false); }}
                  >
                    {e}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className={styles.colorSwatches}>
            {COLOR_OPTIONS.map(c => (
              <button
                key={c.value}
                type="button"
                className={`${styles.colorSwatch} ${c.value === color ? styles.colorSwatchActive : ''}`}
                style={{ background: c.hex }}
                onClick={() => isDraft && setColor(c.value)}
                disabled={!isDraft}
                aria-label={c.label}
                title={c.label}
              />
            ))}
          </div>
        </div>

        {/* Title */}
        <div className={styles.field}>
          {isDraft ? (
            <input
              className={styles.titleInput}
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Idea title…"
            />
          ) : (
            <h2 className={styles.titleReadOnly}>{ticket.title}</h2>
          )}
        </div>

        {/* Description */}
        <div className={styles.field}>
          <label className={styles.fieldLabel}>Description</label>
          {isDraft ? (
            <textarea
              className={styles.descTextarea}
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Describe the idea…"
              rows={4}
            />
          ) : (
            <p className={styles.descReadOnly}>
              {ticket.description || <span className={styles.empty}>No description.</span>}
            </p>
          )}
        </div>

        {/* Tags */}
        <div className={styles.field}>
          <label className={styles.fieldLabel}>Tags</label>
          {isDraft ? (
            <input
              className={styles.tagsInput}
              value={tagsInput}
              onChange={e => setTagsInput(e.target.value)}
              placeholder="tag1, tag2…"
            />
          ) : (
            <div className={styles.tagsReadOnly}>
              {ticket.tags.length > 0
                ? ticket.tags.map(tag => <span key={tag} className={styles.tag}>{tag}</span>)
                : <span className={styles.empty}>No tags.</span>}
            </div>
          )}
        </div>

        {/* Error */}
        {error && <p className={styles.error}>{error}</p>}

        {/* Promote confirm panel */}
        {showPromoteConfirm && (
          <div className={styles.promotePanel}>
            <p className={styles.promotePanelTitle}>Promote to Board</p>
            <p className={styles.promotePanelDesc}>
              A new ticket will be created in <strong>Backlog</strong> with this idea's title and description. The idea will be marked as dropped.
            </p>
            <div className={styles.promotePreview}>
              <span className={styles.promotePreviewLabel}>Title:</span>
              <span>{ticket.title}</span>
            </div>
            <div className={styles.promoteBtns}>
              <button
                type="button"
                className={styles.btnConfirmPromote}
                onClick={handleConfirmPromote}
                disabled={isPromotionPending}
              >
                {isPromotionPending ? 'Creating…' : 'Confirm Promotion'}
              </button>
              <button type="button" className={styles.btnCancel} onClick={() => setShowPromoteConfirm(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Footer buttons */}
        {!showPromoteConfirm && (
          <div className={styles.footer}>
            {isDraft && (
              <>
                <button
                  type="button"
                  className={styles.btnPrimary}
                  onClick={handleSave}
                  disabled={updateMutation.isPending}
                >
                  {updateMutation.isPending ? 'Saving…' : 'Save'}
                </button>
                <button
                  type="button"
                  className={styles.btnApprove}
                  onClick={handleApprove}
                  disabled={updateMutation.isPending}
                >
                  Approve
                </button>
                <button
                  type="button"
                  className={styles.btnDanger}
                  onClick={handleDrop}
                  disabled={dropMutation.isPending}
                >
                  Drop
                </button>
              </>
            )}
            {isApproved && (
              <>
                <button
                  type="button"
                  className={styles.btnPromote}
                  onClick={() => setShowPromoteConfirm(true)}
                >
                  🚀 Promote to Board
                </button>
                <button
                  type="button"
                  className={styles.btnDanger}
                  onClick={handleDrop}
                  disabled={dropMutation.isPending}
                >
                  Drop
                </button>
                <button type="button" className={styles.btnCancel} onClick={onClose}>
                  Close
                </button>
              </>
            )}
            {isDropped && (
              <button type="button" className={styles.btnCancel} onClick={onClose}>
                Close
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
