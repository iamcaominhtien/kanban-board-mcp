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

  type IdeaEnergy = 'seed' | 'concept' | 'hot' | 'big_bet';
  const ENERGY_OPTIONS = [
    { value: 'seed',    emoji: '🌱', label: 'Seed' },
    { value: 'concept', emoji: '💡', label: 'Concept' },
    { value: 'hot',     emoji: '🔥', label: 'Hot' },
    { value: 'big_bet', emoji: '🚀', label: 'Big Bet' },
  ];
  const [energy, setEnergy] = useState<IdeaEnergy | null>(
    (ticket as IdeaTicket & { ideaEnergy?: IdeaEnergy }).ideaEnergy ?? null
  );

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
      <div className={`${styles.modal} ${visible ? styles.modalVisible : ''}`}>
        {/* Floating close button left of panel */}
        <button
          ref={closeBtnRef}
          type="button"
          className={styles.closeBtn}
          onClick={onClose}
          aria-label="Close"
        >
          ✕
        </button>

        {/* Scrollable content */}
        <div className={styles.scrollBody}>
          {/* Cover */}
          <div
            className={styles.cover}
            style={{ background: `linear-gradient(135deg, ${accentHex}60, ${accentHex}20)` }}
          >
            <div className={styles.coverEmoji} style={{ position: 'relative', overflow: isDraft ? 'visible' : 'hidden' }}>
              <button
                type="button"
                style={{ background: 'none', border: 'none', padding: 0, cursor: isDraft ? 'pointer' : 'default', fontSize: '2.5rem', lineHeight: 1 }}
                onClick={() => isDraft && setShowEmojiPicker(v => !v)}
                disabled={!isDraft}
                aria-label="Pick emoji"
              >
                {emoji}
              </button>
              {showEmojiPicker && isDraft && (
                <div className={styles.emojiPickerWrapper}>
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
                </div>
              )}
            </div>
          </div>

          {/* Content */}
          <div className={styles.content}>
            {/* Status + Title */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <span
                className={styles.statusPill}
                style={{ background: statusStyle.bg, color: statusStyle.color }}
              >
                {STATUS_LABELS[ticket.ideaStatus] ?? 'Draft'}
              </span>
              <input
                type="text"
                className={styles.titleInput}
                value={title}
                onChange={(e) => isDraft && setTitle(e.target.value)}
                readOnly={!isDraft}
                placeholder="Idea title..."
              />
              <span className={styles.ticketId}>{ticket.id}</span>
            </div>

            {/* Energy level */}
            <div>
              <span className={styles.sectionLabel}>Energy Level</span>
              <div className={styles.energyRow}>
                {ENERGY_OPTIONS.map(opt => (
                  <button
                    key={opt.value}
                    type="button"
                    className={`${styles.energyBtn} ${energy === opt.value ? styles.energyBtnActive : ''}`}
                    onClick={() => isDraft && setEnergy(opt.value as IdeaEnergy)}
                    disabled={!isDraft}
                  >
                    {opt.emoji} {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Description */}
            <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
              <span className={styles.sectionLabel}>Description</span>
              <div className={styles.descField}>
                <textarea
                  className={styles.descTextarea}
                  value={description}
                  onChange={(e) => isDraft && setDescription(e.target.value)}
                  readOnly={!isDraft}
                  placeholder="Scribble your rough thoughts here..."
                />
              </div>
            </div>

            {/* Color picker */}
            <div>
              <span className={styles.sectionLabel}>Card Color</span>
              <div className={styles.colorRow}>
                {COLOR_OPTIONS.map(c => (
                  <button
                    key={c.value}
                    type="button"
                    className={`${styles.colorDot} ${color === c.value ? styles.colorDotActive : ''}`}
                    style={{ background: c.hex }}
                    onClick={() => isDraft && setColor(c.value)}
                    disabled={!isDraft}
                    title={c.label}
                    aria-label={c.label}
                  />
                ))}
              </div>
            </div>

            {/* Tags */}
            <div>
              <span className={styles.sectionLabel}>Tags</span>
              {isDraft ? (
                <input
                  type="text"
                  className={styles.tagsInput}
                  value={tagsInput}
                  onChange={(e) => setTagsInput(e.target.value)}
                  placeholder="Add tags, comma-separated"
                />
              ) : (
                <div className={styles.tagRow}>
                  {ticket.tags.map(t => (
                    <span key={t} className={styles.tagPill}>{t}</span>
                  ))}
                </div>
              )}
            </div>

            {/* Promote confirm box (approved state) */}
            {isApproved && showPromoteConfirm && (
              <div className={styles.promoteBox}>
                <p>This will promote the idea to a proper ticket on the main board. Continue?</p>
                <div style={{ display: 'flex', gap: '10px' }}>
                  <button type="button" className={styles.promoteConfirmBtn} onClick={handleConfirmPromote} disabled={isPromotionPending}>
                    {isPromotionPending ? 'Promoting...' : '🚀 Yes, promote!'}
                  </button>
                  <button type="button" className={styles.promoteCancelBtn} onClick={() => setShowPromoteConfirm(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* Error */}
            {error && <div className={styles.error}>{error}</div>}
          </div>
        </div>

        {/* Footer */}
        <div className={styles.footer}>
          <div className={styles.footerMeta}>
            <div className={styles.footerDate}>
              Created: {ticket.createdAt ? new Date(ticket.createdAt).toLocaleDateString() : '—'}
            </div>
            {!isDropped && !isApproved && (
              <button type="button" className={styles.dropBtn} onClick={handleDrop}>
                Drop Idea
              </button>
            )}
          </div>

          <div className={styles.footerActions}>
            {isDraft && (
              <>
                <button type="button" className={styles.saveBtn} onClick={handleSave} disabled={updateMutation.isPending}>
                  {updateMutation.isPending ? 'Saving...' : 'Save'}
                </button>
                <button type="button" className={styles.approveBtn} onClick={handleApprove} disabled={updateMutation.isPending}>
                  ✅ Approve
                </button>
              </>
            )}
            {isApproved && (
              <>
                <button type="button" className={styles.saveBtn} onClick={onClose}>
                  Close
                </button>
                <button
                  type="button"
                  className={styles.approveBtn}
                  onClick={() => setShowPromoteConfirm(true)}
                  disabled={isPromotionPending}
                >
                  🚀 Promote to Board
                </button>
              </>
            )}
            {isDropped && (
              <button type="button" className={styles.saveBtn} style={{ flex: 1 }} onClick={onClose}>
                Close
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
