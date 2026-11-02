import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { FlowStory } from '../../api/aiTeam';
import { useToast } from '../Toast';
import {
  pickerRows,
  scopeLevel,
  scopeUp,
  storyLine,
  storyLook,
  ticketLine,
  type FlowScope,
  type FlowView,
  type PickRow,
  type PickTicket,
} from './flowScope';
import './flowScope.css';

/** A 24 × 24 stroked icon. */
export function FsIcon({
  d,
  size = 13,
  color = 'currentColor',
  width = 1.7,
}: {
  d: string;
  size?: number;
  color?: string;
  width?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <path d={d} />
    </svg>
  );
}

export const FS_ICON = {
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  story: 'M6.5 3h11a1 1 0 0 1 1 1v17l-6.5-4.2L5.5 21V4a1 1 0 0 1 1-1z',
  ticket: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8 12.5l3 3 5-6',
  chevron: 'M9 6l6 6-6 6',
  search: 'M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM16 16l4.5 4.5',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  inbox: 'M3 13l3-8h12l3 8v6H3zM3 13h5l1 3h6l1-3h5',
};

function typing(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

function Crumb({
  icon,
  iconColor,
  code,
  title,
  last,
  onClick,
  label,
}: {
  icon: string;
  iconColor: string;
  code?: string;
  title: string;
  last: boolean;
  onClick: () => void;
  label: string;
}) {
  const body = (
    <>
      <FsIcon d={icon} color={iconColor} width={last ? 2 : 1.7} />
      {code ? <span className="fs-code">{code}</span> : null}
      <span className="fs-crumb-t">{title}</span>
    </>
  );
  return last ? (
    <span className="fs-crumb on" aria-current="location">
      {body}
    </span>
  ) : (
    <button type="button" className="fs-crumb" onClick={onClick} title={label}>
      {body}
    </button>
  );
}

/**
 * The scope bar of Flow (design/screens/ai-story-flow.md, G): the breadcrumb (project › Story › ticket, every part but
 * the last goes up), the picker on "/" or a click, Copy link, then the Team map / Timeline switch with a line that says
 * what is drawn. Keys: "/" picker, "[" one level up, "]" down into what the pointer is on.
 */
export function ScopeBar({
  projectName,
  scope,
  storyTitle,
  ticketTitle,
  view,
  onView,
  onScope,
  hint,
  extra,
  stories,
  tickets,
  onPickerOpen,
  link,
  hovered = null,
}: {
  projectName: string;
  scope: FlowScope;
  storyTitle: string | null;
  ticketTitle: string | null;
  view: FlowView;
  onView: (v: FlowView) => void;
  onScope: (s: FlowScope) => void;
  /** What is drawn, beside the view switch. */
  hint: string;
  /** A button on the right of the second row (Open the Story page). */
  extra?: ReactNode;
  stories: FlowStory[];
  tickets: PickTicket[];
  /** The picker opened: the parent loads the project's recent tickets. */
  onPickerOpen?: () => void;
  /** The address Copy link puts on the clipboard. */
  link: string;
  /** What the pointer is on in the drawing ("]" goes into it). */
  hovered?: FlowScope | null;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [at, setAt] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const toast = useToast();
  const level = scopeLevel(scope);
  const rows = useMemo(() => pickerRows(query, stories, tickets), [query, stories, tickets]);

  const show = () => {
    setQuery('');
    setAt(0);
    setOpen(true);
    onPickerOpen?.();
  };
  const pick = (r: PickRow) => {
    setOpen(false);
    if (r.kind === 'story') onScope({ story: r.story.id, ticket: null });
    else onScope({ story: r.ticket.storyId, ticket: r.ticket.id });
  };

  // "/" opens the picker, "[" goes up, "]" goes into what is hovered: never while the person types somewhere
  const keys = useRef({ open, scope, hovered, show, onScope });
  keys.current = { open, scope, hovered, show, onScope };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      const k = keys.current;
      if (e.key === '/' && !k.open) {
        e.preventDefault();
        k.show();
      } else if (e.key === '[' && !k.open && scopeLevel(k.scope) !== 'project') {
        e.preventDefault();
        k.onScope(scopeUp(k.scope));
      } else if (e.key === ']' && !k.open && k.hovered) {
        e.preventDefault();
        k.onScope(k.hovered);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // a click outside closes the picker
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const copy = () => {
    const done = navigator.clipboard?.writeText(link);
    if (!done) {
      toast.error("Couldn't copy the link");
      return;
    }
    done
      .then(() => toast.success('Link copied', 'It opens this scope and this view.'))
      .catch(() => toast.error("Couldn't copy the link"));
  };

  const firstTicket = rows.findIndex((r) => r.kind === 'ticket');

  return (
    <div className="fs-wrap" data-testid="scope-bar">
      <div className="fs-bar">
        <nav className="fs-crumbs" aria-label="Scope">
          <Crumb
            icon={FS_ICON.folder}
            iconColor="#5B6B60"
            title={projectName}
            last={level === 'project'}
            onClick={() => onScope({ story: null, ticket: null })}
            label="The whole project"
          />
          {scope.story ? (
            <>
              <FsIcon d={FS_ICON.chevron} color="#9AA8A0" />
              <Crumb
                icon={FS_ICON.story}
                iconColor="#1B3A6B"
                code={scope.story}
                title={storyTitle ?? ''}
                last={level === 'story'}
                onClick={() => onScope({ story: scope.story, ticket: null })}
                label={`The Story ${scope.story}`}
              />
            </>
          ) : null}
          {scope.ticket ? (
            <>
              <FsIcon d={FS_ICON.chevron} color="#9AA8A0" />
              <Crumb
                icon={FS_ICON.ticket}
                iconColor="#2F6FB0"
                code={scope.ticket}
                title={ticketTitle ?? ''}
                last
                onClick={() => onScope(scope)}
                label={scope.ticket}
              />
            </>
          ) : null}
        </nav>
        <span style={{ flex: 1 }} />
        <div className="fs-pickwrap" ref={boxRef}>
          <button
            type="button"
            className={`st-btn st-btn-sm fs-go${open ? ' on' : ''}`}
            onClick={() => (open ? setOpen(false) : show())}
            aria-haspopup="listbox"
            aria-expanded={open}
            title="Go to a Story or ticket (/)"
            data-testid="scope-picker-btn"
          >
            <FsIcon d={FS_ICON.search} />
            <span className="fs-go-t">Go to a Story or ticket</span>
            <span className="fs-kbd">/</span>
          </button>
          {open && (
            <div className="fs-picker" role="dialog" aria-label="Go to a Story or ticket" data-testid="scope-picker">
              <div className="fs-pick-in">
                <FsIcon d={FS_ICON.search} color="#5B6B60" />
                <input
                  autoFocus
                  value={query}
                  placeholder="Find a Story or ticket"
                  aria-label="Find a Story or ticket"
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setAt(0);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      setAt((n) => Math.min(n + 1, Math.max(rows.length - 1, 0)));
                    } else if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      setAt((n) => Math.max(n - 1, 0));
                    } else if (e.key === 'Enter' && rows[at]) {
                      e.preventDefault();
                      pick(rows[at]);
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      setOpen(false);
                    }
                  }}
                />
                <span className="fs-pick-hint">code or words</span>
              </div>
              <div className="fs-pick-list" role="listbox">
                {rows.length === 0 && <div className="fs-pick-empty">Nothing matches “{query}”.</div>}
                {rows.map((r, i) => {
                  const head =
                    i === 0 && r.kind === 'story' ? 'Stories running now' : i === firstTicket ? 'Recent tickets' : null;
                  return (
                    <div key={r.kind === 'story' ? `s-${r.story.id}` : `t-${r.ticket.id}`}>
                      {head && <div className="fs-pick-h">{head}</div>}
                      {r.kind === 'story' ? (
                        <StoryRow story={r.story} on={i === at} onPick={() => pick(r)} onHover={() => setAt(i)} />
                      ) : (
                        <TicketRow ticket={r.ticket} on={i === at} onPick={() => pick(r)} onHover={() => setAt(i)} />
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="fs-pick-foot">
                <span>
                  <span className="fs-kbd">↑</span> <span className="fs-kbd">↓</span> move
                </span>
                <span>
                  <span className="fs-kbd">Enter</span> open
                </span>
                <span>
                  <span className="fs-kbd">Esc</span> close
                </span>
              </div>
            </div>
          )}
        </div>
        <button
          type="button"
          className="st-btn st-btn-sm fs-go"
          onClick={copy}
          title="Copy link"
          aria-label="Copy link"
          data-testid="scope-copy-link"
        >
          <FsIcon d={FS_ICON.link} />
          <span className="fs-go-t">Copy link</span>
        </button>
      </div>
      <div className="fs-row2">
        <div className="at-seg" style={{ marginLeft: 0, flex: 'none' }} role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'map'}
            className={view === 'map' ? 'on' : ''}
            onClick={() => onView('map')}
          >
            Team map
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'timeline'}
            className={view === 'timeline' ? 'on' : ''}
            onClick={() => onView('timeline')}
            data-testid="flow-timeline-tab"
          >
            Timeline
          </button>
        </div>
        <span className="fs-hint">{hint}</span>
        <span style={{ flex: 1 }} />
        {extra}
      </div>
    </div>
  );
}

function StoryRow({
  story,
  on,
  onPick,
  onHover,
}: {
  story: FlowStory;
  on: boolean;
  onPick: () => void;
  onHover: () => void;
}) {
  const look = storyLook(story.state, { blocked: !!story.blocked, planWaiting: story.planWaiting });
  return (
    <button
      type="button"
      role="option"
      aria-selected={on}
      className={`fs-pick-row${on ? ' on' : ''}`}
      onClick={onPick}
      onMouseEnter={onHover}
    >
      <span className="fs-pick-ico">
        <FsIcon d={FS_ICON.story} color="#1B3A6B" width={2} />
      </span>
      <span className="fs-pick-code">{story.id}</span>
      <span className="fs-pick-body">
        <span className="fs-pick-title">{story.title}</span>
        <span className="fs-pick-sub">{storyLine(story)}</span>
      </span>
      <span className="fs-chip" style={{ background: look.bg, color: look.fg }}>
        <FsIcon d={look.icon} size={11} color={look.fg} width={2.2} />
        {look.label}
      </span>
    </button>
  );
}

function TicketRow({
  ticket,
  on,
  onPick,
  onHover,
}: {
  ticket: PickTicket;
  on: boolean;
  onPick: () => void;
  onHover: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={on}
      className={`fs-pick-row${on ? ' on' : ''}`}
      onClick={onPick}
      onMouseEnter={onHover}
    >
      <FsIcon
        d={FS_ICON.ticket}
        size={16}
        color={ticket.live ? '#2F6FB0' : ticket.completed ? '#2E6F40' : '#9AA8A0'}
        width={2}
      />
      <span className="fs-pick-code">{ticket.id}</span>
      <span className="fs-pick-body">
        <span className="fs-pick-title">{ticket.title}</span>
        <span className="fs-pick-sub">{ticketLine(ticket)}</span>
      </span>
    </button>
  );
}
