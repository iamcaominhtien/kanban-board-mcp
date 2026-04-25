import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import type { IdeaAssumption, IdeaAssumptionStatus, IdeaColor, IdeaEnergy, IdeaMicrothought, IdeaStatus, IdeaTicket } from '../types';
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

const ASSUMPTION_STATUS_ORDER: IdeaAssumptionStatus[] = ['untested', 'validated', 'invalidated'];

function normalizeTags(input: string): string[] {
  return input.split(',').map((tag) => tag.trim()).filter(Boolean);
}

function clampIceScore(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(5, Math.max(1, value));
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

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
  const [editingTags, setEditingTags] = useState(false);
  const [visible, setVisible] = useState(false);
  const [previewMode, setPreviewMode] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  // Feature 2 — Microthoughts
  const [microthoughts, setMicrothoughts] = useState<IdeaMicrothought[]>(ticket.microthoughts ?? []);
  const [newMicrothought, setNewMicrothought] = useState('');

  // Feature 3 — ICE
  const [iceImpact, setIceImpact] = useState(ticket.iceImpact ?? 3);
  const [iceEffort, setIceEffort] = useState(ticket.iceEffort ?? 3);
  const [iceConfidence, setIceConfidence] = useState(ticket.iceConfidence ?? 3);

  // Feature 4 — Assumptions
  const [assumptions, setAssumptions] = useState<IdeaAssumption[]>(ticket.assumptions ?? []);
  const [newAssumption, setNewAssumption] = useState('');

  // Feature 5 — Revisit Date
  const [revisitDate, setRevisitDate] = useState(ticket.revisitDate ?? '');

  // Feature 7 — Problem Statement
  const [problemStatement, setProblemStatement] = useState(ticket.problemStatement ?? '');

  // Feature 1 — Activity Trail "show all" toggle
  const [showAllActivity, setShowAllActivity] = useState(false);

  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);

  const parsedTags = normalizeTags(tagsInput);
  const activityTrail = ticket.activityTrail ?? [];
  const visibleActivity = (showAllActivity ? activityTrail : activityTrail.slice(-3)).slice().reverse();
  const iceScore = ((iceImpact / iceEffort) * iceConfidence).toFixed(1);

  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    function handleFsChange() {
      setFullscreen(!!document.fullscreenElement);
    }
    document.addEventListener('fullscreenchange', handleFsChange);
    return () => document.removeEventListener('fullscreenchange', handleFsChange);
  }, []);

  async function toggleFullscreen() {
    if (!document.fullscreenElement) {
      await panelRef.current?.requestFullscreen();
    } else {
      await document.exitFullscreen();
    }
  }

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

  function addMicrothought() {
    const text = newMicrothought.trim();
    if (!text) return;
    setMicrothoughts((prev) => [...prev, { id: `m-${Date.now()}`, text, at: new Date().toISOString() }]);
    setNewMicrothought('');
  }

  function addAssumption() {
    const text = newAssumption.trim();
    if (!text) return;
    setAssumptions((prev) => [...prev, { id: `as-${Date.now()}`, text, status: 'untested' }]);
    setNewAssumption('');
  }

  function cycleAssumptionStatus(id: string) {
    setAssumptions((prev) => prev.map((item) => {
      if (item.id !== id) return item;
      const currentIndex = ASSUMPTION_STATUS_ORDER.indexOf(item.status);
      return { ...item, status: ASSUMPTION_STATUS_ORDER[(currentIndex + 1) % ASSUMPTION_STATUS_ORDER.length] };
    }));
  }

  function setClampedIce(setter: (value: number) => void, rawValue: string) {
    setter(clampIceScore(Number(rawValue)));
  }

  function handleSave() {
    const trimmed = title.trim();
    if (!trimmed) return;
    onSave({
      ...ticket,
      title: trimmed,
      description,
      tags: parsedTags,
      ideaEmoji: emoji,
      ideaColor: color,
      ideaEnergy: energy ?? undefined,
      problemStatement: problemStatement.trim() || undefined,
      iceImpact, iceEffort, iceConfidence,
      assumptions,
      microthoughts,
      revisitDate: revisitDate || undefined,
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
      <div ref={panelRef} className={`${styles.panel} ${visible ? styles.panelVisible : ''} ${fullscreen ? styles.panelFullscreen : ''}`}>
        {/* Floating close button */}
        <button
          type="button"
          className={styles.fullscreenBtn}
          onClick={toggleFullscreen}
          aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        >
          {fullscreen ? '⤡' : '⤢'}
        </button>
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
            {/* LEFT: status, title, id, description */}
            <div className={styles.contentLeft}>
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

              {/* Feature 7 — Problem Statement */}
              <div className={styles.problemWrap}>
                <span className={styles.problemLabel}>Problem Statement</span>
                {isDraft && <span className={styles.problemRequiredHint}>required to review</span>}
                <input
                  type="text"
                  className={styles.problemInput}
                  value={problemStatement}
                  onChange={(e) => setProblemStatement(e.target.value)}
                  readOnly={!isEditable}
                  placeholder="The problem is: ..."
                />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
                <div className={styles.descHeader}>
                  <span className={styles.sectionLabel} style={{ margin: 0 }}>Description</span>
                  {isEditable && (
                    <div className={styles.descTabs}>
                      <button
                        type="button"
                        className={`${styles.descTab} ${!previewMode ? styles.descTabActive : ''}`}
                        onClick={() => setPreviewMode(false)}
                      >Write</button>
                      <button
                        type="button"
                        className={`${styles.descTab} ${previewMode ? styles.descTabActive : ''}`}
                        onClick={() => setPreviewMode(true)}
                      >Preview</button>
                    </div>
                  )}
                </div>
                <div className={styles.descField} style={{ flex: 1 }}>
                  {(!isEditable || previewMode) ? (
                    <div className={styles.markdownBody}>
                      {description ? (
                        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
                          {description}
                        </ReactMarkdown>
                      ) : (
                        <span style={{ color: 'rgba(61,12,17,0.3)', fontSize: '0.9rem' }}>No description.</span>
                      )}
                    </div>
                  ) : (
                    <textarea
                      className={styles.descTextarea}
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder="Scribble your rough thoughts here... (markdown supported)"
                    />
                  )}
                </div>
              </div>

              {/* Feature 2 — Microthoughts */}
              <div>
                <span className={styles.sectionLabel}>Microthoughts</span>
                <div className={styles.microthoughtsList}>
                  {microthoughts.map(m => (
                    <div key={m.id} className={styles.microthoughtItem}>
                      <span className={styles.microthoughtText}>{m.text}</span>
                      <span className={styles.microthoughtTime}>{formatRelativeTime(m.at)}</span>
                      {isEditable && (
                        <button type="button" className={styles.microthoughtDelete}
                          onClick={() => setMicrothoughts(prev => prev.filter(x => x.id !== m.id))}>×</button>
                      )}
                    </div>
                  ))}
                  {isEditable && (
                    <div className={styles.microthoughtAddRow}>
                      <input
                        type="text"
                        className={styles.microthoughtInput}
                        value={newMicrothought}
                        onChange={(e) => setNewMicrothought(e.target.value)}
                        placeholder="Quick thought, link, note..."
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') addMicrothought();
                        }}
                      />
                      <button type="button" className={styles.microthoughtAddBtn} onClick={addMicrothought}>+</button>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* RIGHT: energy, color, tags */}
            <div className={styles.contentRight}>
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

              <div>
                <div className={styles.tagsSectionHeader}>
                  <span className={styles.sectionLabel} style={{ margin: 0 }}>Tags</span>
                  {isEditable && !editingTags && (
                    <button
                      type="button"
                      className={styles.tagsEditBtn}
                      onClick={() => setEditingTags(true)}
                      title="Edit tags"
                    >✏️</button>
                  )}
                </div>
                {editingTags ? (
                  <input
                    type="text"
                    className={styles.tagsInput}
                    value={tagsInput}
                    onChange={(e) => setTagsInput(e.target.value)}
                    placeholder="design, ui, feature (comma-separated)"
                    autoFocus
                    onBlur={() => setEditingTags(false)}
                    onKeyDown={(e) => { if (e.key === 'Enter') setEditingTags(false); }}
                  />
                ) : (
                  <div className={styles.tagRow}>
                    {parsedTags.map((t) => (
                      <span key={t} className={styles.tagPill}>{t}</span>
                    ))}
                    {!parsedTags.length && (
                      <span style={{ fontSize: '0.8rem', color: 'rgba(61,12,17,0.35)' }}>No tags</span>
                    )}
                  </div>
                )}
              </div>

              {/* Feature 3 — ICE Score */}
              <div>
                <span className={styles.sectionLabel}>ICE Score</span>
                <div className={styles.iceWrap}>
                  <div className={styles.iceHeader}>
                    <span className={styles.iceTitle}>ICE Priority</span>
                    <span className={styles.iceScoreBadge}>{iceScore}</span>
                  </div>
                  <div className={styles.iceRow}>
                    <div className={styles.iceField}>
                      <span className={styles.iceLabel}>Impact</span>
                      <input type="number" min={1} max={5} className={styles.iceInput} value={iceImpact}
                        onChange={(e) => setClampedIce(setIceImpact, e.target.value)} disabled={!isEditable} />
                    </div>
                    <span className={styles.iceDivider}>÷</span>
                    <div className={styles.iceField}>
                      <span className={styles.iceLabel}>Effort</span>
                      <input type="number" min={1} max={5} className={styles.iceInput} value={iceEffort}
                        onChange={(e) => setClampedIce(setIceEffort, e.target.value)} disabled={!isEditable} />
                    </div>
                    <span className={styles.iceDivider}>×</span>
                    <div className={styles.iceField}>
                      <span className={styles.iceLabel}>Conf.</span>
                      <input type="number" min={1} max={5} className={styles.iceInput} value={iceConfidence}
                        onChange={(e) => setClampedIce(setIceConfidence, e.target.value)} disabled={!isEditable} />
                    </div>
                  </div>
                  <p className={styles.iceFormula}>= ({iceImpact} ÷ {iceEffort}) × {iceConfidence}</p>
                </div>
              </div>

              {/* Feature 5 — Revisit Date */}
              <div>
                <span className={styles.sectionLabel}>Revisit By</span>
                <div className={styles.revisitWrap}>
                  <div className={styles.revisitRow}>
                    <input type="date" className={styles.revisitInput} value={revisitDate}
                      onChange={(e) => setRevisitDate(e.target.value)} disabled={!isEditable} />
                  </div>
                  {ticket.lastTouchedAt && (
                    <span className={styles.lastTouched}>Last touched {formatRelativeTime(ticket.lastTouchedAt)}</span>
                  )}
                  {ticket.revisitDate && new Date(ticket.revisitDate) < new Date() && (
                    <span className={styles.stalenessBadge}>
                      <span className={styles.stalenessPulse} />
                      Stale — overdue
                    </span>
                  )}
                </div>
              </div>

              {/* Feature 4 — Assumptions */}
              <div>
                <span className={styles.sectionLabel}>Assumptions</span>
                <div className={styles.assumptionsList}>
                  {assumptions.map(a => (
                    <div key={a.id} className={`${styles.assumptionItem} ${a.status === 'invalidated' ? styles.invalidated : ''}`}>
                      <button
                        type="button"
                        className={`${styles.assumptionDot} ${styles[`assumptionDot_${a.status}` as keyof typeof styles]}`}
                        onClick={() => {
                          if (!isEditable) return;
                          cycleAssumptionStatus(a.id);
                        }}
                        title={a.status}
                      />
                      <span className={styles.assumptionText}>{a.text}</span>
                      {isEditable && (
                        <button type="button" className={styles.assumptionDelete}
                          onClick={() => setAssumptions(prev => prev.filter(x => x.id !== a.id))}>×</button>
                      )}
                    </div>
                  ))}
                  {isEditable && (
                    <div className={styles.assumptionAddRow}>
                      <input
                        type="text"
                        className={styles.assumptionInput}
                        value={newAssumption}
                        onChange={(e) => setNewAssumption(e.target.value)}
                        placeholder="Add assumption..."
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') addAssumption();
                        }}
                      />
                      <button type="button" className={styles.assumptionAddBtn} onClick={addAssumption}>+</button>
                    </div>
                  )}
                </div>
                <div className={styles.assumptionLegend}>
                  {(['untested', 'validated', 'invalidated'] as IdeaAssumptionStatus[]).map(s => (
                    <div key={s} className={styles.assumptionLegendItem}>
                      <div className={styles.assumptionLegendDot} style={{ background: s === 'untested' ? '#F5C518' : s === 'validated' ? '#AACC2E' : '#F472B6' }} />
                      {s}
                    </div>
                  ))}
                </div>
              </div>

              {/* Feature 6 — Promotion Trail */}
              {ticket.ideaStatus === 'approved' && ticket.promotedToTicketId && (
                <div className={styles.promotionBanner}>
                  <div className={styles.promotionIcon}>🚀</div>
                  <div className={styles.promotionText}>
                    <div className={styles.promotionTitle}>Idea Promoted!</div>
                    <div className={styles.promotionSub}>
                      Tracking in <strong>{ticket.promotedToTicketId}</strong>
                      {ticket.promotedAt && <> · {formatRelativeTime(ticket.promotedAt)}</>}
                    </div>
                  </div>
                </div>
              )}

              {/* Feature 1 — Activity Trail */}
              {activityTrail.length > 0 && (
                <div className={styles.activityWrap}>
                  <div className={styles.activityHeader}>
                    <span className={styles.activityTitle}>Activity Trail</span>
                  </div>
                  <div className={styles.activityList}>
                    {visibleActivity.map((entry, i) => (
                        <div key={entry.id} className={styles.activityItem}>
                          <div className={`${styles.activityDot} ${i === 0 ? styles.activityDotLatest : ''}`} />
                          <div className={styles.activityContent}>
                            <span className={styles.activityLabel}>{entry.label}</span>
                            <span className={styles.activityTime}>{formatRelativeTime(entry.at)}</span>
                          </div>
                        </div>
                      ))}
                  </div>
                  {activityTrail.length > 3 && (
                    <button type="button" className={styles.activityToggle} onClick={() => setShowAllActivity(v => !v)}>
                      {showAllActivity ? '↑ Show less' : `↓ View all ${activityTrail.length} events`}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
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
                  <button
                    type="button"
                    className={styles.actionBtn}
                    onClick={() => { onStatusChange(ticket.id, 'in_review'); onClose(); }}
                    disabled={!problemStatement.trim()}
                    title={!problemStatement.trim() ? 'Fill in the Problem Statement first' : undefined}
                    style={!problemStatement.trim() ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
                  >
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
