import { COL, headBoxW, laneXAt, lanesWidth } from './timelineDraw';
import { textWidth } from './timelinePlace';
import type { TimelineLifeline } from '../../types/aiTeam';

/** The height of the row of team headers over the lifeline boxes. */
export const GROUP_H = 26;

interface Group {
  teamId: string;
  name: string;
  color: string;
  from: number;
  to: number;
  /** Roles the team called (drawn or folded away). */
  roles: number;
}

/** The teams in the lifelines drawn, each with the lanes it covers (the server lists a lead, then its roles). */
function groupsOf(lifelines: TimelineLifeline[], all: TimelineLifeline[]): Group[] {
  const out: Group[] = [];
  lifelines.forEach((l, i) => {
    if (!l.teamId) return;
    const last = out[out.length - 1];
    if (last && last.teamId === l.teamId) {
      last.to = i;
      return;
    }
    const lead = all.find((x) => x.teamId === l.teamId && x.lead) ?? l;
    out.push({
      teamId: l.teamId,
      name: lead.teamName ?? lead.name,
      color: lead.color ?? '#5B6B60',
      from: i,
      to: i,
      roles: all.filter((x) => x.teamId === l.teamId && !x.lead).length,
    });
  });
  return out;
}

/** `text` cut with an ellipsis to fit `room` px. */
function cutTo(text: string, room: number, textW: (t: string) => number): string {
  let n = text.length;
  while (n > 3 && textW(`${text.slice(0, n)} …`) > room) n--;
  return `${text.slice(0, n)} …`;
}

/**
 * Flow › Timeline: a header per team over its lead and roles (a band in the team's colour). A click folds the roles
 * away under the lead and opens them again.
 * @param props.lifelines - The lifelines drawn now (folded roles are not among them).
 * @param props.all - Every lifeline, to know how many roles a folded team has.
 */
export function TimelineGroups({
  lifelines,
  all,
  col = COL,
  folded,
  onToggle,
}: {
  lifelines: TimelineLifeline[];
  all: TimelineLifeline[];
  col?: number;
  folded: ReadonlySet<string>;
  onToggle: (teamId: string) => void;
}) {
  const groups = groupsOf(lifelines, all);
  if (!groups.length) return null;
  const w = lanesWidth(lifelines.length, col);
  const half = headBoxW(col) / 2;
  return (
    <svg width={w} height={GROUP_H} role="presentation" style={{ display: 'block' }} className="tl-svg">
      {groups.map((g, gi) => {
        const x0 = laneXAt(g.from, col) - half;
        const isFolded = folded.has(g.teamId);
        const roleWord = g.roles ? ` · ${g.roles} role${g.roles === 1 ? '' : 's'}${isFolded ? ' folded' : ''}` : '';
        const textW = (t: string) => textWidth(t, 11, 700);
        const full = `${g.name}${roleWord}`;
        // the band covers its lanes; a folded team has only its lead left, so the band reaches over the empty lanes of
        // its roles, as far as the words need and the next team's band allows (design AiTimeline C, 2 and 5)
        const lead = laneXAt(g.to, col) + half;
        const next = groups[gi + 1] ? laneXAt(groups[gi + 1].from, col) - half - 6 : w - 2;
        const x1 = isFolded
          ? Math.min(Math.max(lead, x0 + (g.roles ? 22 : 10) + textW(full) + 14), Math.max(next, lead))
          : lead;
        const room = Math.max(x1 - x0 - (g.roles ? 22 : 10) - 8, 20);
        // the whole words when they fit, else the team's name alone, cut with an ellipsis if even that is too long
        const fits = (t: string) => textW(t) <= room;
        const shown = fits(full) ? full : fits(g.name) ? g.name : cutTo(g.name, room, textW);
        return (
          <g
            key={g.teamId}
            role="button"
            tabIndex={0}
            aria-expanded={!isFolded}
            aria-label={`${g.name}: ${isFolded ? 'show' : 'fold'} the roles`}
            data-testid={`tl-group-${g.teamId}`}
            style={{ cursor: g.roles ? 'pointer' : 'default' }}
            onClick={() => g.roles && onToggle(g.teamId)}
            onKeyDown={(e) => {
              if ((e.key === 'Enter' || e.key === ' ') && g.roles) {
                e.preventDefault();
                onToggle(g.teamId);
              }
            }}
          >
            <title>{g.roles ? `${g.name}: ${isFolded ? 'show' : 'fold'} its roles` : g.name}</title>
            <rect
              x={x0}
              y={3}
              width={x1 - x0}
              height={GROUP_H - 6}
              rx={7}
              fill={`${g.color}1F`}
              stroke={g.color}
              strokeWidth={1.2}
            />
            {g.roles > 0 && (
              <path
                d={isFolded ? `M${x0 + 9} ${GROUP_H / 2 - 4}l5 4-5 4` : `M${x0 + 8} ${GROUP_H / 2 - 2}l4 5 4-5`}
                fill="none"
                stroke={g.color}
                strokeWidth={1.8}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}
            <text x={x0 + (g.roles ? 22 : 10)} y={GROUP_H / 2 + 4} fontSize={11} fontWeight={700} fill="#1E2A22">
              {shown}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
