import type { AiRunFull, RunState } from '../../../types/ai';
import { ACTIVE_STATES } from '../../../types/ai';

/** A column of the picture: the person, the team's lead, or a role the lead called. */
export interface TimelineLane {
  key: string;
  kind: 'you' | 'lead' | 'role';
  label: string;
  /** Two letters in the lane's box. */
  code: string;
  /** Whether something is running in this lane now. */
  working: boolean;
}

export type BarState = 'live' | 'done' | 'failed' | 'queued';

/** A stretch of work in a lane: a run of the lead, or one call of a role. */
export interface TimelineBar {
  lane: string;
  start: number;
  /** null: still going (it reaches "now"). */
  end: number | null;
  label: string;
  state: BarState;
  runId: string;
}

export type ArrowKind = 'assign' | 'handoff' | 'return' | 'ask' | 'answer' | 'report';

export interface TimelineArrow {
  from: string;
  to: string;
  at: number;
  kind: ArrowKind;
}

export interface TimelineModel {
  lanes: TimelineLane[];
  bars: TimelineBar[];
  arrows: TimelineArrow[];
  /** A run of the ticket is going now. */
  active: boolean;
  /** "Dev is working on run 2" and the like; empty when no run exists. */
  banner: string;
}

export const YOU = 'you';
export const LEAD = 'lead';
const MAX_RUNS = 3;
const PERSON_TRIGGERS = ['assign', 'run_button', 'message', 'retry'];

const time = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

/** "tester" → "Tester"; "code-reviewer" → "Code reviewer". */
export function roleLabel(agentType: string): string {
  const words = (agentType || 'agent').replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Two letters for a role's box: the initials of its words, or its first two letters. */
export function roleCode(agentType: string): string {
  const words = (agentType || 'agent').split(/[-_\s]+/).filter(Boolean);
  const code = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? 'ag').slice(0, 2);
  return code.toUpperCase();
}

const stateOf = (state: RunState): BarState => {
  if (state === 'queued') return 'queued';
  if (ACTIVE_STATES.includes(state)) return 'live';
  return state === 'finished' ? 'done' : 'failed';
};

/**
 * The ticket's runs (oldest first, at most the newest three) as a sequence diagram: a lane for the person, the lead and
 * each role the lead called; a bar for each run of the lead and each call of a role; arrows for the hand-offs: the
 * person's instruction, the lead calling a role and the role coming back, a question and its answer, the final report.
 * Everything comes from the run rows and their subagents, nothing is tracked for this view.
 */
export function buildTimeline(runs: AiRunFull[], now: number): TimelineModel {
  const list = [...runs].sort((a, b) => a.number - b.number).slice(-MAX_RUNS);
  const lanes: TimelineLane[] = [];
  const bars: TimelineBar[] = [];
  const arrows: TimelineArrow[] = [];
  const calls: Record<string, number> = {};
  const lane = (key: string, make: () => TimelineLane) => {
    if (!lanes.some((l) => l.key === key)) lanes.push(make());
  };
  if (!list.length) return { lanes, bars, arrows, active: false, banner: '' };
  lane(YOU, () => ({ key: YOU, kind: 'you', label: 'You', code: '', working: false }));
  lane(LEAD, () => ({ key: LEAD, kind: 'lead', label: 'Lead', code: 'LD', working: false }));

  for (const run of list) {
    const active = ACTIVE_STATES.includes(run.state);
    const queued = time(run.queuedAt) ?? now;
    const start = time(run.startedAt) ?? queued;
    const end = time(run.endedAt) ?? (active ? null : (time(run.lastOutputAt) ?? start));
    bars.push({ lane: LEAD, start, end, label: `run ${run.number}`, state: stateOf(run.state), runId: run.id });
    if (PERSON_TRIGGERS.includes(run.trigger) || run.startedBy === 'user') {
      arrows.push({ from: YOU, to: LEAD, at: queued, kind: 'assign' });
    }
    for (const agent of [...(run.agents ?? [])].sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
      const key = `role:${agent.agentType || 'agent'}`;
      lane(key, () => ({
        key,
        kind: 'role',
        label: roleLabel(agent.agentType),
        code: roleCode(agent.agentType),
        working: false,
      }));
      const from = time(agent.startedAt) ?? start;
      const to = time(agent.endedAt) ?? (active ? null : (end ?? from));
      calls[key] = (calls[key] ?? 0) + 1;
      bars.push({
        lane: key,
        start: from,
        end: to,
        label: `call ${calls[key]}`,
        state: to === null ? 'live' : 'done',
        runId: run.id,
      });
      arrows.push({ from: LEAD, to: key, at: from, kind: 'handoff' });
      if (to !== null && agent.endedAt) arrows.push({ from: key, to: LEAD, at: to, kind: 'return' });
    }
    const asked = time(run.question?.askedAt);
    if (asked !== null) arrows.push({ from: LEAD, to: YOU, at: asked, kind: 'ask' });
    const answered = time(run.question?.answeredAt);
    if (answered !== null) arrows.push({ from: YOU, to: LEAD, at: answered, kind: 'answer' });
    if (run.state === 'finished' && end !== null) arrows.push({ from: LEAD, to: YOU, at: end, kind: 'report' });
  }
  for (const l of lanes) {
    l.working = bars.some((b) => b.lane === l.key && b.state === 'live' && b.end === null);
  }
  const last = list[list.length - 1];
  const active = ACTIVE_STATES.includes(last.state);
  return { lanes, bars, arrows, active, banner: bannerOf(last, lanes) };
}

function bannerOf(run: AiRunFull, lanes: TimelineLane[]): string {
  if (run.state === 'queued') return `Run ${run.number} is queued`;
  if (run.state === 'starting') return `Run ${run.number} is starting`;
  if (run.state === 'needs_input') return `Lead is waiting for your answer on run ${run.number}`;
  if (run.state === 'running') {
    const roles = lanes.filter((l) => l.kind === 'role' && l.working).map((l) => l.label);
    return roles.length
      ? `${roles.join(' and ')} ${roles.length > 1 ? 'are' : 'is'} working on run ${run.number}`
      : `Lead is working on run ${run.number}`;
  }
  if (run.state === 'finished') return `Run ${run.number} finished`;
  if (run.state === 'cancelled') return `Run ${run.number} was stopped`;
  return `Run ${run.number} did not finish`;
}
