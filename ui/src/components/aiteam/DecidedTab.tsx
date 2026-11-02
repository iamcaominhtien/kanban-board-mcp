import { useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { rangeSince, useDecidedForYou } from '../../api/aiTeam';
import { useDecisions, useOverrideDecision, type DecisionFilter } from '../../api/stories';
import type { TeamRange } from '../../types/aiTeam';
import type { Decision } from '../../types/story';
import { Ico, RoleBadge, errorText } from '../story/storyUi';
import { fmtClock } from './teamFormat';
import './decided.css';

/** The look and the words of each kind of decision (M1). */
export const DECISION_KIND: Record<string, { label: string; bg: string; fg: string; icon: string }> = {
  approve_design: { label: 'Approved a design', bg: '#E9EAF7', fg: '#3F4390', icon: 'circleCheck' },
  send_back: { label: 'Sent back', bg: '#FDECE8', fg: '#A5321E', icon: 'undo' },
  split: { label: 'Split a ticket', bg: '#E8F1FA', fg: '#244E78', icon: 'group' },
  retry: { label: 'Retried a step', bg: '#F1F3F1', fg: '#3A4A3E', icon: 'reopen' },
  answer: { label: 'Answered a request', bg: '#FEF3D9', fg: '#7A5A06', icon: 'chat' },
  permission: { label: 'Approved a permission', bg: '#FEF3D9', fg: '#7A5A06', icon: 'chat' },
  approve_plan: { label: 'Approved a plan', bg: '#E6F2EA', fg: '#1F5A31', icon: 'planning' },
};
const KIND_ORDER = Object.keys(DECISION_KIND);

/** The look of a kind of decision, with a plain fallback for a kind the UI does not know yet. */
export function kindLook(kind: string) {
  return DECISION_KIND[kind] ?? { label: kind.replace(/_/g, ' '), bg: '#F1F3F1', fg: '#3A4A3E', icon: 'dots' };
}

/** The chip of a kind of decision. */
export function KindChip({ kind }: { kind: string }) {
  const k = kindLook(kind);
  return (
    <span className="at-chip" style={{ background: k.bg, color: k.fg }}>
      <Ico name={k.icon} size={11} color={k.fg} />
      {k.label}
    </span>
  );
}

/** "Overridden by you", or by the person named. */
function overriddenBy(d: Decision): string {
  return d.overriddenBy && !/^(user|you|person|me)$/i.test(d.overriddenBy) ? d.overriddenBy : 'you';
}

/** What Override does for each kind (M1, the table under the frames). */
function whatHappens(d: Decision): ReactNode {
  const t = d.ticketId ?? 'the ticket';
  switch (d.kind) {
    case 'approve_design':
      return (
        <>
          The design step of {t} returns to <b>Waiting for you</b>. You approve it or send it back.
        </>
      );
    case 'send_back':
      return <>{t} goes back to the step that sent it back, as if it had not been sent.</>;
    case 'split':
      return (
        <>
          The pieces go to the Recycle Bin, with their comments and branch, and {t} goes on as one. The Bin keeps this
          undoable.
        </>
      );
    case 'approve_plan':
      return (
        <>
          The plan returns to <b>Waiting for you</b>. You approve it or send it back.
        </>
      );
    case 'answer':
      return <>The question on {t} is asked again.</>;
    case 'permission':
      return (
        <>
          The permission on {t} goes back to <b>Waiting for you</b>.
        </>
      );
    default:
      return <>The PM&rsquo;s decision is reversed on {t}.</>;
  }
}

const ARROW = <path d="M5 12h14M13 6l6 6-6 6" />;

/** "Override this decision?" (M1, frame 2): says what happens, asks an optional why, and shows a refusal (409). */
export function OverrideDialog({ d, projectId, onClose }: { d: Decision; projectId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const override = useOverrideDecision(projectId, d.storyId ?? undefined);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    setError(null);
    try {
      await override.mutateAsync({ id: d.id, note: note.trim() || undefined });
      void qc.invalidateQueries({ queryKey: ['ai', 'team', 'away'] });
      onClose();
    } catch (err) {
      setError(errorText(err, 'This decision can no longer be overridden.'));
      // what the list says may be stale: read it again so the row shows why
      void qc.invalidateQueries({ queryKey: ['ai', 'decisions', projectId] });
    }
  };
  return (
    <div className="dy-overlay" onClick={onClose}>
      <div
        className="dy-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Override this decision?"
        data-testid="override-dialog"
      >
        <div className="dy-dialog-head">
          <div style={{ flex: 1 }}>
            <b style={{ fontSize: 15 }}>Override this decision?</b>
            <div className="at-hint" style={{ marginTop: 2 }}>
              Possible until something has been built on it. Nothing is deleted: the old decision stays in the list.
            </div>
          </div>
          <button type="button" className="dy-x" aria-label="Close" onClick={onClose}>
            <Ico name="x" size={14} />
          </button>
        </div>
        <div className="dy-dialog-body">
          <div className="dy-quote">
            <RoleBadge role="pm" size={22} title={d.member?.name ?? 'PM'} />
            <div style={{ fontSize: 12.5, lineHeight: 1.5 }}>
              <b>{d.title}</b> at {fmtClock(d.at)}
              {d.why && (
                <>
                  <br />
                  <span style={{ color: '#5B6B60' }}>{d.why}</span>
                </>
              )}
            </div>
          </div>
          <div style={{ fontSize: 12.5, fontWeight: 700 }}>What happens</div>
          <div className="dy-happens">
            {[
              whatHappens(d),
              <>The PM is told you overrode it, and why, so the next decision like it learns from this one.</>,
              <>
                It is marked <b>Overridden by you</b> here and in the Story, with your name and the time.
              </>,
            ].map((line, i) => (
              <div key={i}>
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#2E6F40"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                  style={{ flexShrink: 0, marginTop: 3 }}
                >
                  {ARROW}
                </svg>
                <span>{line}</span>
              </div>
            ))}
          </div>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: '#3A4A3E' }}>Why (optional, the PM reads it)</span>
            <input
              className="dy-input"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              autoFocus
              data-testid="override-note"
            />
          </label>
          {error && (
            <div className="dy-error" role="alert" data-testid="override-error">
              {error}
            </div>
          )}
        </div>
        <div className="dy-dialog-foot">
          <span style={{ flex: 1 }} />
          <button type="button" className="st-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="st-btn st-btn-primary"
            disabled={override.isPending}
            onClick={() => void confirm()}
            data-testid="override-confirm"
          >
            <Ico name="undo" size={13} />
            Override and tell the PM
          </button>
        </div>
      </div>
    </div>
  );
}

/** The result column: the state, and what it means now. */
function Result({ d }: { d: Decision }) {
  if (d.state === 'overridden') {
    return (
      <div>
        <span className="at-chip" style={{ background: '#FEF3D9', color: '#7A5A06' }}>
          <Ico name="undo" size={11} color="#7A5A06" />
          Overridden by {overriddenBy(d)}
          {d.overriddenAt ? ` at ${fmtClock(d.overriddenAt)}` : ''}
        </span>
        {d.overrideNote && <div className="at-hint-sm dy-result-hint">&ldquo;{d.overrideNote}&rdquo;</div>}
      </div>
    );
  }
  if (!d.canOverride) {
    return (
      <div>
        <span className="at-chip" style={{ background: '#F1F3F1', color: '#5B6B60' }}>
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <rect x="5" y="11" width="14" height="9" rx="2" />
            <path d="M8 11V8a4 4 0 0 1 8 0v3" />
          </svg>
          Can no longer be overridden
        </span>
        {(d.whyNot || d.result) && (
          <div className="at-hint-sm dy-result-hint" data-testid="decided-why-not">
            {d.whyNot || d.result}
          </div>
        )}
      </div>
    );
  }
  const now = d.result.replace(/^In effect[:.]?\s*/i, '');
  return (
    <div>
      <span className="at-chip" style={{ background: '#E6F2EA', color: '#1F5A31' }}>
        <Ico name="check" size={11} color="#1F5A31" />
        In effect
      </span>
      {now && <div className="at-hint-sm dy-result-hint">{now.charAt(0).toUpperCase() + now.slice(1)}</div>}
    </div>
  );
}

/** "Today", "Yesterday", "Mon, Oct 28". */
function dayOf(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const days = Math.round((new Date(now).setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

export interface DecidedActions {
  onOpenTicket: (ticketId: string) => void;
  /** Open a Story's page; without it the Story's ticket opens. */
  onOpenStory?: (storyId: string) => void;
}

function Row({
  d,
  on,
  actions,
  onOverride,
}: {
  d: Decision;
  on: boolean;
  actions: DecidedActions;
  onOverride: () => void;
}) {
  const openStory = (id: string) => (actions.onOpenStory ? actions.onOpenStory(id) : actions.onOpenTicket(id));
  return (
    <div className={`dy-row${on ? ' on' : ''}`} data-testid="decided-row">
      <span className="dy-when">{fmtClock(d.at)}</span>
      <div style={{ minWidth: 0 }}>
        <div className="dy-what">
          <KindChip kind={d.kind} />
          <b style={{ fontSize: 13 }}>{d.title}</b>
        </div>
        {d.why && <div className="dy-why">{d.why}</div>}
      </div>
      <div className="dy-story">
        {d.storyId ? (
          <button type="button" className="dy-story-link" onClick={() => openStory(d.storyId!)}>
            <Ico name="story" size={12} color="#1B3A6B" />
            <span>{d.storyTitle ?? d.storyId}</span>
          </button>
        ) : (
          <span className="at-hint-sm">Not in a Story</span>
        )}
        {d.ticketId && (
          <button type="button" className="dy-mono" onClick={() => actions.onOpenTicket(d.ticketId!)}>
            {d.ticketId}
          </button>
        )}
      </div>
      <Result d={d} />
      <div style={{ textAlign: 'right' }}>
        {d.state === 'in_effect' && (
          <button
            type="button"
            className="st-btn st-btn-sm"
            disabled={!d.canOverride}
            title={d.canOverride ? 'Override this decision' : (d.whyNot ?? 'It can no longer be overridden')}
            onClick={onOverride}
            data-testid="decided-override"
          >
            <Ico name="undo" size={13} />
            Override
          </button>
        )}
      </div>
    </div>
  );
}

const RANGE_WORDS: Record<TeamRange, { tile: string; tail: string }> = {
  today: { tile: 'Decided today', tail: 'today' },
  '7d': { tile: 'Decided in 7 days', tail: 'in the last 7 days' },
  '30d': { tile: 'Decided in 30 days', tail: 'in the last 30 days' },
};
const PAGE = 50;

/**
 * Decided for you (design/screens/ai-story-flow.md, M1): what the PM decided in the person's place, with Override
 * while it still can be, and a plain reason when it no longer can. The mirror of You stepped in.
 */
export function DecidedTab({
  projectId,
  range,
  actions,
}: {
  projectId: string;
  range: TeamRange;
  actions: DecidedActions;
}) {
  const [story, setStory] = useState('');
  const [kind, setKind] = useState('');
  const [overriddenOnly, setOverriddenOnly] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [asking, setAsking] = useState<Decision | null>(null);
  const all = useDecidedForYou(projectId, range);
  const filter: DecisionFilter = {
    since: rangeSince(range),
    limit,
    ...(story ? { story } : {}),
    ...(kind ? { kind } : {}),
    ...(overriddenOnly ? { overridden: true } : {}),
  };
  const shown = useDecisions(projectId, filter);

  const stories = useMemo(() => {
    const seen = new Map<string, string>();
    for (const d of all.data?.items ?? []) if (d.storyId) seen.set(d.storyId, d.storyTitle ?? d.storyId);
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [all.data]);

  if (!all.data) {
    return <div className="at-hint">{all.isError ? "Couldn't load the decisions." : 'Loading the decisions…'}</div>;
  }
  const t = all.data.totals;
  const words = RANGE_WORDS[range];
  const pms = [...new Set(all.data.items.map((d) => d.member?.name).filter(Boolean))] as string[];
  const view = shown.data ?? (story || kind || overriddenOnly ? null : all.data);
  const items = (view?.items ?? []).slice(0, limit);
  const kinds = [...(view?.kinds ?? all.data.kinds)].sort(
    (a, b) => (KIND_ORDER.indexOf(a.kind) + 1 || 99) - (KIND_ORDER.indexOf(b.kind) + 1 || 99),
  );
  const scopeTotal = view?.totals.decided ?? t.decided;
  const matching = kind
    ? overriddenOnly
      ? items.length
      : (kinds.find((k) => k.kind === kind)?.count ?? items.length)
    : overriddenOnly
      ? (view?.totals.overridden ?? items.length)
      : scopeTotal;
  const filtered = !!(story || kind || overriddenOnly);
  const clear = () => {
    setStory('');
    setKind('');
    setOverriddenOnly(false);
    setLimit(PAGE);
  };

  // grouped by day, newest first as the server sends them
  const groups: { day: string; rows: Decision[] }[] = [];
  for (const d of items) {
    const day = dayOf(d.at);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.rows.push(d);
    else groups.push({ day, rows: [d] });
  }

  const filterWords = [
    overriddenOnly ? 'Overridden' : null,
    story ? `in ${stories.find(([id]) => id === story)?.[1] ?? story}` : null,
    kind ? kindLook(kind).label : null,
  ].filter(Boolean);

  return (
    <>
      <div className="at-tiles" data-testid="decided-tiles">
        <div className="at-tile">
          <div className="at-label">{words.tile}</div>
          <span className="at-total-n">{t.decided}</span>
          <div className="at-hint-sm">
            {t.decided === 0
              ? 'nothing yet'
              : `by ${pms.length ? pms.join(', ') : 'the PM'}, ${stories.length} Stor${stories.length === 1 ? 'y' : 'ies'}`}
          </div>
        </div>
        <div className="at-tile">
          <div className="at-label">Still in effect</div>
          <span className="at-total-n">{t.inEffect}</span>
          <div className="at-hint-sm">
            {t.overridable ? `you can override ${t.overridable} of them` : 'none can be overridden now'}
          </div>
        </div>
        <div className="at-tile">
          <div className="at-label">You overrode</div>
          <span className="at-total-n" style={{ color: '#7A5A06' }}>
            {t.overridden}
          </span>
          <div className="at-hint-sm">
            {t.decided ? `${Math.round((t.overridden / t.decided) * 100)}% of ${t.decided}` : 'nothing to override'}
          </div>
        </div>
        <div className="at-tile">
          <div className="at-label">No longer overridable</div>
          <span className="at-total-n" style={{ color: '#5B6B60' }}>
            {t.final}
          </span>
          <div className="at-hint-sm">something was built on them</div>
        </div>
        <div className="dy-read">
          <div className="at-label" style={{ color: '#1F5A31' }}>
            How to read this
          </div>
          <div style={{ fontSize: 12.5, lineHeight: 1.5 }}>
            The share you overrode is the honest measure of whether to trust the team to run alone. Low and falling:
            widen Team on its own. High: narrow it.
          </div>
        </div>
      </div>

      {t.decided === 0 ? (
        <div className="dy-empty" data-testid="decided-none">
          <span className="dy-empty-ico">
            <Ico name="hand" size={20} color="#3A4A3E" width={1.8} />
          </span>
          <b style={{ fontSize: 14 }}>The PM has decided nothing yet</b>
          <div className="at-hint" style={{ maxWidth: 380, fontSize: 12.5 }}>
            Nothing was decided in your place {words.tail}. While the PM runs the team (Team on its own), every failed
            step, question and request it decides for you is listed here with its reason.
          </div>
        </div>
      ) : (
        <>
          <div className="dy-filters">
            <select
              className="at-select dy-story-select"
              aria-label="Story"
              value={story}
              onChange={(e) => {
                setStory(e.target.value);
                setLimit(PAGE);
              }}
            >
              <option value="">All Stories</option>
              {stories.map(([id, title]) => (
                <option key={id} value={id}>
                  {title}
                </option>
              ))}
            </select>
            <button
              type="button"
              className={`dy-kind${kind ? '' : ' on'}`}
              aria-pressed={!kind}
              onClick={() => setKind('')}
            >
              All<span>{scopeTotal}</span>
            </button>
            {kinds.map((k) => (
              <button
                key={k.kind}
                type="button"
                className={`dy-kind${kind === k.kind ? ' on' : ''}`}
                aria-pressed={kind === k.kind}
                onClick={() => {
                  setKind(kind === k.kind ? '' : k.kind);
                  setLimit(PAGE);
                }}
              >
                {kindLook(k.kind).label}
                <span>{k.count}</span>
              </button>
            ))}
            <span style={{ flex: 1 }} />
            <label className="dy-switch-label">
              <button
                type="button"
                role="switch"
                aria-checked={overriddenOnly}
                aria-label="Overridden only"
                className={`dy-switch${overriddenOnly ? ' on' : ''}`}
                onClick={() => {
                  setOverriddenOnly(!overriddenOnly);
                  setLimit(PAGE);
                }}
              >
                <i />
              </button>
              Overridden <span className="at-hint">{view?.totals.overridden ?? t.overridden}</span>
            </label>
          </div>

          {view && items.length === 0 ? (
            <div className="dy-empty" data-testid="decided-no-match">
              <span className="dy-empty-ico">
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#3A4A3E"
                  strokeWidth="1.8"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M4 5h16l-6 7.5V19l-4-2v-4.5z" />
                </svg>
              </span>
              <b style={{ fontSize: 14 }}>No decision matches</b>
              <div className="at-hint" style={{ fontSize: 12.5 }}>
                {filterWords.join(', ')}: 0 {words.tail}.
              </div>
              <button type="button" className="st-btn st-btn-sm" onClick={clear}>
                Clear the filters
              </button>
            </div>
          ) : (
            <div className="dy-table" data-testid="decided-table">
              <div className="dy-row head at-label">
                <span>When</span>
                <span>What the PM decided, and why</span>
                <span>Story</span>
                <span>Result</span>
                <span />
              </div>
              {!view && (
                <div className="at-hint" style={{ padding: 16 }}>
                  Loading…
                </div>
              )}
              {groups.map((g) => (
                <div key={g.day}>
                  <div className="dy-day at-label">{g.day}</div>
                  {g.rows.map((d) => (
                    <Row key={d.id} d={d} on={asking?.id === d.id} actions={actions} onOverride={() => setAsking(d)} />
                  ))}
                </div>
              ))}
            </div>
          )}

          <div className="dy-foot">
            <span>
              Showing {items.length} of {Math.max(matching, items.length)}
            </span>
            <span style={{ flex: 1 }} />
            <span className="at-hint">Same list as the one on the Story page, narrowed to that Story.</span>
            {items.length >= limit && (
              <button type="button" className="st-btn st-btn-sm" onClick={() => setLimit(limit + PAGE)}>
                Show older
              </button>
            )}
            {filtered && items.length > 0 && (
              <button type="button" className="st-btn st-btn-sm" onClick={clear}>
                Clear the filters
              </button>
            )}
          </div>
        </>
      )}

      {asking && <OverrideDialog d={asking} projectId={projectId} onClose={() => setAsking(null)} />}
    </>
  );
}
