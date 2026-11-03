import type { ReviewDepth, ViewStep, WorkflowStep } from '../../../types/aiWorkflow';

/** Chip colours and two-letter glyphs of the roles (design/source/AiTeamProcess.dc.html, F). */
const ROLE_LOOK: Record<string, { glyph: string; bg: string; fg: string; border: string }> = {
  triage: { glyph: 'TR', bg: '#F1F3F1', fg: '#4A5A50', border: '#C7D2CB' },
  pm: { glyph: 'PM', bg: '#E8F1FA', fg: '#244E78', border: '#2F6FB0' },
  ba: { glyph: 'BA', bg: '#DFF3F3', fg: '#0B5F61', border: '#0F8B8D' },
  designer: { glyph: 'DS', bg: '#FCE8F1', fg: '#8A2655', border: '#B0446E' },
  dev: { glyph: 'DV', bg: '#E6F2EA', fg: '#1F5A31', border: '#2E6F40' },
  qa: { glyph: 'QA', bg: '#FEF3D9', fg: '#7A5A06', border: '#B4791E' },
  user_tester: { glyph: 'UT', bg: '#EFE8FB', fg: '#5B3AA6', border: '#6D5DD3' },
  reviewer: { glyph: 'RV', bg: '#E9EAF7', fg: '#3F4390', border: '#6A6FD0' },
  // the four roles of issue #273
  tech_writer: { glyph: 'TW', bg: '#F3EEE6', fg: '#6B4A1F', border: '#A87B3D' },
  devops: { glyph: 'DO', bg: '#E7EEF3', fg: '#2C4A5E', border: '#4F7A96' },
  security: { glyph: 'SR', bg: '#FBEAEA', fg: '#8E2A2A', border: '#C24B4B' },
  data_analyst: { glyph: 'DA', bg: '#EAF4EE', fg: '#2D5B46', border: '#4C8C6E' },
};
const PLAIN = { bg: '#F1F3F1', fg: '#4A5A50', border: '#C7D2CB' };

/** The look of a role chip. */
export function roleLook(role: string | null) {
  if (role && ROLE_LOOK[role]) return ROLE_LOOK[role];
  return {
    glyph:
      (role ?? '??')
        .replace(/[^a-z0-9]/gi, '')
        .slice(0, 2)
        .toUpperCase() || '??',
    ...PLAIN,
  };
}

/** The two-letter code of a ready-made role ("reviewer" → "RV"), or null for any other role (AT-4). */
export function roleCode(role: string | null | undefined): string | null {
  return (role && ROLE_LOOK[role]?.glyph) || null;
}

/** Capitalise the first letter. */
export const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** The ready-made roles' names, as the packs write them (never "Ba", "Qa": design ai-team-process E, F). */
const ROLE_NAMES: Record<string, string> = {
  triage: 'Triage',
  pm: 'PM',
  ba: 'BA',
  designer: 'Designer',
  dev: 'Dev',
  qa: 'QA',
  user_tester: 'User tester',
  reviewer: 'Reviewer',
};

/** A role's display name: the pack's own name when known, else the ready-made name, else its key in words. */
export function roleName(role: string | null, names?: Record<string, string>): string {
  if (!role) return '';
  return names?.[role] ?? ROLE_NAMES[role] ?? cap(role.replace(/_/g, ' '));
}

export const DEPTHS: ReviewDepth[] = ['light', 'standard', 'deep'];
export const DEPTH_MODEL: Record<ReviewDepth, string> = { light: 'Haiku', standard: 'Sonnet', deep: 'Opus · high' };
export const DEPTH_READS: Record<ReviewDepth, string> = {
  light: 'The diff and the acceptance criteria. Nothing else.',
  standard: 'The diff, the criteria, the files the diff touches, and the hand-over note.',
  deep: 'All of the above, plus whoever calls the changed code, and it may run the tests itself.',
};

/** "Fix (Dev)", "Review (Light)", "Checks", "Done": a step as the chain of a template draws it. */
export function stepChainLabel(s: WorkflowStep, names?: Record<string, string>): string {
  if (s.kind !== 'ai') return s.label;
  if (s.role === 'reviewer' && s.depth) return `${s.label} (${cap(s.depth)})`;
  if (s.role === 'triage') return s.label;
  // "Dev (TDD)" inside the brackets reads "Build (Dev, TDD)", never "Build (Dev (TDD))"
  const r = roleName(s.role, names).replace(/\s*\(([^)]*)\)\s*$/, ', $1');
  return r && r.toLowerCase() !== s.label.toLowerCase() ? `${s.label} (${r})` : s.label;
}

/** "9 steps · you twice". */
export function stepsSummary(steps: WorkflowStep[]): string {
  const people = steps.filter((s) => s.kind === 'person').length;
  const you =
    people === 0 ? 'no stop for you' : people === 1 ? 'you once' : people === 2 ? 'you twice' : `you ${people} times`;
  return `${steps.length} step${steps.length === 1 ? '' : 's'} · ${you}`;
}

/** 2.1666 hours as "2 h 10". */
export function hoursLabel(h: number | null | undefined): string {
  if (h == null) return '–';
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  const whole = Math.floor(h);
  const min = Math.round((h - whole) * 60);
  return min === 60 ? `${whole + 1} h 00` : `${whole} h ${String(min).padStart(2, '0')}`;
}

/** 0.92 as "92%". */
export const percent = (v: number | null | undefined) => (v == null ? '–' : `${Math.round(v * 100)}%`);

/** The state word of a step in the strip, and its tone. */
export function stepStateLabel(
  s: ViewStep,
  last: boolean,
): { text: string; tone: 'done' | 'active' | 'pending' | 'you' | 'bad' } {
  const person = s.kind === 'person';
  switch (s.state) {
    case 'done':
      // a Dev step with no test-first evidence is not plain done (design I)
      if (s.outcome === 'unproven') return { text: 'not proven', tone: 'bad' };
      if (s.outcome === 'accepted') return { text: 'accepted without proof', tone: 'done' };
      return { text: 'done', tone: 'done' };
    case 'active':
      return { text: 'working', tone: 'active' };
    case 'waiting':
      return person || last ? { text: 'waiting for you', tone: 'you' } : { text: 'waiting', tone: 'pending' };
    case 'blocked':
      return { text: 'blocked', tone: 'bad' };
    case 'failed':
      return { text: 'failed', tone: 'bad' };
    case 'skipped':
      return { text: 'skipped', tone: 'pending' };
    default:
      return { text: person ? 'waiting for you' : 'waiting', tone: person ? 'you' : 'pending' };
  }
}

export const STATE_CLASS: Record<ReturnType<typeof stepStateLabel>['tone'], string> = {
  done: 'wf-s-done',
  active: 'wf-s-active',
  pending: 'wf-s-pending',
  you: 'wf-s-you',
  bad: 'wf-s-bad',
};

export const STOP_TEXT: Record<string, { title: string; chip: string; goes: string; tone: 'violet' | 'red' }> = {
  no_progress: {
    title: 'No progress',
    chip: 'Sent to the coordinator',
    goes: 'The same two roles have swapped it three times and the diff barely moved, or the reviewer repeated an objection it already made.',
    tone: 'violet',
  },
  board_fault: {
    title: 'Board fault',
    chip: 'Straight to you',
    goes: 'The board itself failed, not the work. It is a row in Needs you.',
    tone: 'red',
  },
  quota_cap: {
    title: 'Quota cap for this ticket',
    chip: 'Straight to you',
    goes: 'The cap you turned on for this ticket was reached. It is a row in Needs you.',
    tone: 'red',
  },
  split: {
    title: 'Split into pieces',
    chip: 'Waiting for the pieces',
    goes: 'The PM split it into smaller tickets. This one is done when they all are.',
    tone: 'violet',
  },
};

/** Why a step could not start (the `step_blocked` flag's `why`), and what the board does about it. */
export const BLOCK_TEXT: Record<string, { title: string; goes: string }> = {
  run: {
    title: 'Its run was refused.',
    goes: 'The board tries again by itself; skip the step to go on without it.',
  },
  no_folder: {
    title: 'The Checks have no folder to run in.',
    goes: 'The ticket has no worktree and no AI that worked on it has a working folder. The board tries again by itself once there is one.',
  },
  failed: {
    title: 'The PM could not get this step through and passed it to you.',
    goes: 'Send it back, skip it or take it over; the board does nothing more by itself.',
  },
};

/** The sum of the round counts (the keys are pairs of roles, which the client camel-cases). */
export function totalRounds(rounds: Record<string, number> | null | undefined): number {
  return Object.values(rounds ?? {}).reduce((a, b) => a + (Number(b) || 0), 0);
}
