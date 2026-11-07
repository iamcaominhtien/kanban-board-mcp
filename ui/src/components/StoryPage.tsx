import { useEffect, useRef, useState } from 'react';
import { useMembers } from '../api/members';
import { useProjectRuns } from '../api/ai';
import { useProject } from '../api/projects';
import type { Ticket } from '../types';
import { money } from './ai/aiUi';
import styles from './StoryPage.module.css';

const STATUS_ORDER = ['in-progress', 'testing', 'review', 'todo', 'backlog', 'done', 'wont_do'] as const;
const STATUS_LABEL: Record<string, string> = {
  backlog: 'Backlog',
  todo: 'To Do',
  'in-progress': 'In Progress',
  review: 'Review',
  testing: 'Testing',
  done: 'Done',
  wont_do: "Won't do",
};

const RUN_WORDS: Record<string, string> = {
  queued: 'queued',
  starting: 'starting',
  running: 'working',
  needs_input: 'waiting for you',
  finished: 'finished',
  failed: 'failed',
  cancelled: 'stopped',
  timed_out: 'timed out',
};

interface StoryPageProps {
  ticket: Ticket;
  allTickets?: Ticket[];
  onClose: () => void;
  onOpenTicket?: (t: Ticket) => void;
  /** "Open as ticket": the ordinary ticket window of this Story. */
  onOpenAsTicket: () => void;
}

/**
 * A Story as a page: where it sits, how far its sub-tickets are, who holds them and what their teams are doing, and its
 * acceptance criteria. "Open as ticket" in its menu shows the ordinary ticket window. (The v1 page also had a PM, a
 * plan to review, decisions and an autonomy level: those went with the v1 AI Story flow.)
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
  const childIds = new Set(children.map((t) => t.id));
  const done = children.filter((t) => t.status === 'done').length;
  const going = children.filter((t) => ['in-progress', 'testing', 'review'].includes(t.status)).length;
  const pct = children.length ? Math.round((done / children.length) * 100) : 0;
  const memberName = (id: string | null | undefined) => members.data?.find((m) => m.id === id)?.name ?? '';

  // the newest run of each sub-ticket tells what its team does now; every run counts in the cost
  const teamRuns = (runs.data ?? []).filter((r) => r.ticketId && childIds.has(r.ticketId));
  const newestRun = new Map<string, (typeof teamRuns)[number]>();
  for (const r of teamRuns) if (!newestRun.has(r.ticketId as string)) newestRun.set(r.ticketId as string, r);
  const waiting = [...newestRun.values()].filter((r) => r.state === 'needs_input').length;
  const spent = teamRuns.reduce((n, r) => n + (r.costUsd || 0), 0);

  const metCount = ticket.acceptanceCriteria.filter((c) => c.done).length;
  const groups = STATUS_ORDER.map((s) => ({ s, items: children.filter((t) => t.status === s) })).filter(
    (g) => g.items.length > 0,
  );

  return (
    <div
      className={styles.overlay}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={styles.page}
        role="dialog"
        aria-modal="true"
        aria-label={`Story ${ticket.id}`}
        data-testid="story-page"
      >
        <div className={styles.crumb} data-testid="story-crumb">
          {project.data?.name ?? 'Project'} <span>›</span> Board <span>›</span> <b>{ticket.id}</b>
        </div>
        <div className={styles.head}>
          <span className={styles.storyWord}>Story</span>
          <span className={styles.mono}>{ticket.id}</span>
          <h2 className={styles.title}>{ticket.title}</h2>
          <span className={styles.status}>{STATUS_LABEL[ticket.status] ?? ticket.status}</span>
          <span style={{ flex: 1 }} />
          <div ref={menuRef} style={{ position: 'relative' }}>
            <button
              type="button"
              className={styles.iconBtn}
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
          <button type="button" className={styles.iconBtn} aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className={styles.body}>
          <div className={styles.tiles}>
            <Tile label="Sub-tickets" value={`${done} of ${children.length}`} hint="done" />
            <Tile label="Going" value={String(going)} hint="in progress, testing or review" />
            <Tile
              label="Waiting for you"
              value={String(waiting)}
              hint="teams that asked a question"
              color={waiting ? '#A5321E' : undefined}
            />
            <Tile label="Spent" value={spent > 0 ? money(spent) : '—'} hint="by the teams on its sub-tickets" />
          </div>
          <div className={styles.bar} role="img" aria-label={`${pct}% done`}>
            <i style={{ width: `${pct}%` }} />
          </div>

          <section className={styles.panel} data-testid="story-children">
            <div className={styles.panelHead}>
              <b>Sub-tickets</b>
              <span className={styles.hint}>{children.length}</span>
            </div>
            {children.length === 0 && <div className={styles.empty}>No sub-tickets yet.</div>}
            {groups.map((g) => (
              <div key={g.s}>
                <div className={styles.groupHead}>
                  {STATUS_LABEL[g.s]} <span className={styles.hint}>{g.items.length}</span>
                </div>
                {g.items.map((t) => {
                  const run = newestRun.get(t.id);
                  const who = memberName(t.assignee);
                  return (
                    <div key={t.id} className={styles.row} data-testid="story-child">
                      <span className={styles.mono}>{t.id}</span>
                      <button type="button" className={styles.link} onClick={() => onOpenTicket?.(t)}>
                        {t.title}
                      </button>
                      <span className={styles.who}>{who || '—'}</span>
                      <span className={`${styles.run} ${run?.state === 'needs_input' ? styles.runAsk : ''}`}>
                        {run ? `Run #${run.number} ${RUN_WORDS[run.state] ?? run.state}` : ''}
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}
          </section>

          <section className={styles.panel} data-testid="story-criteria">
            <div className={styles.panelHead}>
              <b>Acceptance criteria</b>
              <span className={styles.hint}>
                {metCount} of {ticket.acceptanceCriteria.length} met
              </span>
            </div>
            {ticket.acceptanceCriteria.length === 0 && <div className={styles.empty}>None yet.</div>}
            {ticket.acceptanceCriteria.map((c) => (
              <div key={c.id} className={styles.crit}>
                <span aria-hidden="true">{c.done ? '☑' : '☐'}</span>
                <span style={{ textDecoration: c.done ? 'line-through' : undefined }}>{c.text}</span>
              </div>
            ))}
          </section>
        </div>
      </div>
    </div>
  );
}

function Tile({ label, value, hint, color }: { label: string; value: string; hint: string; color?: string }) {
  return (
    <div className={styles.tile}>
      <span className={styles.hint}>{label}</span>
      <span className={styles.tileValue} style={color ? { color } : undefined}>
        {value}
      </span>
      <span className={styles.hint}>{hint}</span>
    </div>
  );
}
