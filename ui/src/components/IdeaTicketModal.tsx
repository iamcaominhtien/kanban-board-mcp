import { useEffect, useRef, useState } from 'react';
import type { IdeaColor, IdeaEnergy, IdeaStatus, IdeaTicket } from '../types';
import styles from './IdeaTicketModal.module.css';

const EMOJIS = [
  '💡','🚀','⚡','🎯','🔥','✨','🌟','💎','🎨','🛠️',
  '📦','🔧','🐛','🎉','🌈','🔮','💬','📈','🏆','🎪',
  '🌍','🔑','🎵','🎸','🎭','🌺','🍀','⭐','🦄','🐉',
  '🌙','☀️','❄️','🌊','🌋','🎠','🎡','🏔️','🗺️','🧩',
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

const ENERGY_OPTIONS: { value: IdeaEnergy; emoji: string; label: string }[] = [
  { value: 'seed',    emoji: '🌱', label: 'Seed' },
  { value: 'concept', emoji: '💡', label: 'Concept' },
  { value: 'hot',     emoji: '🔥', label: 'Hot' },
  { value: 'big_bet', emoji: '🚀', label: 'Big Bet' },
];

const STATUS_META: Record<IdeaStatus, { label: string; bg: string; color: string }> = {
  draft:     { label: '💭 Drafting',   bg: '#F5C518', color: '#3D0C11' },
  in_review: { label: '👀 In Review',  bg: '#5BB8F5', color: '#3D0C11' },
  approved:  { label: '✅ Promoted',   bg: '#AACC2E', color: '#3D0C11' },
  dropped:   { label: '🗑️ Dropped',   bg: '#9CA3AF', color: '#fff' },
};

interface IdeaTicketModalProps {
  ticket: IdeaTicket;
  onClose: () => void;
  onSave: (updated: IdeaTicket) => void;
  onDrop: (id: string) => void;
  onStatusChange: (id: string, status: IdeaStatus) => void;
}

export function IdeaTicketModal({ ticket, onClose, onSave, onDrop, onStatusChange }: IdeaTicketModalProps) {
  const isDraft = ticket.ideaStatus === 'draft';
  const isInReview = ticket.ideaStatus === 'in_review';
  const isEditable = isDraft || isInReview;

  const [title, setTitle] = useState(ticket.title);
  const [description, setDescription] = useState(ticket.description ?? '');
  const [tagsInput, setTagsInput] = useState(ticket.tags.join(', '));
  const [emoji, setEmoji] = useState(ticket.ideaEmoji || '💡');
  const [color, setColor] = useState<IdeaColor>(ticket.ideaColor ?? 'yellow');
  const [energy, setEnergy] = useState<IdeaEnergy | null>(ticket.ideaEnergy ?? null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [visible, setVisible] = useState(false);

  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => { requestAnimationFrame(() => setVisible(true)); }, []);
  useEffect(() => { if (visible) closeBtnRef.current?.focus(); }, [visible]);
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (showEmojiPicker) { setShowEmojiPicker(false); return; }
        onCloseRef.current();
      }
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [showEmojiPicker]);

  function handleSave() {
    const trimmed = title.trim();
    if (!trimmed) return;
    onSave({
      ...ticket,
      title: trimmed,
      description,
      tags: tagsInput.split(',').map(t => t.trim()).filter(Boolean),
      ideaEmoji: emoji,
      ideaColor: color,
      ideaEnergy: energy ?? undefined,
      updatedAt: new Date().toISOString(),
    });
    onClose();
  }

  const accentHex = COLOR_OPTIONS.find(c => c.value === color)?.hex ?? '#F5C518';
  const statusMeta = STATUS_META[ticket.ideaStatus] ?? STATUS_META['draft'];

  return (
    <div
      className={`${styles.overlay} ${visible ? styles.overlayVisible : ''}`}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
    >
      <div className={`${styles.panel} ${visible ? styles.panelVisible : ''}`}>
        {/* Floating close button */}
        <button ref={closeBtnRef} type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close">✕</button>

        {/* Scrollable body */}
        <div className={styles.scrollBody}>
          {/* Cover */}
          <div className={styles.cover} style={{ background: `linear-gradient(135deg, ${accentHex}80, ${accentHex}25)` }}>
            <div className={styles.coverEmojiWrap}>
              <button
                type="button"
                className={styles.coverEmoji}
                onClick={() => isEditable && setShowEmojiPicker(v => !v)}
                style={{ cursor: isEditable ? 'pointer' : 'default' }}
              >
                {emoji}
              </button>
              {showEmojiPicker && isEditable && (
                <div className={styles.emojiPicker}>
                  {EMOJIS.map(e => (
                    <button key={e} type="button"
                      className={`${styles.emojiOption} ${e === emoji ? styles.emojiOptionActive : ''}`}
                      onClick={() => { setEmoji(e); setShowEmojiPicker(false); }}
                    >{e}</button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Content */}
          <div className={styles.content}>
            {/* Status + Title */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <span className={styles.statusPill} style={{ background: statusMeta.bg, color: statusMeta.color }}>
                {statusMeta.label}
              </span>
              <input
                type="text"
                className={styles.titleInput}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                readOnly={!isEditable}
                placeholder="Idea title..."
              />
              <span className={styles.ticketId}>{ticket.id}</span>
            </div>

            {/* Energy */}
            <div>
              <span className={styles.sectionLabel}>Energy Level</span>
              <div className={styles.energyRow}>
                {ENERGY_OPTIONS.map(opt => (
                  <button
                    key={opt.value}
                    type="button"
                    className={`${styles.energyBtn} ${energy === opt.value ? styles.energyBtnActive : ''}`}
                    onClick={() => setEnergy(energy === opt.value ? null : opt.value as IdeaEnergy)}
                    disabled={!isEditable}
                  >
                    {opt.emoji} {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Description */}
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span className={styles.sectionLabel}>Description</span>
              <div className={styles.descField}>
                <textarea
                  className={styles.descTextarea}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  readOnly={!isEditable}
                  placeholder="Scribble your rough thoughts here..."
                />
              </div>
            </div>

            {/* Color */}
            <div>
              <span className={styles.sectionLabel}>Card Color</span>
              <div className={styles.colorRow}>
                {COLOR_OPTIONS.map(c => (
                  <button
                    key={c.value}
                    type="button"
                    className={`${styles.colorDot} ${color === c.value ? styles.colorDotActive : ''}`}
                    style={{ background: c.hex }}
                    onClick={() => setColor(c.value)}
                    disabled={!isEditable}
                    title={c.label}
                    aria-label={c.label}
                  />
                ))}
              </div>
            </div>

            {/* Tags */}
            <div>
              <span className={styles.sectionLabel}>Tags</span>
              {isEditable ? (
                <input
                  type="text"
                  className={styles.tagsInput}
                  value={tagsInput}
                  onChange={(e) => setTagsInput(e.target.value)}
                  placeholder="design, ui, feature (comma-separated)"
                />
              ) : (
                <div className={styles.tagRow}>
                  {ticket.tags.map(t => <span key={t} className={styles.tagPill}>{t}</span>)}
                  {ticket.tags.length === 0 && <span style={{ fontSize: '0.8rem', color: 'rgba(61,12,17,0.4)' }}>No tags</span>}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className={styles.footer}>
          <div className={styles.footerMeta}>
            <span className={styles.footerDate}>
              {ticket.createdAt ? `Created ${new Date(ticket.createdAt).toLocaleDateString()}` : ''}
            </span>
            {isEditable && (
              <button type="button" className={styles.dropBtn} onClick={() => { onDrop(ticket.id); onClose(); }}>
                Drop Idea
              </button>
            )}
          </div>

          <div className={styles.footerActions}>
            {isEditable ? (
              <>
                <button type="button" className={styles.saveBtn} onClick={handleSave}>Save</button>
                {isDraft && (
                  <button type="button" className={styles.actionBtn} onClick={() => { onStatusChange(ticket.id, 'in_review'); onClose(); }}>
                    👀 Send to Review
                  </button>
                )}
                {isInReview && (
                  <button type="button" className={styles.approveBtn} onClick={() => { onStatusChange(ticket.id, 'approved'); onClose(); }}>
                    🚀 Approve & Promote
                  </button>
                )}
              </>
            ) : (
              <button type="button" className={styles.saveBtn} style={{ flex: 1 }} onClick={onClose}>Close</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
