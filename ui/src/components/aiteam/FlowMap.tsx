import { useMemo, useState } from 'react';
import type { FlowEdgeKind, FlowMapData, FlowTeamNode, FlowTicketNode } from '../../types/aiFlow';
import { TEAM_HEAD, ROLE_H, TICKET_W, layoutFlow, type PlacedEdge } from './flowMapLayout';

/** How each kind of edge is drawn: the same colours as the Timeline's arrows where the meaning is the same. */
export const EDGE_LOOK: Record<FlowEdgeKind, { color: string; dash?: string; marker: string; word: string }> = {
  take: { color: '#2E6F40', marker: 'fm-take', word: 'took the ticket' },
  note: { color: '#0F8B8D', dash: '6 4', marker: 'fm-note', word: 'note to another team' },
  ask: { color: '#B8860B', marker: 'fm-ask', word: 'question to you' },
  answer: { color: '#1E2A22', dash: '2 4', marker: 'fm-answer', word: 'your answer' },
  child: { color: '#7B8A81', marker: 'fm-child', word: 'child of' },
  blocked: { color: '#C4432A', dash: '5 4', marker: 'fm-blocked', word: 'blocked by' },
};

const STATE_WORD: Record<string, string> = {
  working: 'working',
  waiting: 'waiting for you',
  queued: 'queued',
  offline: 'offline',
  idle: 'idle',
  paused: 'paused',
};
const STATE_COLOR: Record<string, string> = {
  working: '#2E6F40',
  waiting: '#8A6A12',
  queued: '#5B6B60',
  offline: '#C4432A',
  idle: '#7B8A81',
  paused: '#7B8A81',
};
const STATUS_WORD: Record<string, string> = {
  backlog: 'Backlog',
  todo: 'To do',
  'in-progress': 'In progress',
  done: 'Done',
};

const initials = (name: string) => {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2)).toUpperCase();
};

function EdgePath({ p, dim }: { p: PlacedEdge; dim: boolean }) {
  const look = EDGE_LOOK[p.edge.kind];
  return (
    <g opacity={dim ? 0.14 : 1} data-testid={`flow-edge-${p.edge.id}`} data-kind={p.edge.kind}>
      <title>{`${look.word}${p.edge.label ? `: ${p.edge.label}` : ''}`}</title>
      <path
        d={p.d}
        fill="none"
        stroke={look.color}
        strokeWidth={p.edge.kind === 'child' ? 1.6 : 2}
        strokeDasharray={look.dash}
        className={p.edge.live ? 'at-live-edge' : undefined}
        markerEnd={`url(#${look.marker})`}
      />
      {p.label && (
        <g>
          <rect
            x={p.lx - p.label.length * 3 - 7}
            y={p.ly - 9}
            width={p.label.length * 6 + 14}
            height={18}
            rx={9}
            fill="#fff"
            stroke={look.color}
            strokeOpacity={0.5}
          />
          <text x={p.lx} y={p.ly + 4} fontSize={10} fontWeight={700} fill={look.color} textAnchor="middle">
            {p.label}
          </text>
        </g>
      )}
    </g>
  );
}

function TeamCard({
  node,
  box,
  open,
  hot,
  onToggle,
  onScope,
  onHover,
}: {
  node: FlowTeamNode;
  box: { x: number; y: number; w: number; h: number };
  open: boolean;
  hot: boolean;
  onToggle: () => void;
  onScope: () => void;
  onHover: (id: string | null) => void;
}) {
  const color = node.color ?? '#5B6B60';
  const idle = node.runs === 0;
  return (
    <div
      className={`fl-node fl-team${hot ? ' hot' : ''}${idle ? ' idle' : ''}`}
      style={{ left: box.x, top: box.y, width: box.w, height: box.h, borderColor: color }}
      onMouseEnter={() => onHover(node.id)}
      onMouseLeave={() => onHover(null)}
      data-testid={`flow-team-${node.id}`}
    >
      <div className="fl-team-h" style={{ background: `${color}1F`, height: TEAM_HEAD }}>
        <span className="fl-avatar" style={{ background: color }}>
          {initials(node.name)}
        </span>
        <span className="fl-team-t">
          <button
            type="button"
            className="fl-name"
            onClick={onScope}
            title="Look at this team only"
            data-testid={`flow-team-scope-${node.id}`}
          >
            {node.name}
          </button>
          <span className="fl-sub">
            <i className="fl-dot" style={{ background: STATE_COLOR[node.state] }} />
            <span style={{ color: STATE_COLOR[node.state], fontWeight: 700 }}>{STATE_WORD[node.state]}</span>
            {' · '}
            <span title={`${node.tickets} ticket${node.tickets === 1 ? '' : 's'}`}>
              {node.runs === 0 ? 'nothing in this range' : `${node.runs} run${node.runs === 1 ? '' : 's'}`}
            </span>
          </span>
        </span>
        {node.roles.length > 0 && (
          <button
            type="button"
            className="fl-mini"
            aria-expanded={open}
            onClick={onToggle}
            data-testid={`flow-team-toggle-${node.id}`}
            title={open ? 'Hide its roles' : 'Show the roles it called'}
          >
            {open ? 'Close' : `${node.roles.length} role${node.roles.length === 1 ? '' : 's'}`}
          </button>
        )}
      </div>
      {open && (
        <ul className="fl-roles">
          {node.roles.map((r) => (
            <li key={r.id} style={{ height: ROLE_H }}>
              <i className="fl-dot" style={{ background: r.color }} />
              <b>{r.name}</b>
              <span>
                {r.calls} call{r.calls === 1 ? '' : 's'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TicketCard({
  node,
  box,
  hot,
  onOpen,
  onScope,
  onHover,
}: {
  node: FlowTicketNode;
  box: { x: number; y: number; w: number; h: number };
  hot: boolean;
  onOpen: () => void;
  onScope: () => void;
  onHover: (id: string | null) => void;
}) {
  return (
    <div
      className={`fl-node fl-ticket${node.live ? ` live ${node.live}` : ''}${node.context ? ' context' : ''}${hot ? ' hot' : ''}`}
      style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
      onMouseEnter={() => onHover(node.id)}
      onMouseLeave={() => onHover(null)}
      data-testid={`flow-ticket-${node.id}`}
    >
      <button type="button" className="fl-ticket-main" onClick={onOpen} title={`Open ${node.id}`}>
        <span className="fl-ticket-top">
          {node.live && <span className={`at-live-dot ${node.live === 'waiting' ? 'waiting_you' : 'working'}`} />}
          <b>{node.id}</b>
          {!node.context && <span className="fl-status">{STATUS_WORD[node.status] ?? node.status}</span>}
          {node.type === 'story' && <span className="fl-badge">Story</span>}
          {node.context && (
            <span className="fl-badge muted" title="No run in this range: drawn because a ticket that ran points at it">
              no run
            </span>
          )}
        </span>
        <span className="fl-ticket-title" title={node.title}>
          {node.title}
        </span>
      </button>
      <button
        type="button"
        className="fl-mini ghost"
        onClick={onScope}
        title={`Look at the flow of ${node.id}`}
        data-testid={`flow-ticket-scope-${node.id}`}
      >
        Flow
      </button>
    </div>
  );
}

/**
 * Flow › Map: you, the teams (open one to see its roles) and the tickets being worked, with an edge for the team that
 * took a ticket, a note between teams, a question to you and your answer, a parent and its child, and blocked-by.
 * @param props.data - The Map from the server.
 * @param props.rangeWord - The range in words ("today"), for the empty state.
 * @param props.onWiden - Widen the range (shown when nothing ran in it).
 * @param props.onOpenTicket - Open a ticket.
 * @param props.onScopeTeam - Look at one team only.
 * @param props.onScopeTicket - Look at one ticket's flow.
 */
export function FlowMap({
  data,
  rangeWord,
  onWiden,
  onOpenTicket,
  onScopeTeam,
  onScopeTicket,
}: {
  data: FlowMapData;
  rangeWord: string;
  onWiden: (() => void) | null;
  onOpenTicket: (ticketId: string) => void;
  onScopeTeam: (teamId: string) => void;
  onScopeTicket: (ticketId: string) => void;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [hot, setHot] = useState<string | null>(null);
  const layout = useMemo(() => layoutFlow(data, open), [data, open]);
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const touches = (e: PlacedEdge['edge']) => !hot || e.from === hot || e.to === hot || e.tickets.includes(hot);
  const youWaiting = data.you.waiting;
  const kinds = new Set(data.edges.map((e) => e.kind));
  const noWork = data.tickets.length === 0;

  return (
    <div data-testid="flow-map">
      <div className="fl-map" role="group" aria-label="Map of the teams, you and the tickets">
        <div className="fl-map-in" style={{ width: layout.width, height: layout.height }}>
          <svg
            width={layout.width}
            height={layout.height}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            className="fl-svg"
            aria-hidden="true"
          >
            <defs>
              {Object.values(EDGE_LOOK).map((l) => (
                <marker
                  key={l.marker}
                  id={l.marker}
                  viewBox="0 0 10 10"
                  refX="8"
                  refY="5"
                  markerWidth="8"
                  markerHeight="8"
                  markerUnits="userSpaceOnUse"
                  orient="auto"
                >
                  <path d="M0 0L10 5L0 10z" fill={l.color} />
                </marker>
              ))}
            </defs>
            {layout.edges.map((p) => (
              <EdgePath key={p.edge.id} p={p} dim={!touches(p.edge)} />
            ))}
          </svg>

          <div
            className={`fl-node fl-you${hot === 'you' ? ' hot' : ''}`}
            style={{ left: layout.you.x, top: layout.you.y, width: layout.you.w, height: layout.you.h }}
            onMouseEnter={() => setHot('you')}
            onMouseLeave={() => setHot(null)}
            data-testid="flow-you"
          >
            <b>You</b>
            <span>asked by the teams: {data.you.asked}</span>
            <span style={youWaiting ? { color: '#7A5A06', fontWeight: 700 } : undefined}>
              {youWaiting ? `${youWaiting} waiting for your answer` : 'nothing waits for you'}
            </span>
          </div>

          {layout.teams.map((t) => (
            <TeamCard
              key={t.node.id}
              node={t.node}
              box={t.box}
              open={t.open}
              hot={hot === t.node.id}
              onToggle={() => toggle(t.node.id)}
              onScope={() => onScopeTeam(t.node.id)}
              onHover={setHot}
            />
          ))}

          {layout.tickets.map((t) => (
            <TicketCard
              key={t.node.id}
              node={t.node}
              box={t.box}
              hot={hot === t.node.id}
              onOpen={() => onOpenTicket(t.node.id)}
              onScope={() => onScopeTicket(t.node.id)}
              onHover={setHot}
            />
          ))}

          {noWork && (
            <div
              className="fl-none"
              style={{ left: layout.tickets[0]?.box.x ?? layout.width - TICKET_W - 30, top: 10, width: TICKET_W }}
              data-testid="flow-map-empty"
              role="status"
            >
              <b>No ticket was worked {rangeWord}</b>
              <span className="at-hint">
                The teams stay so you can see who is there. Tickets show here once a team takes one.
              </span>
              {onWiden && (
                <button type="button" className="tl-btn primary" onClick={onWiden}>
                  Widen the range
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      {data.runsTruncated && (
        <div className="at-hint" style={{ marginTop: 8 }} data-testid="flow-runs-truncated">
          Only the newest runs are drawn: the oldest ones of this range are not on the map. Pick a shorter range.
        </div>
      )}
      {data.truncated && (
        <div className="at-hint" style={{ marginTop: 8 }}>
          Showing the first tickets only. Narrow the range or look at one team or one ticket to see the rest.
        </div>
      )}
      <div className="fl-legend" data-testid="flow-legend">
        {(Object.keys(EDGE_LOOK) as FlowEdgeKind[]).map((k) => (
          <span key={k} className={kinds.has(k) ? '' : 'off'}>
            <svg width="26" height="8" aria-hidden="true">
              <line
                x1="1"
                y1="4"
                x2="25"
                y2="4"
                stroke={EDGE_LOOK[k].color}
                strokeWidth="2"
                strokeDasharray={EDGE_LOOK[k].dash}
              />
            </svg>
            {EDGE_LOOK[k].word}
          </span>
        ))}
      </div>
    </div>
  );
}
