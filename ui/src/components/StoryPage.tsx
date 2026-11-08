import { useEffect, useRef, useState } from 'react';
import { useMembers } from '../api/members';
import { useProjectRuns } from '../api/ai';
import { useProject } from '../api/projects';
import type { Ticket } from '../types';
import type { AiRun } from '../types/ai';
import { money } from './ai/aiUi';
import { MarkdownRenderer } from './MarkdownRenderer';
import { MemberAvatar } from './MemberAvatar';
import { buildRows } from './SubTicketsSection';
import { TicketTypeIcon } from './icons';
import { openTimeline } from './aiteam/timelineLink';
import styles from './StoryPage.module.css';

const STATUS_LABEL: Record<string, string> = {
  backlog: 'Backlog',
  todo: 'To Do',
  'in-progress': 'In progress',
  review: 'Review',
  testing: 'Testing',
  done: 'Done',
  wont_do: "Won't do",
};

const ACTIVE = ['in-progress', 'testing', 'review'];

interface StoryPageProps {
  ticket: Ticket;
  allTickets?: Ticket[];
  onClose: () => void;
  onOpenTicket?: (t: Ticket) => void;
  /** "Open as ticket": the ordinary ticket window of this Story. */
  onOpenAsTicket: () => void;
}

/** "2 h 40 m", "35 m", "4 d 3 h". */
function elapsed(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 60) return `${min} m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ${min % 60} m`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

/** 1.3M, 220k, 950. */
function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** When the work on a sub-ticket began and ended (the team's runs, else the ticket's own dates), or null when nothing ran. */
function span(ticket: Ticket, runs: AiRun[], now: number): [number, number] | null {
  const starts = runs.map((r) => (r.startedAt ? Date.parse(r.startedAt) : NaN)).filter((n) => !Number.isNaN(n));
  if (starts.length > 0) {
    const ends = runs.map((r) => (r.endedAt ? Date.parse(r.endedAt) : now));
    return [Math.min(...starts), Math.max(...ends)];
  }
  if (ticket.status === 'done') return [Date.parse(ticket.createdAt), Date.parse(ticket.updatedAt)];
  return null;
}

/**
 * A Story as a page in the app (AI Story flow, E "The Story page"): where it sits, how far its sub-tickets are, the Goal
 * with its "Done when" criteria, the sub-tickets in the order of their waves with who holds them, and what their teams
 * have used. "Open as ticket" in its menu shows the ordinary ticket window. The design's PM parts (Run by PM, Flow, Pause,
 * the plan's version and edit, Decided for you, Autonomy, the token budget) went with the v1 AI Story flow.
 */
export function StoryPage({ ticket, allTickets = [], onClose, onOpenTicket, onOpenAsTicket }: StoryPageProps) {
  const project = useProject(ticket.projectId);
  const members = useMembers(ticket.projectId);
  const runs = useProjectRuns(ticket.projectId, { limit: 200 });
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

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

  const children = allTickets.filter((t) => t.parentId === ticket.id && t.type !== 'story');
  const rows = buildRows(children);
  const childIds = new Set(children.map((t) => t.id));
  const done = children.filter((t) => t.status === 'done').length;
  const building = children.filter((t) => ACTIVE.includes(t.status)).length;
  const memberOf = (id: string | null | undefined) => members.data?.find((m) => m.id === id);

  // the team runs of the sub-tickets: the newest one tells what a team does now, all of them count in the cost
  const teamRuns = (runs.data ?? []).filter((r) => r.ticketId && childIds.has(r.ticketId));
  const runsOf = new Map<string, AiRun[]>();
  for (const r of teamRuns) runsOf.set(r.ticketId as string, [...(runsOf.get(r.ticketId as string) ?? []), r]);
  const waiting = [...runsOf.values()].filter((list) => list[0]?.state === 'needs_input').length;
  const spent = teamRuns.reduce((n, r) => n + (r.costUsd || 0), 0);
  const used = teamRuns.reduce((n, r) => n + (r.tokensIn || 0) + (r.tokensOut || 0), 0);

  // the Time column: each sub-ticket's work between the first start and now
  const now = Date.now();
  const spans = new Map(children.map((t) => [t.id, span(t, runsOf.get(t.id) ?? [], now)]));
  const known = [...spans.values()].filter((s): s is [number, number] => s !== null);
  const from = known.length ? Math.min(...known.map((s) => s[0])) : now;
  const to = known.length ? Math.max(...known.map((s) => s[1])) : now;
  const total = Math.max(to - from, 1);
  const first = teamRuns.length
    ? Math.min(...teamRuns.map((r) => (r.startedAt ? Date.parse(r.startedAt) : now)))
    : null;

  const met = ticket.acceptanceCriteria.filter((c) => c.done).length;
  const statusChip =
    ticket.status === 'done' ? styles.chipGreen : ACTIVE.includes(ticket.status) ? styles.chipGreen : styles.chipGrey;

  return (
    <div className={styles.page} role="dialog" aria-label={`Story ${ticket.id}`} data-testid="story-page">
      <nav className={styles.crumb} data-testid="story-crumb" aria-label="Where you are">
        <button type="button" onClick={onClose}>
          {project.data?.name ?? 'Project'}
        </button>
        <Chevron />
        <button type="button" onClick={onClose}>
          Board
        </button>
        <Chevron />
        <b>
          <span className={styles.mono}>{ticket.id}</span>
        </b>
        <span style={{ flex: 1 }} />
      </nav>

      <div className={styles.head}>
        <span className={styles.storyIcon} aria-hidden="true">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#1B3A6B"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M6.5 3h11a1 1 0 0 1 1 1v17l-6.5-4.2L5.5 21V4a1 1 0 0 1 1-1z" />
          </svg>
        </span>
        <div className={styles.titleBlock}>
          <div className={styles.titleLine}>
            <span className={styles.storyWord}>Story</span>
            <span className={styles.mono}>{ticket.id}</span>
            <span className={`${styles.chip} ${statusChip}`}>{STATUS_LABEL[ticket.status] ?? ticket.status}</span>
          </div>
          <h2 className={styles.title}>{ticket.title}</h2>
        </div>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className={styles.btn}
          data-testid="story-open-timeline"
          onClick={() => openTimeline({ scope: ticket.id })}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="3" />
            <circle cx="4.5" cy="5.5" r="1.8" />
            <circle cx="19.5" cy="5.5" r="1.8" />
            <circle cx="4.5" cy="18.5" r="1.8" />
            <circle cx="19.5" cy="18.5" r="1.8" />
            <path d="M6 7l4 3.5M18 7l-4 3.5M6 17l4-3.5M18 17l-4-3.5" />
          </svg>
          Open in Flow
        </button>
        <div ref={menuRef} style={{ position: 'relative' }}>
          <button
            type="button"
            className={styles.btn}
            aria-label="More"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            data-testid="story-page-more"
            onClick={() => setMenuOpen((v) => !v)}
          >
            ⋯
          </button>
          {menuOpen && (
            <div className={styles.menu} role="menu">
              <button
                type="button"
                role="menuitem"
                data-testid="story-open-as-ticket"
                onClick={() => {
                  setMenuOpen(false);
                  onOpenAsTicket();
                }}
              >
                Open as ticket
              </button>
            </div>
          )}
        </div>
      </div>

      <div className={styles.body}>
        <div className={styles.main}>
          <div className={styles.tiles}>
            <Tile label="Tickets" value={`${done} of ${children.length}`} hint={tilesHint(building, waiting)} />
            <Tile label="Elapsed" value={first ? elapsed(now - first) : '—'} hint="since the first team run" />
            <Tile
              label="Waiting for you"
              value={String(waiting)}
              hint="teams that asked a question"
              color={waiting ? '#7A5A06' : undefined}
            />
            <Tile label="Tokens" value={used > 0 ? tokens(used) : '—'} hint="by the teams on its sub-tickets" />
          </div>

          <section className={styles.panel} data-testid="story-criteria">
            <div className={styles.panelHead}>
              <span className={styles.idh}>Goal</span>
              <span style={{ flex: 1 }} />
              <span className={styles.hint}>
                {met} of {ticket.acceptanceCriteria.length} met
              </span>
            </div>
            <div className={styles.goal}>
              {ticket.description.trim() ? (
                <div className={styles.goalText}>
                  <MarkdownRenderer>{ticket.description}</MarkdownRenderer>
                </div>
              ) : (
                <div className={styles.hint}>No goal written yet.</div>
              )}
              <div className={styles.idh} style={{ marginTop: 4 }}>
                Done when
              </div>
              {ticket.acceptanceCriteria.length === 0 && <div className={styles.hint}>None yet.</div>}
              <div className={styles.crits}>
                {ticket.acceptanceCriteria.map((c) => (
                  <div key={c.id} className={styles.crit}>
                    <span className={`${styles.box} ${c.done ? styles.boxOn : ''}`} aria-hidden="true">
                      {c.done && (
                        <svg
                          width="11"
                          height="11"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="#fff"
                          strokeWidth="3.2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M5 12.5l4.5 4.5L19 7.5" />
                        </svg>
                      )}
                    </span>
                    <span className={styles.critText}>{c.text}</span>
                    <span className={styles.srOnly}>{c.done ? '(met)' : '(not met)'}</span>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className={styles.panel} data-testid="story-children">
            <div className={styles.panelHead}>
              <span className={styles.idh}>Plan</span>
              <span style={{ flex: 1 }} />
              <span className={styles.hint}>{children.length} sub-tickets · in the order of their waves</span>
            </div>
            {children.length === 0 ? (
              <div className={styles.empty}>No sub-tickets yet.</div>
            ) : (
              <div role="table" aria-label="Sub-tickets">
                <div className={`${styles.row} ${styles.rowHead} ${styles.idh}`} role="row">
                  <span role="columnheader">#</span>
                  <span role="columnheader">Ticket</span>
                  <span role="columnheader">What</span>
                  <span role="columnheader">Held by</span>
                  <span role="columnheader">State</span>
                  <span role="columnheader">Time</span>
                </div>
                {rows.map(({ ticket: t, openBlocker }, i) => {
                  const list = runsOf.get(t.id) ?? [];
                  const holder = memberOf(t.assignee);
                  const asks = list[0]?.state === 'needs_input';
                  const live = list.some((r) => !r.endedAt && r.startedAt);
                  const s = spans.get(t.id) ?? null;
                  let left = 100 - 16;
                  let width = 16;
                  if (s) {
                    left = Math.min(((s[0] - from) / total) * 100, 94);
                    width = Math.max(Math.min(((s[1] - s[0]) / total) * 100, 100 - left), 6);
                  }
                  let label = STATUS_LABEL[t.status] ?? t.status;
                  let chip = t.status === 'done' || ACTIVE.includes(t.status) ? styles.chipGreen : styles.chipGrey;
                  if (asks) {
                    label = 'Waiting for you';
                    chip = styles.chipAmber;
                  } else if (openBlocker && t.status !== 'done') {
                    label = `Waits for ${openBlocker.id}`;
                    chip = styles.chipGrey;
                  }
                  return (
                    <div key={t.id} className={styles.row} role="row" data-testid="story-child">
                      <span className={styles.num} role="cell">
                        {i + 1}
                      </span>
                      <span className={styles.code} role="cell">
                        <TicketTypeIcon type={t.type} size={14} />
                        <span className={styles.mono}>{t.id}</span>
                      </span>
                      <span role="cell" style={{ minWidth: 0 }}>
                        <button type="button" className={styles.link} onClick={() => onOpenTicket?.(t)}>
                          {t.title}
                        </button>
                      </span>
                      <span className={styles.holder} role="cell">
                        {holder ? (
                          <>
                            <MemberAvatar member={holder} size={22} />
                            <span>{holder.name}</span>
                          </>
                        ) : (
                          <span className={styles.hint}>—</span>
                        )}
                      </span>
                      <span role="cell">
                        <span className={`${styles.chip} ${chip}`}>{label}</span>
                      </span>
                      <span role="cell">
                        <span className={styles.track} aria-hidden="true">
                          <i
                            className={s ? (live ? styles.barLive : styles.barDone) : styles.barLater}
                            style={{ left: `${left}%`, width: `${width}%` }}
                          />
                        </span>
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>

        <aside className={styles.side}>
          <section className={styles.panel}>
            <div className={styles.panelHead}>
              <span className={styles.idh}>Tokens and money</span>
            </div>
            <div className={styles.sidePad}>
              <div className={styles.big}>
                <span>{used > 0 ? tokens(used) : '—'}</span>
                <span className={styles.hint}>tokens in {teamRuns.length} team runs</span>
              </div>
              <div className={styles.hint}>{spent > 0 ? `about ${money(spent)} so far` : 'no cost yet'}</div>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

function tilesHint(building: number, waiting: number): string {
  const parts: string[] = [];
  if (building) parts.push(`${building} building`);
  if (waiting) parts.push(`${waiting} waiting`);
  return parts.length ? parts.join(', ') : 'none building';
}

function Chevron() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#9AA8A0"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function Tile({ label, value, hint, color }: { label: string; value: string; hint: string; color?: string }) {
  return (
    <div className={styles.tile}>
      <div className={styles.idh}>{label}</div>
      <span className={styles.tileValue} style={color ? { color } : undefined}>
        {value}
      </span>
      <div className={styles.tileHint}>{hint}</div>
    </div>
  );
}
