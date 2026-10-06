import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Comment, Member } from '../types/ticket';
import { useToast } from './Toast';
import { MarkdownRenderer } from './MarkdownRenderer';
import { Composer } from './comments/Composer';
import { Icon } from './docs/Icon';
import type { SuggestMember } from './docs/RefSuggester';
import { getAvatarColors } from './MemberAvatar';
import {
  UNDO_MS,
  exactTime,
  personFor,
  queueKey,
  readJson,
  relative,
  writeJson,
  type Person,
  type QueuedComment,
} from './comments/commentUtils';

interface CommentsSectionProps {
  ticketId: string;
  projectId: string;
  comments: Comment[];
  members?: Member[];
  currentMember?: Member | null;
  reporterId?: string | null;
  assigneeId?: string | null;
  /** First load of the ticket still running. */
  isLoading?: boolean;
  /** A comment to scroll to and tint (from Activity "View comment" or a #comment-id link). */
  focusCommentId?: string | null;
  onFocusHandled?: () => void;
  /** Resolve with the saved comment id, reject when the server could not be reached. */
  onAdd: (text: string) => Promise<unknown>;
  onEdit: (id: string, text: string) => Promise<unknown>;
  onDelete: (id: string) => Promise<unknown>;
  onRestore: (id: string) => Promise<unknown>;
}

interface Ghost {
  comment: Comment;
  index: number;
}
interface Failed {
  id: string;
  text: string;
  at: string;
}

const COLLAPSE_CHARS = 1200;
const COLLAPSE_LINES = 8;
const THREAD_COLLAPSE_OVER = 6;
const TAIL = 4;

const STYLE = `
.cm-row:hover .cm-bar, .cm-row:focus-within .cm-bar { opacity: 1; }
.cm-time { border-bottom: 1px dotted #9AA8A0; cursor: default; position: relative; }
.cm-time .cm-tt { display: none; position: absolute; left: 0; bottom: calc(100% + 6px); background: #1E2A22; color: #fff; font-size: 12px; font-weight: 500; padding: 6px 10px; border-radius: 6px; white-space: nowrap; z-index: 20; box-shadow: 0 4px 14px rgba(30,42,34,.28); }
.cm-time:hover .cm-tt { display: block; }
.cm-tint { animation: cm-tint 2.2s ease-out; }
@keyframes cm-tint { 0%, 70% { background: #E4F1E8; } 100% { background: transparent; } }
.mc-bar { animation: cm-load 1.1s ease-in-out infinite alternate; }
@keyframes cm-load { from { width: 25%; } to { width: 85%; } }
.cm-sk { background: linear-gradient(90deg,#EEF3EF,#F6FAF7,#EEF3EF); background-size: 200% 100%; animation: cm-sk 1.2s linear infinite; border-radius: 6px; }
@keyframes cm-sk { to { background-position: -200% 0; } }
`;

function Avatar({ person, dashed }: { person: Person; dashed?: boolean }) {
  return (
    <div title={person.name} style={{ width: 28, height: 28, borderRadius: '50%', background: person.bg, color: person.color, fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, userSelect: 'none', opacity: dashed ? 0.7 : 1 }}>
      {person.initials}
    </div>
  );
}

function Collapsible({ text }: { text: string }) {
  const long = text.length > COLLAPSE_CHARS || text.split('\n').length > COLLAPSE_LINES;
  const [open, setOpen] = useState(false);
  if (!long) return <MarkdownRenderer>{text}</MarkdownRenderer>;
  return (
    <div>
      <div style={{ position: 'relative', maxHeight: open ? undefined : 190, overflow: 'hidden' }}>
        <MarkdownRenderer>{text}</MarkdownRenderer>
        {!open && <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 48, background: 'linear-gradient(rgba(255,255,255,0),#FFFFFF)' }} />}
      </div>
      <button type="button" data-testid="comment-show-more" onClick={() => setOpen((o) => !o)} style={{ border: 'none', background: 'none', padding: '4px 0 0', cursor: 'pointer', color: '#2E6F40', fontWeight: 700, fontSize: 12.5, fontFamily: 'inherit' }}>
        {open ? 'Show less' : 'Show more'}
      </button>
    </div>
  );
}

const barBtn = (danger?: boolean, on?: boolean): React.CSSProperties => ({
  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 9px', border: 'none', borderRadius: 6, cursor: 'pointer',
  background: on ? '#FBE7E4' : 'none', color: danger ? '#C4432A' : '#3A4A3E', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600,
});

export function CommentsSection({
  ticketId, projectId, comments, members = [], currentMember, reporterId, assigneeId, isLoading = false, focusCommentId, onFocusHandled, onAdd, onEdit, onDelete, onRestore,
}: CommentsSectionProps) {
  const toast = useToast();
  const rootRef = useRef<HTMLDivElement>(null);
  const [composing, setComposing] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [ghosts, setGhosts] = useState<Ghost[]>([]);
  const [failed, setFailed] = useState<Failed[]>([]);
  const [queue, setQueue] = useState<QueuedComment[]>(() => readJson<QueuedComment[]>(queueKey(ticketId), []));
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  const [expandedMiddle, setExpandedMiddle] = useState(false);

  const me = useMemo<Person>(() => (currentMember ? personFor(currentMember.name, members.length ? members : [currentMember]) : { name: 'You', initials: 'ME', bg: '#DCEEE1', color: '#2E6F40' }), [currentMember, members]);
  const isMine = (c: Comment) => c.author === 'user' || (!!currentMember && (c.author === currentMember.name || c.author === currentMember.id));
  const author = currentMember?.name ?? 'user';

  const suggestMembers = useMemo<SuggestMember[]>(() => {
    const onTicket = new Map<string, string>();
    if (assigneeId) onTicket.set(assigneeId, 'Assignee');
    if (reporterId && !onTicket.has(reporterId)) onTicket.set(reporterId, 'Reporter');
    for (const c of comments) {
      const m = members.find((x) => x.id === c.author || x.name.toLowerCase() === c.author.toLowerCase());
      if (m && !onTicket.has(m.id)) onTicket.set(m.id, 'Commented');
    }
    const row = (m: Member, group: string, note: string): SuggestMember => ({ id: m.id, name: m.name, group, note, ...getAvatarColors(m.color) });
    const first = [...onTicket.entries()].flatMap(([id, note]) => {
      const m = members.find((x) => x.id === id);
      return m ? [row(m, 'On this ticket', note)] : [];
    });
    const rest = members.filter((m) => !onTicket.has(m.id)).map((m) => row(m, 'Everyone else', m.id === currentMember?.id ? 'You' : ''));
    return [...first, ...rest];
  }, [members, comments, assigneeId, reporterId, currentMember]);

  // ---- offline queue -----------------------------------------------------
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  const saveQueue = useCallback((q: QueuedComment[]) => {
    setQueue(q);
    writeJson(queueKey(ticketId), q);
  }, [ticketId]);
  const flushing = useRef(false);
  useEffect(() => {
    if (!online || queue.length === 0 || flushing.current) return;
    flushing.current = true;
    (async () => {
      let rest = [...queue];
      for (const item of queue) {
        try {
          await onAdd(item.text);
          rest = rest.filter((q) => q.id !== item.id);
          saveQueue(rest);
        } catch {
          break;
        }
      }
      flushing.current = false;
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, queue.length]);

  // ---- sending -----------------------------------------------------------
  async function send(text: string, retryId?: string) {
    if (!online) {
      saveQueue([...queue, { id: `q-${Date.now()}`, text, author, at: new Date().toISOString() }]);
      setComposing(false);
      return;
    }
    try {
      await onAdd(text);
      if (retryId) setFailed((f) => f.filter((x) => x.id !== retryId));
      setComposing(false);
    } catch {
      setComposing(false);
      setFailed((f) => [...f.filter((x) => x.id !== retryId), { id: retryId ?? `f-${Date.now()}`, text, at: new Date().toISOString() }]);
    }
  }

  // ---- delete with 10 s undo ---------------------------------------------
  async function remove(c: Comment, index: number) {
    setConfirmId(null);
    setGhosts((g) => [...g, { comment: c, index }]);
    try {
      await onDelete(c.id);
    } catch {
      setGhosts((g) => g.filter((x) => x.comment.id !== c.id));
      toast.error("Couldn't delete the comment");
      return;
    }
    let done = false;
    const drop = () => setGhosts((g) => g.filter((x) => x.comment.id !== c.id));
    const undo = async () => {
      if (done) return;
      done = true;
      drop();
      try {
        await onRestore(c.id);
      } catch {
        toast.error("Couldn't restore the comment");
      }
    };
    setUndoFns((m) => ({ ...m, [c.id]: undo }));
    toast.success('Comment deleted', `Your comment on ${ticketId} was removed.`, UNDO_MS, { label: 'Undo', onClick: () => void undo() });
    setTimeout(() => {
      done = true;
      drop();
    }, UNDO_MS);
  }
  const [undoFns, setUndoFns] = useState<Record<string, () => void>>({});

  // ---- deep link / focus ---------------------------------------------------
  useEffect(() => {
    const hashId = window.location.hash.startsWith('#comment-') ? window.location.hash.slice(9) : null;
    const id = focusCommentId ?? hashId;
    if (!id) return;
    const el = rootRef.current?.querySelector<HTMLElement>(`[data-comment-id="${CSS.escape(id)}"]`);
    if (!el) {
      if (focusCommentId) toast.info('That comment was deleted');
      onFocusHandled?.();
      return;
    }
    setExpandedMiddle(true);
    requestAnimationFrame(() => {
      const target = rootRef.current?.querySelector<HTMLElement>(`[data-comment-id="${CSS.escape(id)}"]`);
      target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      target?.classList.remove('cm-tint');
      void target?.offsetWidth;
      target?.classList.add('cm-tint');
      setTimeout(() => target?.classList.remove('cm-tint'), 2300);
    });
    onFocusHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusCommentId, comments.length]);

  function copyLink(c: Comment) {
    const url = `${window.location.origin}${window.location.pathname}?ticket=${ticketId}#comment-${c.id}`;
    void navigator.clipboard?.writeText(url);
    toast.success('Link copied');
  }

  // ---- layout of the thread --------------------------------------------------
  const visible = useMemo(() => {
    const live: ({ kind: 'c'; c: Comment; i: number } | { kind: 'g'; g: Ghost })[] = comments.map((c, i) => ({ kind: 'c', c, i }));
    for (const g of [...ghosts].sort((a, b) => a.index - b.index)) live.splice(Math.min(g.index, live.length), 0, { kind: 'g', g });
    return live;
  }, [comments, ghosts]);
  const collapseMiddle = !expandedMiddle && comments.length > THREAD_COLLAPSE_OVER;
  const hiddenCount = collapseMiddle ? comments.length - 1 - TAIL : 0;

  function renderComment(c: Comment, index: number) {
    const p = personFor(c.author, members);
    const mine = isMine(c);
    if (editingId === c.id) {
      return (
        <div key={c.id} data-comment-id={c.id} style={{ padding: '6px 0' }}>
          <Composer
            ticketId={ticketId}
            projectId={projectId}
            me={p}
            members={suggestMembers}
            initial={c.text}
            editing
            onCancel={() => setEditingId(null)}
            onSubmit={(t) => {
              setEditingId(null);
              if (t !== c.text) void onEdit(c.id, t).catch(() => toast.error("Couldn't save the comment"));
            }}
          />
        </div>
      );
    }
    return (
      <div key={c.id} className="cm-row" data-comment-id={c.id} data-testid="comment" style={{ position: 'relative', display: 'flex', gap: 12, alignItems: 'flex-start', padding: '8px 10px', margin: '0 -10px', borderRadius: 10 }}>
        <Avatar person={p} />
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: '#1E2A22' }}>{p.name}</span>
            <span className="cm-time" style={{ fontSize: 12, color: '#9AA8A0' }}>
              {relative(c.at)}
              <span className="cm-tt">{exactTime(c.at)}</span>
            </span>
            {c.editedAt && <span data-testid="comment-edited" style={{ fontSize: 12, color: '#9AA8A0' }}>· edited</span>}
          </div>
          <div style={{ fontSize: 14, lineHeight: 1.65, color: '#3A4A3E' }}><Collapsible text={c.text} /></div>
          {confirmId === c.id && (
            <div data-testid="comment-delete-confirm" style={{ marginTop: 8, border: '1px solid #F0C4B8', background: '#FDF3F0', borderRadius: 8, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#A5321E' }}>Delete this comment?</div>
              <div style={{ fontSize: 12.5, lineHeight: 1.5, color: '#5B6B60' }}>It disappears for everyone on this ticket. You get 10 seconds to undo it. Mentions already sent stay sent.</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" className="st-btn st-btn-sm" onClick={() => setConfirmId(null)}>Cancel</button>
                <button type="button" className="st-btn st-btn-danger st-btn-sm" data-testid="comment-delete-confirm-yes" onClick={() => void remove(c, index)}>Delete</button>
              </div>
            </div>
          )}
        </div>
        <div className="cm-bar" style={{ position: 'absolute', right: 8, top: -14, opacity: confirmId === c.id ? 1 : 0, transition: 'opacity .12s', display: 'flex', gap: 2, background: '#FFFFFF', border: '1px solid #E3E8E5', borderRadius: 8, padding: 3, boxShadow: '0 4px 14px rgba(30,42,34,0.12)', zIndex: 2 }}>
          {mine && (
            <>
              <button type="button" data-testid="comment-edit" style={barBtn()} onClick={() => { setEditingId(c.id); setConfirmId(null); }}><Icon name="i26" size={13} strokeWidth={1.9} />Edit</button>
              <button type="button" data-testid="comment-delete" style={barBtn(true, confirmId === c.id)} onClick={() => setConfirmId(confirmId === c.id ? null : c.id)}><Icon name="i12" size={13} strokeWidth={1.9} />Delete</button>
            </>
          )}
          <button type="button" data-testid="comment-copy-link" style={barBtn()} onClick={() => copyLink(c)}><Icon name="link" size={13} strokeWidth={1.9} />Copy link</button>
        </div>
      </div>
    );
  }

  const rows: React.ReactNode[] = [];
  let shownDivider = false;
  visible.forEach((it, idx) => {
    if (it.kind === 'g') {
      rows.push(
        <div key={`g-${it.g.comment.id}`} data-testid="comment-deleted-rule" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', color: '#9AA8A0', fontSize: 12.5 }}>
          <span style={{ flex: 1, height: 1, background: '#E3E8E5' }} />
          Comment deleted ·
          <button type="button" data-testid="comment-undo" onClick={() => undoFns[it.g.comment.id]?.()} style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', color: '#2E6F40', fontWeight: 700, fontFamily: 'inherit', fontSize: 12.5 }}>Undo</button>
          <span style={{ flex: 1, height: 1, background: '#E3E8E5' }} />
        </div>,
      );
      return;
    }
    const { c, i } = it;
    if (collapseMiddle && i > 0 && i < comments.length - TAIL) {
      if (!shownDivider) {
        shownDivider = true;
        rows.push(
          <button key="more" type="button" data-testid="comments-show-older" onClick={() => setExpandedMiddle(true)} style={{ alignSelf: 'flex-start', border: '1px dashed #C7D2CB', background: '#FBFCFB', borderRadius: 8, padding: '7px 14px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600, color: '#2E6F40' }}>
            Show {hiddenCount} older comments
          </button>,
        );
      }
      return;
    }
    void idx;
    rows.push(renderComment(c, i));
  });

  return (
    <div ref={rootRef} data-testid="comments" id="comments" style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingTop: 14, paddingBottom: 28, borderTop: '1px solid #EEF3EF' }}>
      <style>{STYLE}</style>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', color: '#5B6B60', textTransform: 'uppercase' }}>Comments</span>
        <span data-testid="comments-count" style={{ fontSize: 11.5, fontWeight: 700, color: '#5B6B60', background: '#EEF1EE', borderRadius: 999, padding: '1px 8px' }}>{isLoading ? '…' : comments.length}</span>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#9AA8A0' }}>Oldest first</span>
      </div>

      {isLoading ? (
        <div data-testid="comments-loading" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {[1, 2].map((n) => (
            <div key={n} style={{ display: 'flex', gap: 12 }}>
              <div className="cm-sk" style={{ width: 28, height: 28, borderRadius: '50%' }} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
                <div className="cm-sk" style={{ width: 140, height: 12 }} />
                <div className="cm-sk" style={{ width: `${60 + n * 12}%`, height: 12 }} />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <>
          {!online && (
            <div data-testid="comments-offline" style={{ display: 'flex', gap: 8, alignItems: 'center', background: '#FEF6E7', border: '1px solid #F0DBA8', borderRadius: 8, padding: '8px 12px', fontSize: 12.5, color: '#7A4F08' }}>
              <b>You are offline.</b> Comments are saved here and sent when the connection returns.
            </div>
          )}
          {comments.length === 0 && ghosts.length === 0 && queue.length === 0 && failed.length === 0 && (
            <div data-testid="comments-empty" style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 0 4px' }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: '#1E2A22' }}>No comments yet</span>
              <span style={{ fontSize: 13, color: '#5B6B60' }}>Start the conversation. Type @ to mention a teammate or [[ to link a doc.</span>
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {rows}
            {queue.map((q) => (
              <div key={q.id} data-testid="comment-queued" style={{ display: 'flex', gap: 12, border: '1px dashed #C7D2CB', borderRadius: 10, padding: '8px 12px', margin: '0 -2px', background: '#FBFCFB' }}>
                <Avatar person={me} dashed />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                    <span style={{ fontSize: 14, fontWeight: 700 }}>{me.name}</span>
                    <span style={{ fontSize: 12, color: '#9AA8A0' }}>Queued</span>
                  </div>
                  <div style={{ fontSize: 14, lineHeight: 1.65, color: '#3A4A3E' }}><MarkdownRenderer>{q.text}</MarkdownRenderer></div>
                  <div style={{ display: 'flex', gap: 12, marginTop: 4 }}>
                    <button type="button" onClick={() => { saveQueue(queue.filter((x) => x.id !== q.id)); setComposing(true); writeJson(`kanban.commentDraft.${ticketId}`, q.text); }} style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', color: '#2E6F40', fontWeight: 700, fontSize: 12.5, fontFamily: 'inherit' }}>Edit</button>
                    <button type="button" data-testid="comment-cancel-send" onClick={() => saveQueue(queue.filter((x) => x.id !== q.id))} style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', color: '#C4432A', fontWeight: 700, fontSize: 12.5, fontFamily: 'inherit' }}>Cancel send</button>
                  </div>
                </div>
              </div>
            ))}
            {failed.map((f) => (
              <div key={f.id} data-testid="comment-failed" style={{ display: 'flex', gap: 12, border: '1px solid #F0C4B8', borderRadius: 10, padding: '8px 12px', background: '#FDF3F0' }}>
                <Avatar person={me} />
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                    <span style={{ fontSize: 14, fontWeight: 700 }}>{me.name}</span>
                    <span style={{ fontSize: 12, color: '#C4432A', fontWeight: 600 }}>Not sent</span>
                  </div>
                  <div style={{ fontSize: 14, lineHeight: 1.65, color: '#3A4A3E' }}><MarkdownRenderer>{f.text}</MarkdownRenderer></div>
                  <div style={{ fontSize: 12.5, color: '#A5321E' }}>Couldn't reach the server. Your text is kept; nothing was lost.</div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button type="button" className="st-btn st-btn-primary st-btn-sm" data-testid="comment-retry" onClick={() => void send(f.text, f.id)}>Retry</button>
                    <button type="button" className="st-btn st-btn-sm" onClick={() => { setFailed((x) => x.filter((y) => y.id !== f.id)); writeJson(`kanban.commentDraft.${ticketId}`, f.text); setComposing(true); }}>Edit</button>
                    <button type="button" className="st-btn st-btn-sm" onClick={() => setFailed((x) => x.filter((y) => y.id !== f.id))}>Discard</button>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {composing ? (
            <Composer ticketId={ticketId} projectId={projectId} me={me} members={suggestMembers} onCancel={() => setComposing(false)} onSubmit={(t) => void send(t)} />
          ) : (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <Avatar person={me} />
              <button
                type="button"
                data-testid="comment-collapsed"
                onClick={() => setComposing(true)}
                onFocus={() => setComposing(true)}
                style={{ flex: 1, textAlign: 'left', border: '1px solid #E3E8E5', borderRadius: 8, background: '#FFFFFF', padding: '9px 14px', fontFamily: 'inherit', fontSize: 14, color: '#6B7A70', cursor: 'text' }}
              >
                Add a comment…
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
