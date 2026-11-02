import { useMemo, useState, type ReactNode } from 'react';
import { useTeamAway, type TeamAway } from '../../api/aiTeam';
import { useDecisions, useStories } from '../../api/stories';
import type { TeamCard } from '../../types/aiTeam';
import type { Decision, StoryView } from '../../types/story';
import { useAiBoardState } from '../ai/aiUi';
import { useToast } from '../Toast';
import { Ico, RoleBadge, StoryStateChip, storyFace, type StoryFace } from '../story/storyUi';
import { KindChip, OverrideDialog } from './DecidedTab';
import { Badge, TicketChip } from './teamUi';
import { fmtClock, fmtTokens, fmtUsd } from './teamFormat';
import './away.css';

/** "today at 18:02", "yesterday at 18:02", "on Friday at 18:02", "on Oct 28 at 18:02". */
export function leftWords(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const days = Math.round((new Date(now).setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86400000);
  const at = fmtClock(iso);
  if (days <= 0) return `today at ${at}`;
  if (days === 1) return `yesterday at ${at}`;
  if (days < 7) return `on ${d.toLocaleDateString([], { weekday: 'long' })} at ${at}`;
  return `on ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} at ${at}`;
}

/** "15 hours ago", "40 minutes ago", "3 days ago". */
export function agoWords(iso: string, now: Date = new Date()): string {
  const min = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60000));
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const days = Math.round(h / 24);
  return `${days} days ago`;
}

/** "15 h", "40 min", "3 d": how long the person was away. */
function awayFor(since: string, until: string): string {
  const min = Math.max(0, Math.round((new Date(until).getTime() - new Date(since).getTime()) / 60000));
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`;
}

/** "Fri 18:02". */
function dayClock(iso: string): string {
  return `${new Date(iso).toLocaleDateString([], { weekday: 'short' })} ${fmtClock(iso)}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The face of a Story as it is now: the Story API's own when it answered, else the state the away answer has. */
function faceOf(id: string, state: string | null | undefined, views: Map<string, StoryView>): StoryFace {
  const v = views.get(id);
  if (v) return storyFace(v);
  return (state as StoryFace) || 'in_progress';
}

/** The words of everything the summary counts, shared by the card, the full summary and Copy as text. */
function useFacts(a: TeamAway, views: Map<string, StoryView>) {
  return useMemo(() => {
    const toReview = a.stories.filter((s) => s.to?.state === 'review' && s.from?.state !== 'review').length;
    const toDone = a.stories.filter((s) => s.to?.state === 'done' && s.from?.state !== 'done').length;
    const blocked = a.stories.filter((s) => faceOf(s.id, s.to?.state, views) === 'blocked').length;
    const storyHint =
      [
        toReview ? `${toReview} to Review` : null,
        toDone ? `${toDone} done` : null,
        blocked ? `${blocked} blocked` : null,
      ]
        .filter(Boolean)
        .join(', ') || (a.stories.length ? 'none changed state' : 'nothing moved');
    const across = new Set(a.finished.map((f) => f.storyId).filter(Boolean)).size;
    const finishedHint = a.finished.length
      ? across
        ? `across ${plural(across, 'Story', 'Stories')}`
        : 'none in a Story'
      : 'nothing finished';
    const stillOpen = a.needed.filter((n) => n.open).length;
    const neededHint = !a.needed.length
      ? 'nobody waited for you'
      : stillOpen === a.needed.length
        ? a.needed.length === 1
          ? 'it still waits for you'
          : a.needed.length === 2
            ? 'both still wait for you'
            : 'all still wait for you'
        : stillOpen
          ? `${stillOpen} still wait${stillOpen === 1 ? 's' : ''} for you`
          : 'all answered';
    const decidedHint = a.decided.count
      ? `${a.decided.overridable} can still be overridden`
      : 'nothing decided in your place';
    const spentHint = `${fmtTokens(a.spent.tokens)} tokens${a.spent.dailyCap ? `, cap ${fmtUsd(a.spent.dailyCap)} a day` : ''}`;
    return { storyHint, finishedHint, neededHint, decidedHint, spentHint };
  }, [a, views]);
}

/** What a Story row says under its title: why it is blocked, what finished, or how many runs it had. */
function storyLine(s: TeamAway['stories'][number], a: TeamAway, views: Map<string, StoryView>): string {
  const v = views.get(s.id);
  if (v?.blocked?.text && storyFace(v) === 'blocked') return v.blocked.text;
  const done = a.finished.filter((f) => f.storyId === s.id).map((f) => f.ticketId);
  if (done.length > 3) return `${done[0]} and ${done.length - 1} more finished`;
  if (done.length) return `${done.join(', ')} finished`;
  return `${plural(s.runs, 'run')} while you were away`;
}

function Stat({ n, label, hint, amber }: { n: ReactNode; label: string; hint: string; amber?: boolean }) {
  return (
    <div className="aw-stat">
      <div className="aw-stat-top">
        <span className="aw-stat-n" style={amber ? { color: '#7A5A06' } : undefined}>
          {n}
        </span>
        <span className="aw-stat-label">{label}</span>
      </div>
      <div className="at-hint-sm">{hint}</div>
    </div>
  );
}

function StoryRows({
  a,
  views,
  max,
  onOpenStory,
}: {
  a: TeamAway;
  views: Map<string, StoryView>;
  max?: number;
  onOpenStory: (id: string) => void;
}) {
  return (
    <>
      {a.stories.slice(0, max ?? a.stories.length).map((s) => {
        const total = s.to?.total || s.from?.total || 0;
        const before = s.from?.done ?? 0;
        const after = s.to?.done ?? before;
        const pct = (n: number) => (total ? Math.max(0, Math.min(100, (n / total) * 100)) : 0);
        return (
          <div key={s.id} className="aw-story" data-testid="away-story">
            <span className="aw-story-ico">
              <Ico name="story" size={12} color="#1B3A6B" />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', gap: 7, alignItems: 'center', minWidth: 0 }}>
                <button type="button" className="aw-link-title" onClick={() => onOpenStory(s.id)}>
                  {s.title}
                </button>
                <span className="aw-mono">{s.id}</span>
              </div>
              <div className="at-hint-sm">{storyLine(s, a, views)}</div>
            </div>
            <div className="aw-progress">
              <div className="aw-bar">
                <i style={{ width: `${pct(before)}%`, background: '#2E6F40' }} />
                <i style={{ width: `${pct(after - before)}%`, background: '#7DBF8E' }} />
              </div>
              <span>
                {s.from ? `${before} of ${s.from.total}` : 'new'} &rarr; {after} of {total}
              </span>
            </div>
            <span className="aw-story-chip">
              <StoryStateChip face={faceOf(s.id, s.to?.state, views)} />
            </span>
          </div>
        );
      })}
    </>
  );
}

function Head({ since, long, onClose }: { since: string; long?: boolean; onClose: () => void }) {
  return (
    <div className="aw-head">
      <span className="aw-moon">
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#3A4A3E"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />
        </svg>
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="aw-title">While you were away</div>
        <div className="at-hint">
          Since you left {leftWords(since)}, {agoWords(since)}.
          {long ? ' Worked out from the runs and steps the board keeps.' : ''}
        </div>
      </div>
      <button type="button" className="dy-x" aria-label="Close" onClick={onClose} data-testid="away-close">
        <Ico name="x" size={14} />
      </button>
    </div>
  );
}

export interface AwayActions {
  onOpenTicket: (ticketId: string) => void;
  onOpenStory: (storyId: string) => void;
  /** Close the full summary (if open) and show the Needs you rows. */
  onOpenWaiting: () => void;
  onSeeDecided: () => void;
  onResume: () => void;
}

function useViews(projectId: string): Map<string, StoryView> {
  const stories = useStories(projectId);
  return useMemo(() => new Map((stories.data ?? []).map((s) => [s.id, s])), [stories.data]);
}

/**
 * While you were away (design/screens/ai-story-flow.md, M2): the card at the top of Now when the person comes back
 * after 30 minutes away. It says plainly when nothing happened, when only they are needed, and when AI was paused.
 */
export function AwayCard({
  projectId,
  since,
  onClose,
  onOpenFull,
  actions,
}: {
  projectId: string;
  since: string;
  onClose: () => void;
  onOpenFull: () => void;
  actions: AwayActions;
}) {
  const q = useTeamAway(projectId, since);
  const views = useViews(projectId);
  const { settings } = useAiBoardState();
  if (!q.data) return null;
  const a = q.data;
  return <AwayCardBody a={a} views={views} settings={settings} {...{ onClose, onOpenFull, actions }} />;
}

function AwayCardBody({
  a,
  views,
  settings,
  onClose,
  onOpenFull,
  actions,
}: {
  a: TeamAway;
  views: Map<string, StoryView>;
  settings: ReturnType<typeof useAiBoardState>['settings'];
  onClose: () => void;
  onOpenFull: () => void;
  actions: AwayActions;
}) {
  const f = useFacts(a, views);
  const hours = (new Date(a.until).getTime() - new Date(a.since).getTime()) / 3600000;
  const waitBtn = (primary: boolean) =>
    a.waiting > 0 && (
      <button
        type="button"
        className={`st-btn st-btn-sm${primary ? ' st-btn-primary' : ''}`}
        onClick={actions.onOpenWaiting}
        data-testid="away-open-waiting"
      >
        <Ico name="hand" size={13} />
        Open the {a.waiting} that wait{a.waiting === 1 ? 's' : ''}
      </button>
    );
  const dismiss = (
    <button type="button" className="st-btn st-btn-sm" onClick={onClose} data-testid="away-dismiss">
      Dismiss
    </button>
  );

  if (!a.ran) {
    let body: ReactNode;
    let buttons: ReactNode;
    let state: string;
    if (a.pausedAll) {
      state = 'paused';
      const by = settings?.pausedBy;
      const at = settings?.pausedAt ? fmtClock(settings.pausedAt) : '';
      body = (
        <>
          <b>AI was paused for all of it.</b> Pause all AI was turned on{by ? ` by ${by}` : ''}
          {at ? ` at ${at}` : ''}, so nothing ran.
          {a.waiting ? ` ${plural(a.waiting, 'thing')} wait${a.waiting === 1 ? 's' : ''} for you.` : ''}
        </>
      );
      buttons = (
        <>
          <button
            type="button"
            className="st-btn st-btn-sm st-btn-primary"
            onClick={actions.onResume}
            data-testid="away-resume"
          >
            <Ico name="play" size={12} />
            Resume the AI
          </button>
          {dismiss}
        </>
      );
    } else if (a.waiting > 0) {
      state = 'needed';
      body = (
        <>
          <b>
            Nothing ran, and {plural(a.waiting, 'thing')} wait{a.waiting === 1 ? 's' : ''} for you.
          </b>{' '}
          The team has been idle since you left. Nothing else is happening because of {a.waiting === 1 ? 'it' : 'them'}.
        </>
      );
      buttons = (
        <>
          {waitBtn(true)}
          {dismiss}
        </>
      );
    } else {
      state = 'quiet';
      body = (
        <>
          {hours >= 6 ? 'A quiet night' : 'All quiet'}: nothing ran and nothing waits for you. The team is idle, not
          stuck.
        </>
      );
      buttons = dismiss;
    }
    return (
      <div className="aw-card quiet" data-testid={`away-${state}`}>
        <Head since={a.since} onClose={onClose} />
        <div className="aw-quiet-text">{body}</div>
        <div style={{ display: 'flex', gap: 8 }}>{buttons}</div>
      </div>
    );
  }

  return (
    <div className="aw-card" data-testid="away-card">
      <Head since={a.since} long onClose={onClose} />
      <div className="aw-stats">
        <Stat n={a.stories.length} label="Stories moved" hint={f.storyHint} />
        <Stat n={a.finished.length} label="tickets finished" hint={f.finishedHint} />
        <Stat n={a.needed.length} label="times you were needed" hint={f.neededHint} amber={a.needed.length > 0} />
        <Stat n={a.decided.count} label="decided for you" hint={f.decidedHint} />
        <Stat n={fmtUsd(a.spent.usd)} label="spent" hint={f.spentHint} />
      </div>
      {a.stories.length > 0 && (
        <div>
          <StoryRows a={a} views={views} max={3} onOpenStory={actions.onOpenStory} />
        </div>
      )}
      <div className="aw-foot">
        <button
          type="button"
          className="st-btn st-btn-sm st-btn-primary"
          onClick={onOpenFull}
          data-testid="away-see-full"
        >
          <Ico name="right" size={13} />
          See the full summary
        </button>
        {waitBtn(false)}
        <span style={{ flex: 1 }} />
        <span className="at-hint-sm">Shown after 30 minutes away. Closing it hides it until you are away again.</span>
      </div>
    </div>
  );
}

/** The summary as plain text, for Copy as text. */
export function awayText(a: TeamAway, nameOf: (id: string | null) => string): string {
  const lines = [
    `While you were away: ${dayClock(a.since)} to ${dayClock(a.until)} (${awayFor(a.since, a.until)})`,
    '',
    `${a.stories.length} Stories moved · ${a.finished.length} tickets finished · ${a.needed.length} times you were needed · ${a.decided.count} decided for you · ${fmtUsd(a.spent.usd)} spent (${fmtTokens(a.spent.tokens)} tokens)`,
  ];
  if (a.stories.length) {
    lines.push('', 'Stories that moved');
    for (const s of a.stories)
      lines.push(
        `- ${s.title} (${s.id}): ${s.from ? `${s.from.done} of ${s.from.total}` : 'new'} -> ${s.to?.done ?? 0} of ${s.to?.total ?? 0}`,
      );
  }
  if (a.finished.length) {
    lines.push('', 'Tickets that finished');
    for (const t of a.finished)
      lines.push(`- ${t.ticketId} ${t.title}${t.at ? ` (${fmtClock(t.at)})` : ''}${t.sentBack ? ', sent back' : ''}`);
  }
  if (a.needed.length) {
    lines.push('', `You were needed ${a.needed.length} times`);
    for (const n of a.needed)
      lines.push(
        `- ${fmtClock(n.at)} ${n.text}${n.ticketId ? ` on ${n.ticketId}` : ''}${n.memberId ? ` (${nameOf(n.memberId)})` : ''}${n.open ? ', still waiting' : ''}`,
      );
  }
  if (a.spent.byStory.length) {
    lines.push('', 'Spent');
    for (const s of a.spent.byStory) lines.push(`- ${s.title}: ${fmtTokens(s.tokens)} · ${fmtUsd(s.usd)}`);
  }
  if (a.failed.length) {
    lines.push('', 'What went wrong');
    for (const r of a.failed) lines.push(`- ${r.ticketId}: ${r.text}${r.retried ? ' (tried again)' : ''}`);
  }
  return lines.join('\n');
}

function Panel({ title, count, children }: { title: string; count?: ReactNode; children: ReactNode }) {
  return (
    <div className="aw-panel">
      <div className="aw-panel-head">
        <span className="at-label" style={{ fontSize: 11 }}>
          {title}
        </span>
        <span style={{ flex: 1 }} />
        {count != null && <span className="at-hint">{count}</span>}
      </div>
      <div className="aw-panel-body">{children}</div>
    </div>
  );
}

/** "Still waiting, 15 h." */
function stillWaiting(at: string, until: string): string {
  return `Still waiting, ${awayFor(at, until)}.`;
}

/** The full summary (M2, frame 2): everything the card counts, with each item. */
export function AwaySummary({
  projectId,
  since,
  members,
  onBack,
  onMarkSeen,
  actions,
}: {
  projectId: string;
  since: string;
  members: TeamCard[];
  onBack: () => void;
  onMarkSeen: () => void;
  actions: AwayActions;
}) {
  const q = useTeamAway(projectId, since);
  const views = useViews(projectId);
  const decisions = useDecisions(projectId, { since, limit: 3 });
  const toast = useToast();
  const [asking, setAsking] = useState<Decision | null>(null);
  const byId = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  if (!q.data) {
    return <div className="at-hint">{q.isError ? "Couldn't load what happened." : 'Working out what happened…'}</div>;
  }
  const a = q.data;
  return (
    <SummaryBody
      {...{ a, views, byId, onBack, onMarkSeen, actions, projectId }}
      decided={decisions.data?.items ?? []}
      asking={asking}
      setAsking={setAsking}
      onCopy={async () => {
        const text = awayText(a, (id) => (id ? (byId.get(id)?.name ?? '') : ''));
        try {
          await navigator.clipboard.writeText(text);
          toast.success('Copied', 'The summary is on the clipboard.');
        } catch {
          toast.error("Couldn't copy", 'The browser did not allow the clipboard.');
        }
      }}
    />
  );
}

function SummaryBody({
  a,
  views,
  byId,
  decided,
  asking,
  setAsking,
  projectId,
  onBack,
  onMarkSeen,
  onCopy,
  actions,
}: {
  a: TeamAway;
  views: Map<string, StoryView>;
  byId: Map<string, TeamCard>;
  decided: Decision[];
  asking: Decision | null;
  setAsking: (d: Decision | null) => void;
  projectId: string;
  onBack: () => void;
  onMarkSeen: () => void;
  onCopy: () => void;
  actions: AwayActions;
}) {
  const f = useFacts(a, views);
  const running = [...views.values()].filter((s) => s.state === 'in_progress').length;
  const who = (id: string | null, fallbackRole?: string) => {
    const m = id ? byId.get(id) : undefined;
    return m ? <Badge name={m.name} color={m.color} size={22} /> : <RoleBadge role={fallbackRole ?? 'ai'} size={22} />;
  };
  const maxTokens = Math.max(...a.spent.byStory.map((s) => s.tokens), 1);
  return (
    <div className="aw-full" data-testid="away-summary">
      <div className="aw-crumbs">
        <button type="button" className="aw-crumb" onClick={onBack}>
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M19 12H5M11 6l-6 6 6 6" />
          </svg>
          Now
        </button>
        <Ico name="right" size={12} color="#9AA8A0" />
        <b style={{ fontSize: 13 }}>While you were away</b>
        <span style={{ flex: 1 }} />
        <button type="button" className="st-btn st-btn-sm" onClick={onCopy} data-testid="away-copy">
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="8" y="8" width="12" height="12" rx="2" />
            <path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />
          </svg>
          Copy as text
        </button>
        <button type="button" className="st-btn st-btn-sm" onClick={onMarkSeen} data-testid="away-mark-seen">
          <Ico name="check" size={13} />
          Mark as seen
        </button>
      </div>

      <div className="aw-stats boxed">
        <Stat n={awayFor(a.since, a.until)} label="away" hint={`${dayClock(a.since)} to ${dayClock(a.until)}`} />
        <Stat n={a.stories.length} label="Stories moved" hint={f.storyHint} />
        <Stat n={a.finished.length} label="tickets finished" hint={f.finishedHint} />
        <Stat
          n={a.needed.length}
          label="times you were needed"
          hint={f.neededHint.replace(' for you', '')}
          amber={a.needed.length > 0}
        />
        <Stat n={a.decided.count} label="decided for you" hint={f.decidedHint.replace('still ', '')} />
        <Stat n={fmtUsd(a.spent.usd)} label="spent" hint={`${fmtTokens(a.spent.tokens)} tokens`} />
      </div>

      <div className="aw-cols">
        <div className="aw-col-main">
          <Panel title="Stories that moved" count={running ? `${running} running` : a.stories.length}>
            {a.stories.length ? (
              <StoryRows a={a} views={views} onOpenStory={actions.onOpenStory} />
            ) : (
              <div className="at-hint aw-none">No Story moved.</div>
            )}
          </Panel>
          <Panel title="Tickets that finished" count={a.finished.length}>
            {a.finished.length ? (
              a.finished.map((t) => {
                const m = t.memberId ? byId.get(t.memberId) : undefined;
                return (
                  <div key={`${t.ticketId}-${t.at}`} className="aw-ticket" data-testid="away-finished">
                    <Ico name="circleCheck" size={14} color="#2E6F40" />
                    <TicketChip id={t.ticketId} onOpen={actions.onOpenTicket} />
                    <span style={{ flex: 1, fontWeight: 600, minWidth: 0 }}>{t.title}</span>
                    {t.sentBack > 0 && (
                      <span className="at-chip" style={{ background: '#FDECE8', color: '#A5321E' }}>
                        sent back {t.sentBack === 1 ? 'once' : `${t.sentBack} times`}
                      </span>
                    )}
                    {m && <Badge name={m.name} color={m.color} size={20} />}
                    <span className="at-hint-sm" style={{ width: 46, textAlign: 'right' }}>
                      {fmtClock(t.at)}
                    </span>
                  </div>
                );
              })
            ) : (
              <div className="at-hint aw-none">No ticket finished.</div>
            )}
          </Panel>
        </div>

        <div className="aw-col-side">
          <Panel title={`You were needed ${plural(a.needed.length, 'time')}`}>
            {a.needed.length ? (
              a.needed.map((n, i) => (
                <div key={`${n.at}-${i}`} className="aw-needed" data-testid="away-needed">
                  {who(n.memberId, n.kind === 'plan' ? 'pm' : undefined)}
                  <div style={{ fontSize: 12.5, lineHeight: 1.5, flex: 1, minWidth: 0 }}>
                    <b>
                      {fmtClock(n.at)} · {n.text}
                      {n.ticketId && !n.text.includes(n.ticketId) ? ` on ${n.ticketId}` : ''}
                    </b>
                    <br />
                    {n.open ? (
                      <span style={{ color: '#7A5A06', fontWeight: 600 }}>{stillWaiting(n.at, a.until)}</span>
                    ) : (
                      <span style={{ color: '#5B6B60' }}>Answered.</span>
                    )}
                    {n.open && n.ticketId && (
                      <>
                        {' '}
                        <button type="button" className="aw-link" onClick={() => actions.onOpenTicket(n.ticketId!)}>
                          Open
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))
            ) : (
              <div className="at-hint aw-none">Nothing waited for you.</div>
            )}
          </Panel>

          <Panel title="Decided for you" count={a.decided.count}>
            {decided.length ? (
              decided.map((d) => (
                <div key={d.id} className="aw-decided">
                  <KindChip kind={d.kind} />
                  <span style={{ fontSize: 12.5, flex: 1, minWidth: 0 }}>{d.title}</span>
                  {d.state === 'in_effect' && d.canOverride && (
                    <button type="button" className="st-btn st-btn-sm" onClick={() => setAsking(d)}>
                      <Ico name="undo" size={13} />
                      Override
                    </button>
                  )}
                </div>
              ))
            ) : (
              <div className="at-hint aw-none">Nothing was decided in your place.</div>
            )}
            {a.decided.count > 0 && (
              <button type="button" className="aw-link" style={{ paddingTop: 6 }} onClick={actions.onSeeDecided}>
                See all {a.decided.count} in Decided for you
              </button>
            )}
          </Panel>

          <Panel title="Spent" count={fmtUsd(a.spent.usd)}>
            {a.spent.byStory.length ? (
              a.spent.byStory.map((s, i) => (
                <div key={s.storyId ?? 'none'} className="aw-spent">
                  <span className="aw-spent-name">{s.title}</span>
                  <div className="aw-bar" style={{ flex: 1 }}>
                    <i
                      style={{
                        width: `${Math.max(2, (s.tokens / maxTokens) * 100)}%`,
                        background: s.storyId == null ? '#C7D2CB' : i === 0 ? '#2E6F40' : '#7DBF8E',
                      }}
                    />
                  </div>
                  <span className="aw-spent-n">
                    {fmtTokens(s.tokens)} · {fmtUsd(s.usd)}
                  </span>
                </div>
              ))
            ) : (
              <div className="at-hint aw-none">Nothing was spent.</div>
            )}
          </Panel>

          <Panel title="What went wrong">
            {a.failed.length ? (
              <div className="aw-wrong">
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#C4432A"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                  style={{ flexShrink: 0, marginTop: 2 }}
                >
                  <path d="M12 4l9 16H3L12 4zM12 10v4M12 17v.5" />
                </svg>
                <span>
                  <b>{plural(a.failed.length, 'run')} failed.</b>{' '}
                  {a.failed
                    .map(
                      (r) =>
                        `${r.ticketId}: ${r.text}${r.at ? ` at ${fmtClock(r.at)}` : ''}. ${
                          r.retried
                            ? r.retryState === 'finished'
                              ? 'The retry passed.'
                              : 'It was tried again.'
                            : 'Not tried again.'
                        }`,
                    )
                    .join(' ')}
                  {a.failed.every((r) => r.retried && r.retryState === 'finished') ? ' Nothing to do.' : ''}
                </span>
              </div>
            ) : (
              <div className="at-hint aw-none">Nothing failed.</div>
            )}
          </Panel>
        </div>
      </div>
      {asking && <OverrideDialog d={asking} projectId={projectId} onClose={() => setAsking(null)} />}
    </div>
  );
}
