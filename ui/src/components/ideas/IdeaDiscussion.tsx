import { useRef, useState } from 'react';
import { extractError } from '../../api/extractError';
import {
  ideaRuleError,
  useAddComment,
  useAddLogEntry,
  useDeleteComment,
  useDeleteLogEntry,
  useEditComment,
  useEditLogEntry,
  useIdeaActivity,
  useIdeaComments,
  useIdeaLog,
  useLogAsEvidence,
} from '../../api/ideas';
import type { Idea, IdeaActivityEntry, IdeaStage, LogKind } from '../../types/idea';
import { LOG_KIND_LABELS } from '../../types/idea';
import { absoluteTime, relativeTime } from '../../utils/relativeTime';
import { lineDiffCounts } from '../../utils/lineDiff';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { Avatar, plural } from '../docs/docsShared';
import { useToast } from '../Toast';
import { AiChip, StagePill } from './ideaShared';
import { IdeaIcon, type IdeaIconName } from './ideaIcons';
import { LineIcon } from '../ui/LineIcon';
import { MenuSelect } from '../ui/MenuSelect';
import { uploadAnyFile } from '../../api/tickets';

const who = (a?: string | null) => (!a ? 'Someone' : a === 'user' ? 'You' : a === 'agent' ? 'AI agent' : a);

/** Comments on the idea page. */
export function IdeaComments({ idea, readOnly }: { idea: Idea; readOnly: boolean }) {
  const list = useIdeaComments(idea.id);
  const add = useAddComment();
  const edit = useEditComment();
  const del = useDeleteComment();
  const [body, setBody] = useState('');
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const comments = list.data ?? [];

  async function post() {
    if (!body.trim()) return;
    try {
      await add.mutateAsync({ id: idea.id, body });
      setBody('');
      setError(null);
    } catch (e) {
      setError(extractError(e));
    }
  }

  return (
    <div data-testid="comments-tab" style={{ maxWidth: 720 }}>
      {comments.length === 0 && (
        <div className="is-empty">No comments yet. Say what you think; it stays on the idea.</div>
      )}
      {comments.map((c) => (
        <div key={c.id} className="is-comment">
          <Avatar name={c.author ?? '?'} size={26} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="is-comment-head">
              <b>{who(c.author)}</b> {c.ai && <AiChip />}
              <span className="is-muted" title={absoluteTime(c.createdAt)}>
                {relativeTime(c.createdAt)}
                {c.editedAt ? ' · edited' : ''}
              </span>
              <span className="is-grow" />
              {!readOnly && editing?.id !== c.id && (
                <>
                  <button
                    type="button"
                    className="is-btn is-btn-ghost is-btn-sm"
                    onClick={() => setEditing({ id: c.id, body: c.body })}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="is-btn is-btn-ghost is-btn-sm"
                    onClick={() =>
                      window.confirm('Delete this comment?') && del.mutate({ id: idea.id, commentId: c.id })
                    }
                  >
                    Delete
                  </button>
                </>
              )}
            </div>
            {editing?.id === c.id ? (
              <>
                <textarea
                  className="is-textarea"
                  rows={3}
                  value={editing.body}
                  onChange={(e) => setEditing({ id: c.id, body: e.target.value })}
                  aria-label="Edit comment"
                />
                <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                  <button
                    type="button"
                    className="is-btn is-btn-primary is-btn-sm"
                    onClick={async () => {
                      await edit.mutateAsync({ id: idea.id, commentId: c.id, body: editing.body });
                      setEditing(null);
                    }}
                  >
                    Save
                  </button>
                  <button type="button" className="is-btn is-btn-sm" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <MarkdownRenderer>{c.body}</MarkdownRenderer>
            )}
          </div>
        </div>
      ))}
      <div style={{ marginTop: 14 }}>
        <textarea
          className="is-textarea"
          rows={3}
          value={body}
          aria-label="Write a comment"
          placeholder={idea.stage === 'shipped' ? 'Comments stay open after shipping.' : 'Write a comment…'}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => (e.ctrlKey || e.metaKey) && e.key === 'Enter' && post()}
        />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
          <button
            type="button"
            className="is-btn is-btn-primary"
            onClick={post}
            disabled={!body.trim() || add.isPending}
          >
            Comment
          </button>
          {error && <span className="is-muted">{error}</span>}
        </div>
      </div>
    </div>
  );
}

const LOG_KINDS: LogKind[] = ['research', 'interview', 'experiment', 'finding', 'decision', 'note'];

/** Each kind's icon and colours, as the design draws the composer chips, the timeline dots and the entry chips. */
const LOG_STYLE: Record<LogKind, { icon: IdeaIconName; dot: string; ink: string }> = {
  research: { icon: 'search', dot: '#2F6FB0', ink: '#244E78' },
  interview: { icon: 'comment', dot: '#7C5CD6', ink: '#5B3AA6' },
  experiment: { icon: 'flask', dot: '#E8861A', ink: '#8A4B08' },
  finding: { icon: 'target', dot: '#2E6F40', ink: '#1F5A31' },
  decision: { icon: 'flag', dot: '#B8860B', ink: '#7A5A06' },
  note: { icon: 'edit', dot: '#9AA8A0', ink: '#5B6B60' },
};

/** A log kind as a coloured chip with its icon. */
function KindChip({ kind }: { kind: LogKind }) {
  const st = LOG_STYLE[kind];
  return (
    <span className="is-kind-chip" style={{ background: `${st.dot}1F`, color: st.ink }}>
      <IdeaIcon name={st.icon} size={12} strokeWidth={2} />
      {LOG_KIND_LABELS[kind]}
    </span>
  );
}

/** The research log: what was found, tried and decided, as a timeline. */
export function IdeaLog({ idea, readOnly, closed }: { idea: Idea; readOnly: boolean; closed: boolean }) {
  const toast = useToast();
  const list = useIdeaLog(idea.id);
  const add = useAddLogEntry();
  const edit = useEditLogEntry();
  const del = useDeleteLogEntry();
  const asEvidence = useLogAsEvidence();
  const [kind, setKind] = useState<LogKind>('note');
  const [body, setBody] = useState('');
  const [assumptionId, setAssumptionId] = useState('');
  const [attachments, setAttachments] = useState<{ name: string; url: string }[]>([]);
  const [filter, setFilter] = useState<LogKind | 'all'>('all');
  const [newestFirst, setNewestFirst] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const all = list.data ?? [];
  const filtered = all.filter((e) => filter === 'all' || e.kind === filter);
  // the server sends the pinned entries first, then the newest; "Oldest first" sorts by time alone
  const entries = newestFirst ? filtered : [...filtered].sort((x, y) => x.createdAt.localeCompare(y.createdAt));
  const counts = all.reduce<Record<string, number>>((m, e) => ({ ...m, [e.kind]: (m[e.kind] ?? 0) + 1 }), {});
  const pinned = all.find((e) => e.pinned);
  const canWrite = !readOnly && !closed;

  async function submit() {
    if (!body.trim()) return;
    try {
      await add.mutateAsync({
        id: idea.id,
        kind,
        body,
        assumptionId: assumptionId || null,
        attachments: attachments.length ? attachments : undefined,
      });
      setBody('');
      setAssumptionId('');
      setAttachments([]);
      setError(null);
    } catch (e) {
      setError(ideaRuleError(e).message);
    }
  }

  /** Wrap the selected text (or put the marks at the caret) for the B, I, code and link buttons. */
  function wrap(before: string, after: string = before) {
    const el = textRef.current;
    if (!el) return;
    const { selectionStart: a, selectionEnd: b } = el;
    const next = body.slice(0, a) + before + body.slice(a, b) + after + body.slice(b);
    setBody(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(a + before.length, b + before.length);
    });
  }

  async function attach(file: File) {
    try {
      const up = await uploadAnyFile(file);
      setAttachments((x) => [...x, { name: up.name || file.name, url: up.url }]);
    } catch (e) {
      setError(extractError(e));
    }
  }

  const assumptionOptions = [
    { value: '', label: 'No assumption' },
    ...idea.assumptions.map((a) => ({ value: a.id, label: a.text.slice(0, 80) })),
  ];

  return (
    <div data-testid="log-tab" style={{ maxWidth: 820 }}>
      <div className="is-tool-title">
        <h3>Research log</h3>
        <span className="is-muted">
          {plural(all.length, 'entry', 'entries')} · {idea.id}
        </span>
        <span className="is-grow" />
        {canWrite && (
          <button type="button" className="is-btn is-btn-sm is-btn-primary" onClick={() => textRef.current?.focus()}>
            <IdeaIcon name="plus" size={13} />
            Log entry
          </button>
        )}
      </div>

      {all.length > 0 && (
        <div className="is-filters">
          <button type="button" className="is-chip" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
            All <small>{all.length}</small>
          </button>
          {LOG_KINDS.filter((k) => counts[k]).map((k) => (
            <button key={k} type="button" className="is-chip" aria-pressed={filter === k} onClick={() => setFilter(k)}>
              {LOG_KIND_LABELS[k]} <small>{counts[k]}</small>
            </button>
          ))}
          <span className="is-grow" />
          <button
            type="button"
            className="is-btn is-btn-sm"
            onClick={() => setNewestFirst(!newestFirst)}
            data-testid="log-order"
          >
            <IdeaIcon name="sort" size={13} />
            {newestFirst ? 'Newest first' : 'Oldest first'}
          </button>
        </div>
      )}

      {pinned && (
        <div className="is-pinned-strip" data-testid="pinned-entry">
          <IdeaIcon name="pin" size={14} />
          <span>
            <b>Pinned {LOG_KIND_LABELS[pinned.kind].toLowerCase()}</b> · {pinned.body.split('\n')[0].slice(0, 160)}{' '}
            <span className="is-muted">
              {who(pinned.author)} · {relativeTime(pinned.createdAt)}
            </span>
          </span>
        </div>
      )}

      {closed ? (
        <div className="is-banner" style={{ marginBottom: 12 }}>
          The idea is closed. The log stays readable; adding entries is turned off. Reopen the idea to turn it back on.
        </div>
      ) : !readOnly ? (
        <div className="is-log-form is-composer">
          <div className="is-composer-kinds" role="group" aria-label="Kind of entry">
            {LOG_KINDS.map((k) => {
              const st = LOG_STYLE[k];
              return (
                <button
                  key={k}
                  type="button"
                  className="is-kind-chip is-kind-choice"
                  aria-pressed={kind === k}
                  style={{ background: `${st.dot}1F`, color: st.ink, borderColor: kind === k ? st.dot : 'transparent' }}
                  onClick={() => setKind(k)}
                >
                  <IdeaIcon name={st.icon} size={12} strokeWidth={2} />
                  {LOG_KIND_LABELS[k]}
                </button>
              );
            })}
          </div>
          <textarea
            ref={textRef}
            className="is-composer-text"
            rows={3}
            value={body}
            aria-label="Log entry"
            placeholder="Write what you found, tried or decided… (markdown)"
            onChange={(e) => setBody(e.target.value)}
          />
          {attachments.length > 0 && (
            <div className="is-entry-chips">
              {attachments.map((f) => (
                <span key={f.url} className="is-entry-chip">
                  <IdeaIcon name="attach" size={12} />
                  {f.name}
                  <button
                    type="button"
                    className="is-x"
                    aria-label={`Remove ${f.name}`}
                    onClick={() => setAttachments((x) => x.filter((y) => y.url !== f.url))}
                  >
                    <LineIcon name="close" size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="is-composer-bar">
            <button type="button" className="is-icon-btn" aria-label="Bold" onClick={() => wrap('**')}>
              <IdeaIcon name="bold" size={14} />
            </button>
            <button type="button" className="is-icon-btn" aria-label="Italic" onClick={() => wrap('_')}>
              <IdeaIcon name="italic" size={14} />
            </button>
            <button type="button" className="is-icon-btn" aria-label="Code" onClick={() => wrap('`')}>
              <IdeaIcon name="code" size={14} />
            </button>
            <button type="button" className="is-icon-btn" aria-label="Link" onClick={() => wrap('[', '](https://)')}>
              <IdeaIcon name="link" size={14} />
            </button>
            <span className="is-head-sep" aria-hidden="true" />
            <input
              ref={fileRef}
              type="file"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void attach(f);
                e.target.value = '';
              }}
            />
            <button type="button" className="is-btn is-btn-sm is-btn-ghost" onClick={() => fileRef.current?.click()}>
              <IdeaIcon name="attach" size={13} />
              Attach
            </button>
            {idea.assumptions.length > 0 && (
              <MenuSelect
                value={assumptionId}
                options={assumptionOptions}
                onChange={setAssumptionId}
                label="Link to assumption"
                variant="button"
                icon={<IdeaIcon name="target" size={13} />}
                placeholder="Link to assumption"
                testId="log-link-assumption"
                menuWidth={320}
                className="is-composer-link"
              />
            )}
            <span className="is-grow" />
            {error && <span className="is-muted">{error}</span>}
            {(body || attachments.length > 0) && (
              <button
                type="button"
                className="is-btn is-btn-sm"
                onClick={() => {
                  setBody('');
                  setAttachments([]);
                  setAssumptionId('');
                }}
              >
                Cancel
              </button>
            )}
            <button
              type="button"
              className="is-btn is-btn-sm is-btn-primary"
              onClick={submit}
              disabled={!body.trim() || add.isPending}
            >
              Add to log
            </button>
          </div>
        </div>
      ) : null}

      {all.length === 0 && (
        <div className="is-empty">
          <h3>Nothing logged yet</h3>
          <div>
            Write down what you find, try or decide while you explore. It is the memory of how the idea got here.
          </div>
        </div>
      )}

      <div className="is-timeline is-log-rail">
        {entries.map((e) => {
          const supports = idea.assumptions.find((a) => a.id === e.assumptionId);
          const st = LOG_STYLE[e.kind] ?? LOG_STYLE.note;
          return (
            <article key={e.id} className={`is-log-entry ${e.pinned ? 'is-log-pinned' : ''}`} data-testid="log-entry">
              <span className="is-log-dot" style={{ background: st.dot }} aria-hidden="true" />
              <div className="is-log-head">
                <KindChip kind={e.kind} />
                {e.pinned && (
                  <span className="is-log-pin" title="Pinned">
                    <IdeaIcon name="pin" size={13} />
                    <span className="is-sr">Pinned</span>
                  </span>
                )}
                <span className="is-grow" />
                <Avatar name={e.author ?? '?'} size={22} />
                <b>{who(e.author)}</b>
                {e.ai && <AiChip />}
                <span className="is-muted">{relativeTime(e.createdAt)}</span>
                {canWrite && (
                  <>
                    <button
                      type="button"
                      className="is-icon-btn"
                      aria-label={e.pinned ? 'Unpin' : 'Pin'}
                      title={e.pinned ? 'Unpin' : 'Pin'}
                      onClick={() => edit.mutate({ id: idea.id, entryId: e.id, pinned: !e.pinned })}
                    >
                      <IdeaIcon name="pin" size={15} />
                    </button>
                    <button
                      type="button"
                      className="is-icon-btn"
                      aria-label="Delete"
                      title="Delete"
                      onClick={() =>
                        window.confirm('Delete this entry? It stays in Activity as “entry deleted”.') &&
                        del.mutate({ id: idea.id, entryId: e.id })
                      }
                    >
                      <LineIcon name="trash" size={15} />
                    </button>
                  </>
                )}
              </div>
              <div className="is-log-body">
                <MarkdownRenderer>{e.body}</MarkdownRenderer>
              </div>
              <div className="is-entry-chips">
                {e.attachments.map((f) => (
                  <a key={f.url} className="is-entry-chip" href={f.url} target="_blank" rel="noreferrer noopener">
                    <IdeaIcon name="attach" size={12} />
                    {f.name}
                  </a>
                ))}
                {supports && (
                  <span className="is-entry-chip">
                    <IdeaIcon name="target" size={12} />
                    Supports: {supports.text}
                  </span>
                )}
                {e.ticketId && (
                  <span className="is-entry-chip">
                    <IdeaIcon name="flask" size={12} />
                    Test ticket {e.ticketId}
                  </span>
                )}
                {canWrite && e.kind === 'finding' && idea.assumptions.length > 0 && (
                  <MenuSelect<string>
                    value={null}
                    options={idea.assumptions.map((a) => ({ value: a.id, label: a.text.slice(0, 80) }))}
                    onChange={(id) =>
                      asEvidence.mutate(
                        { id: idea.id, entryId: e.id, assumptionId: id },
                        {
                          onSuccess: () => toast.success('Added as evidence'),
                          onError: (err) => toast.error('Could not add', ideaRuleError(err).message),
                        },
                      )
                    }
                    label="Use as evidence"
                    variant="button"
                    icon={<IdeaIcon name="check" size={13} />}
                    placeholder="Use as evidence"
                    testId={`use-as-evidence-${e.id}`}
                    menuWidth={320}
                  />
                )}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

const ACTIVITY_FILTERS: { id: string; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'stage', label: 'Stage' },
  { id: 'assumptions', label: 'Assumptions' },
  { id: 'evidence', label: 'Evidence' },
  { id: 'page', label: 'Page text' },
  { id: 'ai', label: 'By AI' },
  { id: 'links', label: 'Project and links' },
];

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(iso).setHours(0, 0, 0, 0)) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d
    .toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
    })
    .toUpperCase();
}

function Diff({ entry }: { entry: IdeaActivityEntry }) {
  const [open, setOpen] = useState(false);
  const from = String(entry.meta?.from ?? '');
  const to = String(entry.meta?.to ?? '');
  if (entry.kind !== 'page' || (!from && !to)) return null;
  const { added, removed } = lineDiffCounts(from, to);
  return (
    <div>
      <button type="button" className="is-link" onClick={() => setOpen(!open)}>
        {open ? 'Hide changes' : `+${added} −${removed} · show changes`}
      </button>
      {open && (
        <pre className="is-diff">
          <span className="is-diff-del">{from}</span>
          {'\n'}
          <span className="is-diff-add">{to}</span>
        </pre>
      )}
    </div>
  );
}

const ACTIVITY_KINDS: Record<string, { word: string; icon: IdeaIconName; tint: string; ink: string }> = {
  stage: { word: 'Stage', icon: 'inbox', tint: '#FEF6E7', ink: '#7A5A06' },
  assumption: { word: 'Assumption', icon: 'target', tint: '#E6F2EA', ink: '#1F5A31' },
  evidence: { word: 'Evidence', icon: 'clipboard', tint: '#E8F1FA', ink: '#244E78' },
  page: { word: 'Page', icon: 'edit', tint: '#F1F3F1', ink: '#3A4A3E' },
  log: { word: 'Research log', icon: 'log', tint: '#E8F1FA', ink: '#244E78' },
  vote: { word: 'Demand', icon: 'thumb', tint: '#F1F3F1', ink: '#3A4A3E' },
  created: { word: 'Created', icon: 'bulb', tint: '#FEF6E7', ink: '#7A5A06' },
  merge: { word: 'Merged', icon: 'merge', tint: '#FEF6E7', ink: '#7A5A06' },
  project: { word: 'Project', icon: 'folder', tint: '#F1F3F1', ink: '#3A4A3E' },
  link: { word: 'Linked', icon: 'link', tint: '#F1F3F1', ink: '#3A4A3E' },
  ai: { word: 'AI', icon: 'sparkle', tint: '#EFE8FB', ink: '#5B3AA6' },
};
const STAGE_WORDS = new Set(['inbox', 'exploring', 'ready', 'building', 'parked', 'shipped', 'archived']);
const STATE_WORDS = new Set(['untested', 'testing', 'validated', 'disproved']);

/** A before or after value as a chip: a stage pill for a stage, a coloured chip for an assumption state. */
function ValueChip({ value }: { value: string }) {
  if (STAGE_WORDS.has(value)) return <StagePill stage={value as IdeaStage} />;
  if (STATE_WORDS.has(value))
    return <span className={`is-value-chip is-value-${value}`}>{value[0].toUpperCase() + value.slice(1)}</span>;
  return <span className="is-value-chip">{value}</span>;
}

/**
 * Splits an activity label into the subject and the before → after values it names, and marks text the server cut
 * ("… real cost at t" becomes "… real cost at t…").
 */
export function activityParts(entry: IdeaActivityEntry): { subject: string; from?: string; to?: string } {
  let label = entry.label;
  // the server keeps the first 60 characters of a quote or of an entry's text
  label = label.replace(/“([^”]{60})”/g, '“$1…”').replace(/^(Log entry \([a-z]+\): )(.{60})$/s, '$1$2…');
  const word = ACTIVITY_KINDS[entry.kind ?? '']?.word;
  const meta = entry.meta ?? {};
  // newer assumption entries name their assumption (IP-8, IW-4): “They pay” Untested → Testing, added “They pay”
  const text = typeof meta.assumptionText === 'string' ? meta.assumptionText.trim() : '';
  const named = entry.kind === 'assumption' && text ? /^Assumption (marked as \w+|.+)$/.exec(entry.label) : null;
  if (named) {
    const quoted = `“${text.length > 60 ? `${text.slice(0, 60)}…` : text}”`;
    if (named[1].startsWith('marked as') && typeof meta.to === 'string' && meta.to)
      return { subject: quoted, from: typeof meta.from === 'string' ? meta.from || undefined : undefined, to: meta.to };
    return { subject: `${named[1]} ${quoted}` };
  }
  if (entry.kind !== 'page' && typeof meta.from === 'string' && typeof meta.to === 'string' && meta.to) {
    const subject = label
      .replace(/^[^:]*:\s*/, '')
      .replace(/\S+\s*→\s*\S+/, '')
      .trim();
    return { subject, from: meta.from || undefined, to: meta.to };
  }
  const marked = /^Assumption marked as (\w+)$/.exec(label);
  if (marked) return { subject: 'marked as', to: marked[1] };
  if (word && label.toLowerCase().startsWith(word.toLowerCase()))
    label = label.slice(word.length).replace(/^[:\s]+/, '');
  else if (entry.kind === 'log')
    label = label.replace(/^Log entry \((\w+)\):\s*/, (_m, k: string) => `${k[0].toUpperCase()}${k.slice(1)} · `);
  return { subject: label };
}

const ACTIVITY_PAGE = 30;

/** Activity: who changed what, and when. Read-only, grouped by day, with filters. */
export function IdeaActivityTab({ idea }: { idea: Idea }) {
  const [filter, setFilter] = useState('all');
  const [shown, setShown] = useState(ACTIVITY_PAGE);
  const activity = useIdeaActivity(idea.id, filter === 'all' ? undefined : filter);
  const all = activity.data?.items ?? [];
  const items = all.slice(0, shown);
  const counts = activity.data?.counts ?? {};
  const groups: { day: string; items: IdeaActivityEntry[] }[] = [];
  items.forEach((i) => {
    const day = dayLabel(i.at);
    const last = groups[groups.length - 1];
    if (last?.day === day) last.items.push(i);
    else groups.push({ day, items: [i] });
  });

  return (
    <div data-testid="activity-tab" style={{ maxWidth: 820 }}>
      <div className="is-tool-title">
        <h3>Activity</h3>
        <span className="is-muted">
          {plural(counts.all ?? 0, 'change')} · {idea.id}
        </span>
      </div>
      <div className="is-filters">
        {ACTIVITY_FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className="is-chip"
            aria-pressed={filter === f.id}
            onClick={() => {
              setFilter(f.id);
              setShown(ACTIVITY_PAGE);
            }}
          >
            {f.id === 'ai' && <IdeaIcon name="sparkle" size={12} />}
            {f.label} {counts[f.id] ? <small>{counts[f.id]}</small> : null}
          </button>
        ))}
      </div>
      {all.length === 0 && (
        <div className="is-empty">
          <h3>No activity yet</h3>
          <div>Moves between stages, assumption changes, evidence and edits will show up here.</div>
        </div>
      )}
      {groups.map((g) => (
        <section key={g.day} className="is-activity-day">
          <div className="is-label" style={{ margin: '14px 0 6px' }}>
            {g.day} · {plural(g.items.length, 'change')}
          </div>
          {g.items.map((i) => {
            const k = i.ai
              ? ACTIVITY_KINDS.ai
              : (ACTIVITY_KINDS[i.kind ?? ''] ?? {
                  word: '',
                  icon: 'info' as IdeaIconName,
                  tint: '#F1F3F1',
                  ink: '#3A4A3E',
                });
            const parts = activityParts(i);
            return (
              <div key={i.id} className="is-activity-row">
                <span className="is-activity-icon" style={{ background: k.tint, color: k.ink }}>
                  <IdeaIcon name={k.icon} size={15} />
                </span>
                <div className="is-activity-main">
                  <div className="is-activity-line">
                    {(ACTIVITY_KINDS[i.kind ?? '']?.word ?? '') && <b>{ACTIVITY_KINDS[i.kind ?? ''].word}</b>}
                    {parts.subject && (
                      <span className="is-activity-subject" title={i.label}>
                        {parts.subject}
                      </span>
                    )}
                    {parts.from && <ValueChip value={parts.from} />}
                    {parts.from && parts.to && <IdeaIcon name="arrowRight" size={12} color="#9AA8A0" />}
                    {parts.to && <ValueChip value={parts.to} />}
                    {i.ai && (
                      <span className="is-advice-chip">
                        <IdeaIcon name="sparkle" size={11} />
                        By AI
                      </span>
                    )}
                  </div>
                  <Diff entry={i} />
                </div>
                <span className="is-activity-who" title={who(i.author)}>
                  <Avatar name={i.author ?? '?'} size={22} />
                  <span className="is-sr">{who(i.author)}</span>
                </span>
                <span className="is-muted is-activity-time" title={absoluteTime(i.at)}>
                  {relativeTime(i.at)}
                </span>
              </div>
            );
          })}
        </section>
      ))}
      {all.length > shown && (
        <button
          type="button"
          className="is-btn is-btn-sm"
          style={{ marginTop: 12 }}
          onClick={() => setShown((n) => n + ACTIVITY_PAGE)}
        >
          Show {Math.min(ACTIVITY_PAGE, all.length - shown)} earlier changes
        </button>
      )}
    </div>
  );
}
