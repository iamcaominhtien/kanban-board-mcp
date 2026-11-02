import type { Mark } from '../../types/aiEvals';

export const SUITE_COPY: Record<string, { name: string; checks: string; scored: string }> = {
  board: {
    name: 'Board tools',
    checks: 'Does it use the board correctly: assign, comment, write a page, hand over, ask a person.',
    scored: 'The state of the board afterwards, compared with the expected state.',
  },
  problem: {
    name: 'Fixing a bug',
    checks: 'A sample repository with planted bugs.',
    scored: 'Hidden tests pass.',
  },
  issue: {
    name: 'Handling a ticket',
    checks: 'Classify it, make a vague ticket clear, split one that is too big.',
    scored: 'Against a written answer, plus a light model as a second reader.',
  },
  spec: {
    name: 'Doing what was asked',
    checks: 'Meets the criteria, and does nothing extra.',
    scored: 'Mechanical checks on the diff, plus a light model as a second reader.',
  },
  recovery: {
    name: 'Recovering',
    checks: 'Deliberate trouble: the CLI is killed, MCP goes down, a fake rate limit.',
    scored: 'Did the run recover, or stop in the right way with the right diagnosis.',
  },
  coordination: {
    name: 'Working together',
    checks: 'A multi-step workflow with a planted disagreement.',
    scored: 'Got to the end, and in how many rounds.',
  },
  safety: {
    name: 'Safety',
    checks: 'Respects its permissions; resists an instruction planted in a ticket.',
    scored: 'Did nothing it was not allowed to do. A single failure is a failure.',
  },
};

/** Part of the team marks (wave 3). */
export const pctOf = (v: number | null | undefined) => (v == null ? '—' : `${Math.round(v * 100)}%`);

/** Part of the team marks (wave 3). */
export function scoreColor(v: number | null | undefined): string {
  if (v == null) return '#9AA8A0';
  return v >= 0.8 ? '#1F5A31' : v >= 0.5 ? '#7A5A06' : '#A5321E';
}

/** The last eight finished marks of a suite, oldest first. */
export function trendOf(marks: Mark[], suite: string): Mark[] {
  return marks
    .filter((m) => m.suite === suite && m.state === 'done' && m.score != null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-8);
}

/** Score over time; one mark is a dot, none is nothing (no invented baseline). */
export function Trend({ marks }: { marks: Mark[] }) {
  if (!marks.length) return <span className="ai-muted">no trend yet</span>;
  const w = 84;
  const h = 26;
  const pts = marks.map((m, i) => [
    marks.length === 1 ? w / 2 : 3 + (i * (w - 6)) / (marks.length - 1),
    h - 3 - (m.score as number) * (h - 6),
  ]);
  const last = marks[marks.length - 1];
  return (
    <svg width={w} height={h} role="img" aria-label={`Last ${marks.length} marks, latest ${pctOf(last.score)}`}>
      {pts.length > 1 && (
        <polyline
          points={pts.map((p) => p.join(',')).join(' ')}
          fill="none"
          stroke="#2E6F40"
          strokeWidth="1.6"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      )}
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="2.6" fill={scoreColor(last.score)} />
    </svg>
  );
}
