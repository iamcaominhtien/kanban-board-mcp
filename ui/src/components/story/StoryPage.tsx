import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useOverrideDecision, useStory, useStoryAction } from '../../api/stories';
import type { Ticket } from '../../types';
import type { Decision, StoryDetail, StoryPlanItem, StoryView } from '../../types/story';
import { useProject } from '../../api/projects';
import { GiveStoryDialog } from './GiveStoryDialog';
import { PlanEditor, PlanReviewCard } from './PlanReview';
import {
  Ico,
  PausedChip,
  RoleBadge,
  StoryStateChip,
  blockedLead,
  byWord,
  errorText,
  fallbackStory,
  fmtClock,
  fmtSpan,
  fmtTokens,
  planItemState,
  roleOf,
  storyFace,
} from './storyUi';
import styles from './story.module.css';

interface StoryPageProps {
  /** The Story's ticket (a Story's id is its ticket's id). */
  ticket: Ticket;
  allTickets?: Ticket[];
  onClose: () => void;
  onOpenTicket?: (ticket: Ticket) => void;
  /** Show the Story's ticket as a ticket (comments, activity, fields). */
  onOpenAsTicket?: () => void;
}

/**
 * The Story page (design/screens/ai-story-flow.md E): what was asked, how far along it is, what the PM decided in
 * your place, and what it has cost. Opens from the card, from Flow and from anywhere a ticket opens (the ticket modal
 * shows this page for a ticket of type story).
 */
export function StoryPage({ ticket, allTickets = [], onClose, onOpenTicket, onOpenAsTicket }: StoryPageProps) {
  const query = useStory(ticket.id);
  const project = useProject(ticket.projectId);
  const detail: StoryDetail = query.data ?? { ...fallbackStory(ticket, allTickets), decisions: [], children: [] };
  const story: StoryView = detail;
  const face = storyFace(story);
  const action = useStoryAction(story.id, ticket.projectId);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [handing, setHanding] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        if (menuOpen) setMenuOpen(false);
        else onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, menuOpen]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  const openTicket = (id: string | null | undefined) => {
    if (!id) return;
    const t = allTickets.find((x) => x.id.toLowerCase() === id.toLowerCase());
    if (t) onOpenTicket?.(t);
  };

  async function act(a: Parameters<typeof action.mutateAsync>[0], fallback: string) {
    setActionError(null);
    setMenuOpen(false);
    try {
      await action.mutateAsync(a);
    } catch (err) {
      setActionError(errorText(err, fallback));
    }
  }

  const closed = story.state === 'done' || story.state === 'dropped';
  const running = !closed && story.state !== 'draft';
  const pmName = story.pm?.name ?? 'PM';
  const started = story.startedAt ?? story.handedAt;
  const { done, total, building, waiting } = story.progress;
  const metCount = story.criteria.filter((c) => c.state === 'met' || c.done).length;

  return (
    <div
      className={styles.overlay}
      style={{ zIndex: 200 }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={styles.page}
        role="dialog"
        aria-modal="true"
        aria-label={`Story ${story.id}`}
        data-testid="story-page"
      >
        {/* E: the Story page says where it sits */}
        <div className={styles.crumb} data-testid="story-crumb">
          {project.data?.name ?? 'Project'} <span>›</span> Board <span>›</span> <b>{story.id}</b>
        </div>
        <div className={styles.pageHead}>
          <span
            style={{
              width: 27,
              height: 27,
              borderRadius: 7,
              background: '#E6ECF5',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <Ico name="story" size={15} color="#1B3A6B" width={2} />
          </span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, flex: '1 1 260px' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className={styles.storyWord}>Story</span>
              <span className={styles.mono}>{story.id}</span>
              <StoryStateChip face={face} />
              {story.paused && <PausedChip />}
            </div>
            <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, lineHeight: 1.25 }}>
              {story.title || ticket.title}
            </h2>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <RoleBadge role="pm" size={26} title={pmName} />
            <div style={{ fontSize: 12, lineHeight: 1.3 }}>
              <b data-testid="story-pm">
                {story.pm ? `Run by ${byWord(story.pm.name, pmName)}` : 'No PM in this project'}
              </b>
              <br />
              <span style={{ color: '#5B6B60' }}>
                {!story.pm
                  ? 'Make one from the PM pack in Settings › AI'
                  : story.state === 'draft'
                    ? 'not given to the PM yet'
                    : started
                      ? `${closed ? 'ran for' : 'started'} ${fmtSpan(started, closed ? story.closedAt : null, true)}${closed ? '' : ' ago'}`
                      : 'planning'}
              </span>
            </div>
          </div>
          {story.state === 'draft' ? (
            <button
              type="button"
              className={`${styles.btn} ${styles.btnSm} ${styles.btnPrimary}`}
              onClick={() => setHanding(true)}
              data-testid="story-page-hand"
            >
              <Ico name="send" size={13} color="#fff" width={1.9} />
              Give it to the PM
            </button>
          ) : null}
          {running && (
            <button
              type="button"
              className={`${styles.btn} ${styles.btnSm}`}
              disabled={action.isPending}
              onClick={() =>
                void act(
                  story.paused ? { kind: 'resume' } : { kind: 'pause' },
                  story.paused ? 'The Story could not be resumed.' : 'The Story could not be paused.',
                )
              }
              data-testid="story-page-pause"
            >
              <Ico name={story.paused ? 'play' : 'pause'} size={13} width={1.8} />
              {story.paused ? 'Resume the Story' : 'Pause the Story'}
            </button>
          )}
          <div ref={menuRef} style={{ position: 'relative' }}>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnSm}`}
              aria-label="More"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
              data-testid="story-page-more"
            >
              <Ico name="dots" size={14} width={2} />
            </button>
            {menuOpen && (
              <div className={styles.menu} role="menu">
                {onOpenAsTicket && (
                  <button
                    type="button"
                    role="menuitem"
                    className={styles.menuItem}
                    onClick={() => {
                      setMenuOpen(false);
                      onOpenAsTicket();
                    }}
                  >
                    <Ico name="open" size={14} width={2} />
                    Open as a ticket (comments, activity)
                  </button>
                )}
                {closed && (
                  <button
                    type="button"
                    role="menuitem"
                    className={styles.menuItem}
                    onClick={() => void act({ kind: 'reopen' }, 'The Story could not be reopened.')}
                  >
                    <Ico name="reopen" size={14} width={2} />
                    Reopen the Story
                  </button>
                )}
                {!closed && (
                  <button
                    type="button"
                    role="menuitem"
                    className={styles.menuItem}
                    style={{ color: '#A5321E' }}
                    onClick={() => void act({ kind: 'drop' }, 'The Story could not be dropped.')}
                    data-testid="story-page-drop"
                  >
                    <Ico name="x" size={14} color="#A5321E" width={2} />
                    Drop the Story
                  </button>
                )}
              </div>
            )}
          </div>
          <button type="button" className={styles.iconBtn} aria-label="Close" onClick={onClose}>
            <Ico name="x" size={16} width={2} />
          </button>
        </div>

        <div className={styles.pageBody}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
            {query.isError && (
              <div className={styles.error} role="alert">
                {errorText(query.error, 'The Story could not be loaded.')} What you see is what its ticket says.
              </div>
            )}
            {actionError && (
              <div className={styles.error} role="alert">
                {actionError}
              </div>
            )}
            {face === 'blocked' && story.blocked && (
              <div className={`${styles.strip} ${styles.stripRed}`} style={{ fontSize: 12.5, padding: '9px 12px' }}>
                <Ico name="warn" size={14} color="#A5321E" />
                <span style={{ flex: 1 }}>
                  <b>{blockedLead(story.blocked.kind)}</b> {story.blocked.text}
                </span>
                {story.blocked.ticketId && (
                  <button type="button" className={styles.link} onClick={() => openTicket(story.blocked?.ticketId)}>
                    Open {story.blocked.ticketId}
                  </button>
                )}
              </div>
            )}

            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <Tile
                label="Tickets"
                value={`${done} of ${total}`}
                hint={total ? `${building} building, ${waiting} waiting` : 'no tickets yet'}
              />
              <Tile
                label="Elapsed"
                value={story.startedAt ? fmtSpan(story.startedAt, story.closedAt) : '–'}
                hint={story.startedAt ? 'since the plan was approved' : 'the plan is not approved yet'}
              />
              <Tile
                label="You stepped in"
                value={String(story.interventions.count)}
                color={story.interventions.count > 0 ? '#7A5A06' : undefined}
                hint="needed or avoidable"
              />
              <Tile
                label="Tokens"
                value={fmtTokens(story.tokens.used)}
                hint={story.tokens.budget ? `of ${fmtTokens(story.tokens.budget)}` : 'no limit'}
              />
            </div>

            <div className={styles.panel}>
              <div className={styles.panelHead}>
                <span className={styles.label}>Goal</span>
                <span style={{ flex: 1 }} />
                {story.criteria.length > 0 && (
                  <span style={{ fontSize: 12, color: '#5B6B60' }}>
                    {metCount} of {story.criteria.length} met
                  </span>
                )}
              </div>
              <div className={styles.panelBody}>
                <div style={{ fontSize: 14, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
                  {story.goal || <span className={styles.hint}>No goal written yet.</span>}
                </div>
                <div className={styles.label} style={{ marginTop: 4 }}>
                  Done when
                </div>
                {story.criteria.length === 0 ? (
                  <span className={styles.hint}>
                    No criteria yet. The PM closes the Story when every ticket is done.
                  </span>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }} data-testid="story-criteria">
                    {story.criteria.map((c) => {
                      const met = c.state === 'met' || c.done;
                      return (
                        <div key={c.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                          <span
                            role="img"
                            aria-label={met ? 'Met' : 'Not met'}
                            style={{
                              width: 16,
                              height: 16,
                              borderRadius: 5,
                              border: `1.5px solid ${met ? '#2E6F40' : '#9AA8A0'}`,
                              background: met ? '#2E6F40' : '#fff',
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              flexShrink: 0,
                              marginTop: 1,
                              boxSizing: 'border-box',
                            }}
                          >
                            {met && <Ico name="tick" size={10} color="#fff" width={3} />}
                          </span>
                          <div style={{ flex: 1, fontSize: 13, lineHeight: 1.45 }}>{c.text}</div>
                          <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
                            {c.ticketId && (
                              <button
                                type="button"
                                className={styles.ticketLink}
                                onClick={() => openTicket(c.ticketId)}
                              >
                                {c.ticketId}
                              </button>
                            )}
                            {!met && (
                              <span
                                className={styles.chip}
                                style={
                                  c.state === 'in_progress'
                                    ? { background: '#E6F2EA', color: '#1F5A31' }
                                    : { background: '#F1F3F1', color: '#3A4A3E' }
                                }
                              >
                                {c.state === 'in_progress' ? 'in progress' : 'not started'}
                              </span>
                            )}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {story.planWaiting && story.plan ? (
              <PlanReviewCard story={story} />
            ) : (
              <PlanSection
                story={story}
                editing={editing}
                onEdit={() => setEditing(true)}
                onDoneEditing={() => setEditing(false)}
                onOpenTicket={openTicket}
              />
            )}
          </div>

          <div style={{ width: 330, flex: 'none', display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Decisions
              decisions={detail.decisions ?? []}
              projectId={ticket.projectId}
              storyId={story.id}
              pmName={pmName}
            />

            <div className={styles.panel}>
              <div className={styles.panelHead}>
                <span className={styles.label}>Tokens and money</span>
              </div>
              <div className={styles.panelBody}>
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
                  <span style={{ fontSize: 22, fontWeight: 800 }}>{fmtTokens(story.tokens.used)}</span>
                  <span style={{ fontSize: 12.5, color: '#5B6B60', paddingBottom: 3 }}>
                    {story.tokens.budget
                      ? `of ${fmtTokens(story.tokens.budget)} for this Story`
                      : 'no limit for this Story'}
                  </span>
                </div>
                {story.tokens.budget > 0 && (
                  <div className={styles.bar} style={{ height: 8 }}>
                    <i
                      style={{
                        width: `${Math.min(100, (story.tokens.used / story.tokens.budget) * 100)}%`,
                        background: story.tokens.used >= story.tokens.budget ? '#C4432A' : '#2E6F40',
                      }}
                    />
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#5B6B60' }}>
                  <span>about ${story.costUsd.toFixed(2)} so far</span>
                  {story.tokens.budget > 0 && <span>stops and asks at 100%</span>}
                </div>
              </div>
            </div>

            <div className={styles.panel}>
              <div className={styles.panelHead}>
                <span className={styles.label}>Autonomy</span>
              </div>
              <div className={styles.panelBody}>
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10 }}>
                  <span
                    style={{
                      fontSize: 22,
                      fontWeight: 800,
                      color: story.interventions.count > 0 ? '#7A5A06' : '#2E6F40',
                    }}
                  >
                    {story.interventions.count}
                  </span>
                  <span style={{ fontSize: 12.5, color: '#5B6B60', paddingBottom: 3 }}>
                    time{story.interventions.count === 1 ? '' : 's'} you stepped in
                  </span>
                </div>
                <div style={{ fontSize: 12, lineHeight: 1.5, color: '#3A4A3E' }}>
                  {story.interventions.needed} needed, {story.interventions.avoidable} avoidable
                  {story.interventions.byRule > 0
                    ? ` · ${story.interventions.byRule} approval${story.interventions.byRule === 1 ? '' : 's'} the rules ask for, not counted`
                    : ''}
                </div>
                <div className={styles.hint} style={{ fontSize: 11.5 }}>
                  Counts what Health counts: touches marked Needed or Avoidable. Approvals the rules ask for are not
                  counted. A per-Story goal of 0 is proposed here; Health aims for 70% of tickets with none.
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      {handing && <GiveStoryDialog projectId={ticket.projectId} story={story} onClose={() => setHanding(false)} />}
    </div>
  );
}

function Tile({ label, value, hint, color }: { label: string; value: string; hint: string; color?: string }) {
  return (
    <div className={styles.tile}>
      <div className={styles.label}>{label}</div>
      <span className={styles.tileValue} style={color ? { color } : undefined}>
        {value}
      </span>
      <div className={styles.hint} style={{ fontSize: 11.5, lineHeight: 1.4 }}>
        {hint}
      </div>
    </div>
  );
}

/** The plan: the parent ticket's children table, given an order and a Planned-by line (E). */
function PlanSection({
  story,
  editing,
  onEdit,
  onDoneEditing,
  onOpenTicket,
}: {
  story: StoryView;
  editing: boolean;
  onEdit: () => void;
  onDoneEditing: () => void;
  onOpenTicket: (id: string) => void;
}) {
  const plan = story.plan;
  const pmName = story.pm?.name ?? 'PM';
  const items = [...(plan?.items ?? [])].sort((a, b) => a.order - b.order);
  const closed = story.state === 'done' || story.state === 'dropped';

  const starts = items.map((i) => i.startedAt).filter((x): x is string => !!x);
  const t0 = Math.min(
    ...[story.startedAt, ...starts].filter((x): x is string => !!x).map((x) => new Date(x).getTime()),
    Date.now(),
  );
  const t1 = Math.max(story.closedAt ? new Date(story.closedAt).getTime() : Date.now(), t0 + 60_000);
  const pct = (ms: number) => Math.min(100, Math.max(0, ((ms - t0) / (t1 - t0)) * 100));

  const timeBar = (it: StoryPlanItem): ReactNode => {
    if (!it.startedAt) {
      return (
        <i
          style={{
            position: 'absolute',
            left: '84%',
            width: '16%',
            top: 0,
            bottom: 0,
            borderRadius: 3,
            background: 'repeating-linear-gradient(45deg,#E3E8E5,#E3E8E5 4px,#F1F5F2 4px,#F1F5F2 8px)',
          }}
        />
      );
    }
    const a = pct(new Date(it.startedAt).getTime());
    const b = pct(it.endedAt ? new Date(it.endedAt).getTime() : Date.now());
    return (
      <i
        style={{
          position: 'absolute',
          left: `${a}%`,
          width: `${Math.max(b - a, 4)}%`,
          top: 0,
          bottom: 0,
          borderRadius: 3,
          background: it.endedAt ? '#CFE5D6' : '#7DBF8E',
          border: '1px solid #2E6F40',
          boxSizing: 'border-box',
        }}
      />
    );
  };

  return (
    <div className={styles.panel} data-testid="story-plan">
      <div className={styles.panelHead}>
        <span className={styles.label}>{plan ? `Plan · version ${plan.version}` : 'Plan'}</span>
        <span style={{ flex: 1 }} />
        {plan && (
          <span style={{ fontSize: 12, color: '#5B6B60' }}>
            by {byWord(plan.by, pmName)}
            {plan.at ? ` at ${fmtClock(plan.at)}` : ''}
            {plan.approvedBy ? ` · approved by ${byWord(plan.approvedBy, pmName)}` : ' · not approved yet'}
          </span>
        )}
        {plan && !closed && !editing && items.length > 0 && (
          <button type="button" className={`${styles.btn} ${styles.btnSm}`} onClick={onEdit} data-testid="plan-edit">
            <Ico name="draft" size={13} width={2} />
            Edit the plan
          </button>
        )}
      </div>
      {!plan ? (
        <div className={styles.panelBody}>
          <span className={styles.hint}>
            {story.state === 'draft'
              ? 'No plan yet. Give the Story to the PM and it writes one.'
              : 'The PM is writing the plan.'}
          </span>
        </div>
      ) : editing ? (
        <div className={styles.panelBody}>
          <PlanEditor story={story} onCancel={onDoneEditing} onSaved={onDoneEditing} />
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <div style={{ minWidth: 640 }}>
            <div className={`${styles.planHead} ${styles.label}`}>
              <span>#</span>
              <span>Ticket</span>
              <span>What</span>
              <span>Held by</span>
              <span>State</span>
              <span>Time</span>
            </div>
            {items.map((it) => {
              const st = planItemState(it, items);
              return (
                <div key={it.ticketId} className={styles.planRow} data-testid="story-plan-row">
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#5B6B60' }}>{it.order}</span>
                  <button type="button" className={styles.ticketLink} onClick={() => onOpenTicket(it.ticketId)}>
                    <Ico
                      name="circleCheck"
                      size={14}
                      color={it.status === 'done' ? '#2E6F40' : '#2F6FB0'}
                      width={1.8}
                    />
                    {it.ticketId}
                  </button>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{it.title}</span>
                  <span style={{ display: 'flex', gap: 7, alignItems: 'center' }}>
                    {it.heldBy ? (
                      <>
                        <RoleBadge role={it.heldBy.role} size={22} title={it.heldBy.name} />
                        <span style={{ fontSize: 12.5 }}>{roleOf(it.heldBy.role).label}</span>
                      </>
                    ) : (
                      <span className={styles.hint}>nobody</span>
                    )}
                  </span>
                  <span>
                    <span
                      className={styles.chip}
                      style={{
                        background: st.bg,
                        color: st.fg,
                        maxWidth: '100%',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                      title={st.label}
                    >
                      {st.label}
                    </span>
                  </span>
                  <span>
                    <span
                      style={{
                        position: 'relative',
                        display: 'block',
                        width: 108,
                        height: 10,
                        background: '#F1F5F2',
                        borderRadius: 3,
                      }}
                    >
                      {timeBar(it)}
                    </span>
                  </span>
                </div>
              );
            })}
            {(plan.changes ?? []).map((c, i) => (
              <div
                key={`${c.at}-${i}`}
                style={{
                  display: 'flex',
                  gap: 9,
                  alignItems: 'flex-start',
                  padding: '9px 16px',
                  background: '#FBFCFB',
                  fontSize: 12.5,
                  lineHeight: 1.5,
                  color: '#3A4A3E',
                  borderTop: i === 0 ? undefined : '1px solid #EEF3EF',
                }}
                data-testid="story-plan-change"
              >
                <RoleBadge role="pm" title={pmName} />
                <span>
                  <b>PM changed the plan at {fmtClock(c.at)}.</b> {c.text}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Decided for you by the PM, with Override while it still can be (E; POST /ai/decisions/{id}/override). */
function Decisions({
  decisions,
  projectId,
  storyId,
  pmName,
}: {
  decisions: Decision[];
  projectId: string;
  storyId: string;
  pmName: string;
}) {
  const today = new Date().toDateString();
  const todayCount = decisions.filter((d) => new Date(d.at).toDateString() === today).length;
  return (
    <div className={styles.panel} data-testid="story-decisions">
      <div className={styles.panelHead}>
        <span className={styles.label}>Decided for you by the PM</span>
        <span style={{ flex: 1 }} />
        {decisions.length > 0 && (
          <span style={{ fontSize: 12, color: '#5B6B60' }}>
            {todayCount > 0 ? `${todayCount} today` : `${decisions.length} in all`}
          </span>
        )}
      </div>
      <div style={{ padding: '0 16px 4px', display: 'flex', flexDirection: 'column' }}>
        {decisions.length === 0 ? (
          <span className={styles.hint} style={{ padding: '12px 0' }}>
            The PM has not decided anything in your place yet.
          </span>
        ) : (
          decisions.map((d, i) => (
            <DecisionRow key={d.id} d={d} first={i === 0} projectId={projectId} storyId={storyId} pmName={pmName} />
          ))
        )}
      </div>
    </div>
  );
}

function DecisionRow({
  d,
  first,
  projectId,
  storyId,
  pmName,
}: {
  d: Decision;
  first: boolean;
  projectId: string;
  storyId: string;
  pmName: string;
}) {
  const override = useOverrideDecision(projectId, storyId);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const overridden = d.state === 'overridden';

  async function confirm() {
    setError(null);
    try {
      await override.mutateAsync({ id: d.id, note: note.trim() || undefined });
      setAsking(false);
      setNote('');
    } catch (err) {
      setError(errorText(err, 'This decision can no longer be overridden.'));
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
        padding: '10px 0',
        borderTop: first ? undefined : '1px solid #EEF3EF',
      }}
      data-testid="story-decision"
    >
      <div style={{ display: 'flex', gap: 7, alignItems: 'center' }}>
        <RoleBadge role="pm" title={d.member?.name ?? pmName} />
        <b style={{ fontSize: 12.5, flex: 1, minWidth: 0 }}>{d.title}</b>
        <span style={{ fontSize: 11, color: '#5B6B60', flexShrink: 0 }}>{fmtClock(d.at)}</span>
      </div>
      {d.why && <div style={{ fontSize: 12, lineHeight: 1.45, color: '#3A4A3E' }}>{d.why}</div>}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {overridden ? (
          <span className={styles.chip} style={{ background: '#FEF3D9', color: '#7A5A06' }}>
            {d.overriddenBy && !/^(user|you|person)$/i.test(d.overriddenBy)
              ? `Overridden by ${d.overriddenBy}`
              : 'You overrode this'}
          </span>
        ) : (
          <span className={styles.chip} style={{ background: '#E6F2EA', color: '#1F5A31' }}>
            In effect
          </span>
        )}
        <span style={{ flex: 1 }} />
        {!overridden && d.canOverride && !asking && (
          <button
            type="button"
            className={`${styles.btn} ${styles.btnSm}`}
            onClick={() => setAsking(true)}
            data-testid="decision-override"
          >
            <Ico name="undo" size={13} width={2} />
            Override
          </button>
        )}
      </div>
      {!overridden && !d.canOverride && (
        <div className={styles.hint} style={{ fontSize: 11.5 }} data-testid="decision-why-not">
          Can no longer be overridden{d.whyNot ? `: ${d.whyNot}` : '.'}
        </div>
      )}
      {overridden && d.overrideNote && (
        <div className={styles.hint} style={{ fontSize: 11.5 }}>
          &ldquo;{d.overrideNote}&rdquo;
        </div>
      )}
      {asking && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className={styles.hint} style={{ fontSize: 11.5 }}>
            The PM&rsquo;s decision is reversed{d.ticketId ? ` on ${d.ticketId}` : ''} and the PM is told why.
          </span>
          <input
            className={styles.input}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Why, for the PM (optional)"
            aria-label="Why you override it"
            autoFocus
          />
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnSm} ${styles.btnPrimary}`}
              disabled={override.isPending}
              onClick={() => void confirm()}
              data-testid="decision-override-confirm"
            >
              Override it
            </button>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnSm}`}
              onClick={() => {
                setAsking(false);
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && (
        <div className={styles.error} role="alert" data-testid="decision-override-error">
          {error}
        </div>
      )}
    </div>
  );
}
