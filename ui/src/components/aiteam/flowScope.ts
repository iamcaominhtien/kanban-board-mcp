import type { FlowCluster, FlowStory, ScopedFlowMap, StoryState } from '../../api/aiTeam';

/**
 * Flow by scope (design/screens/ai-story-flow.md, G to I): what the scope bar, the picker and the Story clusters work
 * out from the answers, kept apart from the drawing so it can be tested on its own.
 */

export type FlowView = 'map' | 'timeline';

/** The scope of the Flow tab: both null is the whole project. A ticket keeps the Story it is in. */
export interface FlowScope {
  story: string | null;
  ticket: string | null;
}

export const PROJECT_SCOPE: FlowScope = { story: null, ticket: null };

/** The level of a scope: the whole project, one Story or one ticket. */
export function scopeLevel(s: FlowScope): 'project' | 'story' | 'ticket' {
  return s.ticket ? 'ticket' : s.story ? 'story' : 'project';
}

/** One level up: a ticket goes to its Story (or the project), a Story to the project. */
export function scopeUp(s: FlowScope): FlowScope {
  if (s.ticket) return { story: s.story, ticket: null };
  return PROJECT_SCOPE;
}

/** A Story that is still going (the picker lists these first). */
export const RUNNING: StoryState[] = ['planning', 'in_progress', 'review'];

export interface StoryLook {
  label: string;
  bg: string;
  fg: string;
  /** An icon path (24 × 24, stroked). */
  icon: string;
}

const PLAY = 'M7 5l12 7-12 7z';
const ALERT = 'M12 4l9 16H3L12 4zM12 10v4M12 17v.5';
const EYE =
  'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6z';
const HAND =
  'M8 12V6a1.5 1.5 0 0 1 3 0v5M11 11V4.5a1.5 1.5 0 0 1 3 0V11M14 11V6a1.5 1.5 0 0 1 3 0v8c0 4-2 6-5 6-3 0-4-1.5-5.5-4L4 12a1.5 1.5 0 0 1 2.5-1.5L8 12';
const CHECK = 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8 12.5l3 3 5-6';
const PEN = 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4';
const MAP = 'M4 6l5-2 6 2 5-2v14l-5 2-6-2-5 2zM9 4v14M15 6v14';
const STOP = 'M6 6l12 12M18 6L6 18';

/** The chip of a Story's state, as the Story card draws it (design C2). Blocked and a plan that waits come first. */
export function storyLook(
  state: StoryState | null | undefined,
  opts: { blocked?: boolean; planWaiting?: boolean } = {},
): StoryLook {
  if (opts.planWaiting) return { label: 'Plan needs you', bg: '#FEF3D9', fg: '#7A5A06', icon: HAND };
  if (opts.blocked && state !== 'done' && state !== 'dropped')
    return { label: 'Blocked', bg: '#FDECE8', fg: '#A5321E', icon: ALERT };
  switch (state) {
    case 'in_progress':
      return { label: 'In progress', bg: '#E6F2EA', fg: '#1F5A31', icon: PLAY };
    case 'review':
      return { label: 'Review', bg: '#E9EAF7', fg: '#3F4390', icon: EYE };
    case 'planning':
      return { label: 'Planning', bg: '#E8F1FA', fg: '#244E78', icon: MAP };
    case 'done':
      return { label: 'Done', bg: '#F1F3F1', fg: '#3A4A3E', icon: CHECK };
    case 'dropped':
      return { label: 'Dropped', bg: '#F1F3F1', fg: '#5B6B60', icon: STOP };
    default:
      return { label: 'Draft', bg: '#F1F3F1', fg: '#3A4A3E', icon: PEN };
  }
}

/** "KAN-302 303 304": tickets of one project written once with their prefix, the rest by number. */
export function compactTickets(ids: string[]): { id: string; text: string }[] {
  let prefix: string | null = null;
  return ids.map((id, i) => {
    const m = /^(.*?-)(\d+)$/.exec(id);
    if (i > 0 && m && m[1] === prefix) return { id, text: m[2] };
    prefix = m ? m[1] : null;
    return { id, text: id };
  });
}

/** Which Story each ticket is in, from the plans of the Stories. */
export function storyOfTickets(stories: FlowStory[]): Map<string, FlowStory> {
  const out = new Map<string, FlowStory>();
  for (const s of stories) for (const it of s.plan?.items ?? []) out.set(it.ticketId, s);
  return out;
}

export interface PickTicket {
  id: string;
  title: string;
  status: string;
  /** The Story it is in, for its crumb. */
  storyId: string | null;
  holder: string | null;
  step: string | null;
  completed: boolean;
  live: boolean;
}

export type PickRow = { kind: 'story'; story: FlowStory } | { kind: 'ticket'; ticket: PickTicket };

/** Does `text` match what was typed: a code ("WV-3", "kan 30") or words, every word somewhere. */
export function matches(query: string, ...texts: (string | null | undefined)[]): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = texts.filter(Boolean).join(' ').toLowerCase();
  const squash = hay.replace(/[\s-]/g, '');
  return q
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w) || squash.includes(w.replace(/-/g, '')));
}

/**
 * The picker's rows (design G, 2): the Stories that run, first; with something typed, any Story that matches; then
 * the recent tickets (the live ones first).
 */
export function pickerRows(query: string, stories: FlowStory[], tickets: PickTicket[], max = 8): PickRow[] {
  const q = query.trim();
  const order = (s: FlowStory) => (s.blocked || s.planWaiting ? 0 : s.state === 'in_progress' ? 1 : 2);
  const st = stories
    .filter((s) => (q ? matches(q, s.id, s.title) : RUNNING.includes(s.state)))
    .sort((a, b) => Number(RUNNING.includes(b.state)) - Number(RUNNING.includes(a.state)) || order(a) - order(b))
    .slice(0, max);
  const tk = tickets
    .filter((t) => matches(q, t.id, t.title))
    .sort((a, b) => Number(b.live) - Number(a.live))
    .slice(0, max);
  return [
    ...st.map((story) => ({ kind: 'story' as const, story })),
    ...tk.map((ticket) => ({ kind: 'ticket' as const, ticket })),
  ];
}

/** The tickets of a project map, for the picker. */
export function pickTickets(map: ScopedFlowMap | undefined, storyOf: Map<string, FlowStory>): PickTicket[] {
  return (map?.picker ?? []).map((p) => ({
    id: p.id,
    title: p.title,
    status: p.status,
    storyId: (p as { storyId?: string | null }).storyId ?? storyOf.get(p.id)?.id ?? null,
    holder: p.live?.[0]?.memberName ?? null,
    step: p.live?.[0]?.step || null,
    completed: p.completed,
    live: (p.live?.length ?? 0) > 0,
  }));
}

/** The line under a Story in the picker: "3 of 5 done · PM Linh · 1 time you stepped in". */
export function storyLine(s: FlowStory): string {
  const parts = [`${s.progress?.done ?? 0} of ${s.progress?.total ?? 0} done`];
  if (s.blocked) parts.push(s.blocked.text || 'waiting for you');
  else if (s.planWaiting) parts.push('the plan waits for you');
  else {
    if (s.pm?.name) parts.push(s.pm.name);
    const n = s.interventions?.count ?? 0;
    if (n) parts.push(`${n} time${n === 1 ? '' : 's'} you stepped in`);
  }
  return parts.join(' · ');
}

/** The line under a ticket in the picker: "in KAN-301 · Dev · Build", "no Story · Reviewer". */
export function ticketLine(t: PickTicket): string {
  const where = t.storyId ? `in ${t.storyId}` : 'no Story';
  const who = t.holder ? [t.holder, t.step].filter(Boolean).join(' · ') : t.completed ? 'done' : t.status;
  return who ? `${where} · ${who}` : where;
}

export type ClusterSort = 'activity' | 'state';

const STATE_RANK: Record<string, number> = {
  blocked: 0,
  plan: 1,
  in_progress: 2,
  review: 3,
  planning: 4,
  draft: 5,
  done: 6,
  dropped: 7,
};

/** A cluster joined to its Story (for the chip and the progress bar). */
export interface ClusterRow {
  cluster: FlowCluster;
  story: FlowStory | null;
  done: boolean;
}

/**
 * The Story clusters under the project map (design H, H2): sorted by activity (hand-offs) or by state; the Stories
 * that are done are flagged so they can be folded and faded; the tickets in no Story are returned apart, always last.
 */
export function clusterRows(
  clusters: FlowCluster[],
  stories: FlowStory[],
  sort: ClusterSort,
): { rows: ClusterRow[]; loose: FlowCluster | null } {
  const byId = new Map(stories.map((s) => [s.id, s]));
  const loose = clusters.find((c) => c.storyId == null) ?? null;
  const rows = clusters
    .filter((c) => c.storyId != null)
    .map((cluster) => {
      const story = byId.get(cluster.storyId!) ?? null;
      const state = story?.state ?? cluster.state;
      return { cluster, story, done: state === 'done' || state === 'dropped' };
    });
  const rank = (r: ClusterRow) => {
    const st = r.story;
    if (st?.blocked && !r.done) return STATE_RANK.blocked;
    if (st?.planWaiting) return STATE_RANK.plan;
    return STATE_RANK[st?.state ?? r.cluster.state ?? 'draft'] ?? 5;
  };
  const busy = (r: ClusterRow) => r.cluster.handoffs * 1000 + r.cluster.tickets;
  rows.sort((a, b) =>
    sort === 'state' ? rank(a) - rank(b) || busy(b) - busy(a) : Number(a.done) - Number(b.done) || busy(b) - busy(a),
  );
  return { rows, loose };
}

/** How many Story cards show before the rest fold (design H2: a busy month). */
export const CLUSTERS_SHOWN = 5;

/**
 * An arrow's share in a cluster: the count of the cluster's edge of the same pair and kind (the map draws "2 of 12"),
 * or 0 when the cluster has none of it.
 */
export function shareOf(cluster: FlowCluster | null, e: { from: string; to: string; kind: string }): number {
  if (!cluster) return 0;
  return cluster.edges
    .filter((c) => c.from === e.from && c.to === e.to && c.kind === e.kind)
    .reduce((n, c) => n + c.count, 0);
}
