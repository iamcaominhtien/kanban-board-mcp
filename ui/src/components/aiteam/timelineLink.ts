/**
 * Opening the Timeline from somewhere else, and its link (design/screens/ai-team-timeline.md, A: "Copy link only: it
 * restores the range, the scope and the switches"). The link is URL state: `?aiteam=timeline&tl=…`, read when the app
 * starts. A request made inside the app (the ticket modal's "Open in Timeline") travels as an event.
 */

export interface TimelineLink {
  range?: 'hour' | 'today' | '24h' | '7d';
  /** A custom window (one day opened from the bands). */
  since?: string;
  until?: string;
  scope?: string | null;
  detailed?: boolean;
  real?: boolean;
  /** Kinds hidden by the Show filter. */
  hidden?: string[];
  /** A Flow link (`?aiteam=flow&story=…&view=…`): the scope and the view to open on. */
  flow?: FlowLink;
}

/** Flow's scope and view on the address (design/screens/ai-story-flow.md, G: "Copy link"). */
export interface FlowLink {
  story: string | null;
  ticket: string | null;
  view: 'map' | 'timeline';
}

/**
 * The query names of a Flow link. The ticket of the scope is `flow_ticket`, not `ticket`: the app opens the ticket
 * modal on `?ticket=`.
 */
export const FLOW_PARAMS = ['aiteam', 'story', 'flow_ticket', 'view'] as const;

export const OPEN_TIMELINE_EVENT = 'kanban:open-timeline';

let pending: TimelineLink | null = null;

/** Ask the app to show the Timeline with this state. */
export function openTimeline(link: TimelineLink = {}): void {
  pending = link;
  window.dispatchEvent(new CustomEvent(OPEN_TIMELINE_EVENT));
}

/** The request waiting to be shown, once. */
export function takePendingTimeline(): TimelineLink | null {
  const link = pending;
  pending = null;
  return link;
}

/** Put a request aside for the screen that is about to mount (the app was opened by a link). */
export function setPendingTimeline(link: TimelineLink | null): void {
  pending = link;
}

const RANGES = ['hour', 'today', '24h', '7d'];

/** Read the Timeline link from a query string, or null when it holds none. */
export function parseTimelineLink(search: string): TimelineLink | null {
  const params = new URLSearchParams(search);
  if (params.get('aiteam') === 'flow') {
    return {
      flow: {
        story: params.get('story') || null,
        ticket: params.get('flow_ticket') || null,
        view: params.get('view') === 'timeline' ? 'timeline' : 'map',
      },
    };
  }
  if (params.get('aiteam') !== 'timeline') return null;
  const raw = params.get('tl') ?? '';
  const link: TimelineLink = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf(':');
    if (i < 1) continue;
    const key = part.slice(0, i);
    const value = part.slice(i + 1);
    if (key === 'r' && RANGES.includes(value)) link.range = value as TimelineLink['range'];
    else if (key === 'since' && !Number.isNaN(Date.parse(value))) link.since = value;
    else if (key === 'until' && !Number.isNaN(Date.parse(value))) link.until = value;
    else if (key === 's' && value) link.scope = value;
    else if (key === 'd') link.detailed = value === '1';
    else if (key === 't') link.real = value === 'real';
    else if (key === 'h') link.hidden = value.split(',').filter(Boolean);
  }
  return link;
}

/** The address that restores `link` in this project. */
export function buildTimelineLink(projectId: string, link: TimelineLink, base = window.location): string {
  const parts: string[] = [];
  if (link.range) parts.push(`r:${link.range}`);
  if (link.since) parts.push(`since:${link.since}`);
  if (link.until) parts.push(`until:${link.until}`);
  if (link.scope) parts.push(`s:${link.scope}`);
  if (link.detailed) parts.push('d:1');
  if (link.real) parts.push('t:real');
  if (link.hidden?.length) parts.push(`h:${link.hidden.join(',')}`);
  const url = new URL(`${base.origin}${base.pathname}`);
  url.searchParams.set('proj', projectId);
  url.searchParams.set('aiteam', 'timeline');
  url.searchParams.set('tl', parts.join(';'));
  return url.toString();
}

/** The address that opens Flow on this scope and view (`?proj=…&aiteam=flow&story=KAN-301&view=timeline`). */
export function buildFlowLink(projectId: string, link: FlowLink, base: { href: string } = window.location): string {
  const url = new URL(base.href);
  for (const k of [...FLOW_PARAMS, 'tl']) url.searchParams.delete(k);
  url.searchParams.set('proj', projectId);
  url.searchParams.set('aiteam', 'flow');
  if (link.story) url.searchParams.set('story', link.story);
  if (link.ticket) url.searchParams.set('flow_ticket', link.ticket);
  if (link.view === 'timeline') url.searchParams.set('view', 'timeline');
  return url.toString();
}

/** Keep the address in step with Flow (null: Flow is closed, take its names off). */
export function syncFlowAddress(projectId: string, link: FlowLink | null): void {
  try {
    const next = link
      ? buildFlowLink(projectId, link)
      : (() => {
          const url = new URL(window.location.href);
          if (url.searchParams.get('aiteam') !== 'flow') return url.toString();
          for (const k of FLOW_PARAMS) url.searchParams.delete(k);
          return url.toString();
        })();
    if (next !== window.location.href) window.history.replaceState(window.history.state, '', next);
  } catch {
    /* an address that cannot be written (a sandboxed frame): the link button still works */
  }
}
