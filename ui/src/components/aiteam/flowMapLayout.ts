/**
 * The Map of Flow (AI v2): you on the left, the teams in a column (a team opens to show its roles), the tickets worked
 * in a column on the right. Notes between teams are arcs in a channel at the right of the teams; parent-child and
 * blocked-by are arcs at the right of the tickets. The height of the map follows the taller column.
 */
import type { FlowEdge, FlowMapData, FlowTeamNode, FlowTicketNode } from '../../types/aiFlow';

export const YOU_X = 12;
export const YOU_W = 150;
export const TEAM_X = 330;
export const TEAM_W = 250;
export const TEAM_HEAD = 54;
export const ROLE_H = 24;
const TEAM_GAP = 18;
const TOP = 10;
export const TICKET_W = 262;
export const TICKET_H = 54;
const TICKET_GAP = 12;
/** How far the first arc reaches into a channel, and each next one further (design AiTeam 7, 1). */
const ARC_FIRST = 72;
const ARC_STEP = 38;
/** From the end of the notes' channel to the tickets. */
const TAKE_SPAN = 134;
/** The room right of the tickets for the blocked-by arcs and their pills: the least that fits, and what the design
 * leaves when the map is stretched to the tab (AiTeam 7, 1: 200 px). With no blocked-by the margin is small. */
const BLOCKED_ROOM = 112;
const BLOCKED_ROOM_STRETCHED = 200;
const MARGIN_R = 24;
/** Where a "took the ticket" and a child arrow land on a ticket card, from its top. */
const TAKE_DY = 21;
const CHILD_DY = 37;
/** One team that asks you gets a slot of this height in the You card; the ask is at +40, your answer at +66. */
const SLOT_H = 60;
/** How far a child ticket is set in under its parent. */
export const INDENT = 26;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlacedEdge {
  edge: FlowEdge;
  /** SVG path. */
  d: string;
  /** Where the label pill sits. */
  lx: number;
  ly: number;
  label: string;
}

export interface FlowLayout {
  width: number;
  height: number;
  you: Box;
  teams: { node: FlowTeamNode; box: Box; open: boolean }[];
  tickets: { node: FlowTicketNode; box: Box }[];
  edges: PlacedEdge[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The words on an edge's pill. */
export function edgeLabel(e: FlowEdge): string {
  switch (e.kind) {
    case 'take':
      return e.count > 1 ? `${e.count} runs` : '';
    case 'note':
      return plural(e.count, 'note');
    case 'ask':
      return e.live ? `asked ${e.count}, waiting` : `asked ${e.count}`;
    case 'answer':
      return `answered ${e.count}`;
    case 'child':
      return 'child of';
    case 'blocked':
      return 'blocked by';
  }
}

const cubic = (x1: number, y1: number, x2: number, y2: number) => {
  const dx = Math.max(Math.abs(x2 - x1) / 2, 30);
  const sign = x2 >= x1 ? 1 : -1;
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  return {
    d: `M${x1} ${y1} C${x1 + sign * dx} ${y1} ${x2 - sign * dx} ${y2} ${x2} ${y2}`,
    lx: mx,
    ly: my,
  };
};

/** The tickets in the order they are drawn: grouped by the team that took them, a parent followed by its children. */
export function orderTickets(tickets: FlowTicketNode[], teamOrder: string[]): FlowTicketNode[] {
  const own = (t: FlowTicketNode) => {
    const r = t.teams.map((id) => teamOrder.indexOf(id)).filter((i) => i >= 0);
    return r.length ? Math.min(...r) : teamOrder.length;
  };
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const kids = new Map<string, FlowTicketNode[]>();
  const roots: FlowTicketNode[] = [];
  for (const t of tickets) {
    if (t.parentId && byId.has(t.parentId)) kids.set(t.parentId, [...(kids.get(t.parentId) ?? []), t]);
    else roots.push(t);
  }
  // a parent sorts with its first child: a Story that no team took sits beside the team that took its children
  const rank = (t: FlowTicketNode, path: ReadonlySet<string> = new Set()): number =>
    path.has(t.id)
      ? Infinity // a parent loop: do not go round again
      : Math.min(own(t), ...(kids.get(t.id) ?? []).map((c) => rank(c, new Set([...path, t.id]))));
  const sorted = (list: FlowTicketNode[]) => [...list].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
  const out: FlowTicketNode[] = [];
  const seen = new Set<string>();
  const walk = (t: FlowTicketNode) => {
    if (seen.has(t.id)) return;
    seen.add(t.id);
    out.push(t);
    for (const c of sorted(kids.get(t.id) ?? [])) walk(c);
  };
  for (const r of sorted(roots)) walk(r);
  // tickets in a parent loop (A under B under A) have no root: they are drawn after the rest, never dropped
  const drawn = new Set(out.map((t) => t.id));
  for (const t of sorted(tickets)) if (!drawn.has(t.id)) walk(t);
  return out;
}

/**
 * Place the nodes and draw the edges.
 * @param data - The Map read from the server.
 * @param open - Ids of the teams drawn open (their roles listed).
 * @param availWidth - The width of the box the map sits in: the tickets keep to its right edge when it is wider than
 *   the map needs (design AiTeam 7: the map stretches to the tab).
 */
export function layoutFlow(data: FlowMapData, open: ReadonlySet<string>, availWidth = 0): FlowLayout {
  const teamIds = data.teams.map((t) => t.id);
  const tickets = orderTickets(data.tickets, teamIds);

  // teams, top to bottom
  let y = TOP;
  const teams = data.teams.map((node) => {
    const isOpen = open.has(node.id) && node.roles.length > 0;
    const h = TEAM_HEAD + (isOpen ? 8 + node.roles.length * ROLE_H : 0);
    const box = { x: TEAM_X, y, w: TEAM_W, h };
    y += h + TEAM_GAP;
    return { node, box, open: isOpen };
  });
  const teamsBottom = teams.length ? y - TEAM_GAP : TOP;
  const teamBox = new Map(teams.map((t) => [t.node.id, t.box]));

  // the arcs between teams decide how wide the channel is
  const notes = data.edges.filter((e) => e.kind === 'note' && teamBox.has(e.from) && teamBox.has(e.to));
  const noteChannel = notes.length ? ARC_FIRST + (notes.length - 1) * ARC_STEP + 44 : 20;
  const takeX = TEAM_X + TEAM_W + noteChannel;
  const blockedCount = data.edges.filter((e) => e.kind === 'blocked').length;
  const arcRoom = blockedCount ? BLOCKED_ROOM + (blockedCount - 1) * ARC_STEP : MARGIN_R;
  const stretchRoom = blockedCount ? BLOCKED_ROOM_STRETCHED + (blockedCount - 1) * ARC_STEP : MARGIN_R;
  const ticketX = Math.max(takeX + TAKE_SPAN, availWidth - TICKET_W - stretchRoom);

  const ids = new Set(tickets.map((t) => t.id));
  const depthOf = (t: FlowTicketNode): number => {
    let d = 0;
    for (let p = t.parentId; p && ids.has(p) && d < 4; p = tickets.find((x) => x.id === p)?.parentId ?? null) d++;
    return d;
  };
  const placedTickets = tickets.map((node, i) => {
    const d = depthOf(node);
    return {
      node,
      box: { x: ticketX + d * INDENT, y: TOP + i * (TICKET_H + TICKET_GAP), w: TICKET_W - d * INDENT, h: TICKET_H },
    };
  });
  const ticketBox = new Map(placedTickets.map((t) => [t.node.id, t.box]));
  const ticketsBottom = placedTickets.length ? TOP + placedTickets.length * (TICKET_H + TICKET_GAP) - TICKET_GAP : TOP;

  // you: a slot on the right edge for every team that asked or got an answer
  const talk = teamIds.filter((id) =>
    data.edges.some((e) => (e.kind === 'ask' || e.kind === 'answer') && (e.from === id || e.to === id)),
  );
  const youH = Math.max(120, 54 + talk.length * SLOT_H);
  const colBottom = Math.max(teamsBottom, ticketsBottom, youH + TOP);
  const youY = Math.max(TOP, Math.round((Math.max(teamsBottom, youH) - youH) / 2));
  const you = { x: YOU_X, y: youY, w: YOU_W, h: youH };

  const edges: PlacedEdge[] = [];
  const headY = (id: string, dy = 0) => (teamBox.get(id)?.y ?? 0) + TEAM_HEAD / 2 + dy;
  const mid = (b: Box) => b.y + b.h / 2;
  let noteK = 0;
  let ticketArcK = 0;
  for (const e of data.edges) {
    const label = edgeLabel(e);
    if (e.kind === 'take') {
      const t = ticketBox.get(e.to);
      const tb = teamBox.get(e.from);
      if (!t || !tb) continue;
      // straight out of the team to the end of the notes' channel, then a curve to the ticket
      const x1 = tb.x + tb.w;
      const y1 = headY(e.from);
      const y2 = t.y + TAKE_DY;
      const cx = takeX + (t.x - takeX) / 2;
      const w = label.length * 6 + 14;
      edges.push({
        edge: e,
        d: `M${x1} ${y1} H${takeX} C${cx} ${y1} ${cx} ${y2} ${t.x} ${y2}`,
        // the pill sits at the arrow's head, clear of the crossings in the middle
        lx: t.x - 8 - w / 2,
        ly: y2,
        label,
      });
    } else if (e.kind === 'note') {
      const a = teamBox.get(e.from);
      const b = teamBox.get(e.to);
      if (!a || !b) continue;
      const x = TEAM_X + TEAM_W;
      const reach = ARC_FIRST + noteK++ * ARC_STEP;
      const dy = e.from === e.to ? 0 : 6;
      const y1 = headY(e.from, dy);
      const y2 = headY(e.to, -dy);
      edges.push({
        edge: e,
        d: `M${x} ${y1} C${x + reach} ${y1} ${x + reach} ${y2} ${x} ${y2}`,
        lx: x + reach * 0.75,
        ly: (y1 + y2) / 2,
        label,
      });
    } else if (e.kind === 'ask' || e.kind === 'answer') {
      const id = e.kind === 'ask' ? e.from : e.to;
      const tb = teamBox.get(id);
      if (!tb) continue;
      const slot = youY + 40 + talk.indexOf(id) * SLOT_H + (e.kind === 'ask' ? 0 : 26);
      const ty = tb.y + (e.kind === 'ask' ? 14 : 40);
      const p = e.kind === 'ask' ? cubic(tb.x, ty, you.x + you.w, slot) : cubic(you.x + you.w, slot, tb.x, ty);
      edges.push({ edge: e, ...p, label });
    } else if (e.kind === 'child') {
      // a child sits under its parent, set in: an elbow from the parent's left side down to the child
      const a = ticketBox.get(e.from);
      const b = ticketBox.get(e.to);
      if (!a || !b) continue;
      const x = a.x + 12;
      const y2 = b.y + CHILD_DY;
      edges.push({
        edge: e,
        d: `M${x} ${a.y + a.h} V${y2 - 6} Q${x} ${y2} ${x + 8} ${y2} H${b.x}`,
        lx: 0,
        ly: 0,
        label: '',
      });
    } else {
      // blocked-by: an arc at the right of the column, from the blocked ticket to the one it waits for
      const a = ticketBox.get(e.from);
      const b = ticketBox.get(e.to);
      if (!a || !b) continue;
      const x = Math.max(a.x + a.w, b.x + b.w);
      const reach = ARC_FIRST + ticketArcK++ * ARC_STEP;
      const y1 = mid(b);
      const y2 = mid(a);
      edges.push({
        edge: e,
        d: `M${b.x + b.w} ${y1} H${x} C${x + reach} ${y1} ${x + reach} ${y2} ${a.x + a.w} ${y2}`,
        lx: x + reach * 0.78,
        ly: (y1 + y2) / 2,
        label,
      });
    }
  }

  return {
    width: Math.max(availWidth, ticketX + TICKET_W + arcRoom),
    height: colBottom + 24,
    you,
    teams,
    tickets: placedTickets,
    edges,
  };
}
