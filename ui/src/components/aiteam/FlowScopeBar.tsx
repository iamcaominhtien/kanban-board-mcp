import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { FlowScopes, FlowTicketNode } from '../../types/aiFlow';

/** What Flow looks at: every team, one team, or one ticket (a Story is a ticket with children). */
export interface FlowScope {
  teamId: string | null;
  ticketId: string | null;
}

export const ALL_TEAMS: FlowScope = { teamId: null, ticketId: null };

export type FlowView = 'map' | 'timeline';

interface Crumb {
  key: string;
  label: ReactNode;
  scope: FlowScope | null;
}

const matches = (q: string, ...parts: (string | null | undefined)[]) => {
  const needle = q.trim().toLowerCase();
  return !needle || parts.some((p) => (p ?? '').toLowerCase().includes(needle));
};

/**
 * The words that say what Flow looks at, from the scope and the picker's lists:
 * "All teams", a team's name, "KBM-7 Story" or "KBM-9 in KBM-7".
 */
export function scopeWords(scope: FlowScope, scopes: FlowScopes | undefined): string {
  if (scope.teamId) return scopes?.teams.find((t) => t.id === scope.teamId)?.name ?? 'this team';
  if (scope.ticketId) return scope.ticketId;
  return 'all teams';
}

/** Whether `ticketId` is a Story the picker knows. */
export const isStory = (scopes: FlowScopes | undefined, ticketId: string | null) =>
  !!ticketId && !!scopes?.stories.some((s) => s.id === ticketId);

/**
 * Flow's scope bar (design/screens/ai-story-flow.md, G): the breadcrumb says what is drawn (every part but the last
 * goes one level up), a picker finds a team, a Story or a ticket (`/` opens it), Copy link keeps the scope and the
 * view, and the view switch picks the Map or the Timeline.
 * @param props.projectName - The first crumb.
 * @param props.scope - What is looked at now.
 * @param props.scopes - The picker's lists (teams, Stories, tickets with AI work).
 * @param props.view - Map or Timeline.
 * @param props.summary - The line under the bar ("3 teams · 5 tickets with AI work").
 * @param props.right - Controls at the right of the bar (the Map's range).
 */
export function FlowScopeBar({
  projectName,
  scope,
  scopes,
  view,
  summary,
  right,
  mapTickets,
  onScope,
  onView,
  onCopyLink,
}: {
  projectName: string;
  scope: FlowScope;
  scopes: FlowScopes | undefined;
  view: FlowView;
  summary: string;
  right?: ReactNode;
  /** The tickets the Map draws: their titles and parents stand in for a ticket the picker does not list. */
  mapTickets?: FlowTicketNode[];
  onScope: (s: FlowScope) => void;
  onView: (v: FlowView) => void;
  onCopyLink: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  // "/" opens the picker (unless the person is typing somewhere), Esc closes it, a click outside closes it
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      // not behind a ticket (or any other) dialog that is open over the page
      const behindDialog = !!document.querySelector('[role="dialog"][aria-modal="true"]');
      if (e.key === '/' && !typing && !behindDialog && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setOpen(true);
      } else if (e.key === 'Escape') setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, []);
  useEffect(() => {
    if (open) input.current?.focus();
    else {
      setQ('');
      if (wasOpen.current) button.current?.focus();
    }
    wasOpen.current = open;
  }, [open]);

  const crumbs = useMemo<Crumb[]>(() => {
    // the project goes up to All teams from anywhere but All teams itself, where it is only the first word
    const list: Crumb[] = [
      { key: 'project', label: projectName, scope: scope.teamId || scope.ticketId ? ALL_TEAMS : null },
    ];
    if (scope.teamId) {
      const t = scopes?.teams.find((x) => x.id === scope.teamId);
      list.push({ key: 'team', label: t?.name ?? 'This team', scope: null });
    } else if (scope.ticketId) {
      // a ticket the teams never ran is not in the picker's lists: the Map's own cards know its title and parent
      const row = scopes?.tickets.find((x) => x.id === scope.ticketId);
      const node = mapTickets?.find((x) => x.id === scope.ticketId);
      const parent = node?.parentId ? mapTickets?.find((x) => x.id === node.parentId) : undefined;
      const story = isStory(scopes, scope.ticketId)
        ? scope.ticketId
        : (row?.storyId ?? (parent?.type === 'story' ? parent.id : null));
      const title = row?.title ?? scopes?.stories.find((x) => x.id === scope.ticketId)?.title ?? node?.title;
      if (story && story !== scope.ticketId) {
        list.push({ key: 'story', label: <>Story {story}</>, scope: { teamId: null, ticketId: story } });
      }
      list.push({
        key: 'ticket',
        label: (
          <>
            {isStory(scopes, scope.ticketId) || node?.type === 'story' ? 'Story ' : ''}
            {scope.ticketId}
            {title ? ` · ${title}` : ''}
          </>
        ),
        scope: null,
      });
    } else {
      list.push({ key: 'all', label: 'All teams', scope: null });
    }
    return list;
  }, [projectName, scope, scopes, mapTickets]);

  const teams = (scopes?.teams ?? []).filter((t) => matches(q, t.name));
  const stories = (scopes?.stories ?? []).filter((s) => matches(q, s.id, s.title));
  const tickets = (scopes?.tickets ?? []).filter((t) => matches(q, t.id, t.title));
  const pick = (s: FlowScope) => {
    onScope(s);
    setOpen(false);
  };
  const first: FlowScope | null = teams[0]
    ? { teamId: teams[0].id, ticketId: null }
    : stories[0]
      ? { teamId: null, ticketId: stories[0].id }
      : tickets[0]
        ? { teamId: null, ticketId: tickets[0].id }
        : null;

  return (
    <div className="fl-scope" data-testid="flow-scope-bar">
      <div className="fl-scope-row">
        <nav className="fl-crumbs" aria-label="What Flow looks at">
          {crumbs.map((c, i) => (
            <span key={c.key} className="fl-crumb-wrap">
              {i > 0 && <span className="fl-sepchar">›</span>}
              {c.scope ? (
                <button
                  type="button"
                  className="fl-crumb"
                  onClick={() => c.scope && onScope(c.scope)}
                  title="Go up one level"
                >
                  {c.label}
                </button>
              ) : i === crumbs.length - 1 ? (
                <b className="fl-crumb here" aria-current="page">
                  {c.label}
                </b>
              ) : (
                <span className="fl-crumb">{c.label}</span>
              )}
            </span>
          ))}
        </nav>
        <div className="fl-picker" ref={wrap}>
          <button
            type="button"
            className={`tl-btn fl-picker-btn${open ? ' open' : ''}`}
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            ref={button}
            data-testid="flow-picker-button"
          >
            Go to a team, Story or ticket
            <kbd className="fl-kbd">/</kbd>
          </button>
          {open && (
            <div
              className="tl-menu fl-pop"
              role="dialog"
              aria-label="Go to a team, Story or ticket"
              data-testid="flow-picker"
            >
              <input
                ref={input}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="code or words"
                aria-label="Search teams, Stories and tickets"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing && q.trim() && first) {
                    // the same Enter must not press the picker's button once the focus goes back to it
                    e.preventDefault();
                    pick(first);
                  }
                }}
              />
              <div className="fl-list">
                <button
                  type="button"
                  className={!scope.teamId && !scope.ticketId ? 'fl-opt on' : 'fl-opt'}
                  onClick={() => pick(ALL_TEAMS)}
                >
                  <b>All teams</b>
                  <span className="grow">the whole project</span>
                </button>
                {teams.length > 0 && <div className="tl-menu-h">Teams</div>}
                {teams.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className="fl-opt"
                    onClick={() => pick({ teamId: t.id, ticketId: null })}
                    data-testid={`flow-pick-team-${t.id}`}
                  >
                    <i className="fl-dot" style={{ background: t.color ?? '#5B6B60' }} />
                    <b>{t.name}</b>
                    <span className="end">{t.live ? 'working now' : `${t.runs} run${t.runs === 1 ? '' : 's'}`}</span>
                  </button>
                ))}
                {stories.length > 0 && <div className="tl-menu-h">Stories</div>}
                {stories.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className="fl-opt"
                    onClick={() => pick({ teamId: null, ticketId: s.id })}
                    data-testid={`flow-pick-story-${s.id}`}
                  >
                    {s.live && <span className={`at-live-dot ${s.waiting ? 'waiting_you' : 'working'}`} />}
                    <b>{s.id}</b>
                    <span className="grow">{s.title}</span>
                    <span>
                      {s.done} of {s.tickets} done
                    </span>
                  </button>
                ))}
                {tickets.length > 0 && <div className="tl-menu-h">Tickets with AI work</div>}
                {tickets.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className="fl-opt"
                    onClick={() => pick({ teamId: null, ticketId: t.id })}
                    data-testid={`flow-pick-ticket-${t.id}`}
                  >
                    {t.live && <span className={`at-live-dot ${t.waiting ? 'waiting_you' : 'working'}`} />}
                    <b>{t.id}</b>
                    <span className="grow">{t.title}</span>
                    {t.storyId && <span>in {t.storyId}</span>}
                  </button>
                ))}
                {!first && q.trim() && <div className="tl-menu-empty">Nothing matches “{q}”.</div>}
              </div>
              <div className="tl-menu-foot">Enter opens the first match · Esc closes</div>
            </div>
          )}
        </div>
        <span style={{ flex: 1 }} />
        {right}
        <button type="button" className="tl-btn" onClick={onCopyLink} data-testid="flow-copy-link">
          Copy link
        </button>
        <div className="at-seg" style={{ margin: 0 }} role="group" aria-label="View">
          <button
            type="button"
            className={view === 'map' ? 'on' : ''}
            onClick={() => onView('map')}
            data-testid="flow-view-map"
          >
            Map
          </button>
          <button
            type="button"
            className={view === 'timeline' ? 'on' : ''}
            onClick={() => onView('timeline')}
            data-testid="flow-view-timeline"
          >
            Timeline
          </button>
        </div>
      </div>
      <div className="at-hint" data-testid="flow-summary">
        {summary}
      </div>
    </div>
  );
}
