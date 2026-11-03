/** Workflows on tickets (design/screens/ai-team-process.md, E–I), as the client sees them after camelCase conversion. */

export type StepKind = 'ai' | 'code' | 'person';
export type Gives = 'ticket' | 'criteria' | 'design' | 'previous_note' | 'transcript';
export type ReviewDepth = 'light' | 'standard' | 'deep';
/** A ticket's pace: `fast` skips the steps a quick result can do without and runs a level lower. */
export type Pace = 'normal' | 'fast';

export interface WorkflowStep {
  key: string;
  label: string;
  kind: StepKind;
  /** A role pack key (triage, pm, ba, designer, dev, reviewer, qa, user_tester ...); null for code and person steps. */
  role: string | null;
  handsIn: string;
  gives: Gives[];
  model: string | null;
  effort: string | null;
  retryModel: string | null;
  depth: ReviewDepth | null;
  /** What fast mode does with the step, over its role's default (Triage, QA and the User tester are skipped). */
  fast?: 'skip' | 'keep' | null;
}

export interface WorkflowTemplate {
  key: string;
  name: string;
  description: string;
  version: number;
  builtin: boolean;
  steps: WorkflowStep[];
  personStops: number;
  warning: string | null;
}

export interface TemplateDraft {
  name: string;
  description: string;
  steps: Partial<WorkflowStep>[];
}

export interface WorkflowMetric {
  templateKey: string;
  tickets: number;
  medianHours: number | null;
  passedFirst: number | null;
  roundsAvg: number | null;
  costPerTicket: number | null;
}

export type WorkflowState = 'active' | 'stopped' | 'done' | 'detached';
/** `taken_back`: a person took the ticket from the AI team; it waits at its step until they give it back (#272). */
export type StopReason = 'no_progress' | 'board_fault' | 'quota_cap' | 'split' | 'taken_back';
export type StepState = 'pending' | 'active' | 'waiting' | 'blocked' | 'done' | 'failed' | 'skipped';
/** `unproven`: a Dev step with no failing test run before the passing one; `no_evidence`: a testing step that handed
 * in no proof (twice); `accepted`: a person took either without; `board`: the Done step the board moved itself
 * (autonomy.done = after_review). */
export type StepOutcome =
  | 'pass'
  | 'changes'
  | 'approved'
  | 'sent_back'
  | 'failed'
  | 'unproven'
  | 'no_evidence'
  | 'accepted'
  | 'board'
  | 'taken_back'
  /** a step fast mode skipped (the normal pace puts it back) */
  | 'fast';

/** Who took a step without its evidence, when, and why (ai-story-flow N). */
export interface StepAccepted {
  by: string;
  at: string;
  reason: string | null;
}
export type Verdict = 'reviewer' | 'dev' | 'split' | 'undecided';

export interface CheckResult {
  name: string;
  command: string;
  ok: boolean;
  tail: string;
  seconds: number;
}

export interface ViewStep {
  id: string;
  idx: number;
  key: string;
  label: string;
  kind: StepKind;
  role: string | null;
  state: StepState;
  attempt: number;
  memberId: string | null;
  memberName: string | null;
  runId: string | null;
  /** What it handed in. */
  note: string | null;
  /** What it was told: a send-back, a ruling. */
  noteIn: string | null;
  /** The handoff note its run left (issue #272): the strip shows it instead of the whole text. */
  handoff?: { done: string; where: string; left: string; check: string } | null;
  outcome: StepOutcome | null;
  result: { checks?: CheckResult[]; tdd?: unknown; noCommands?: boolean; accepted?: StepAccepted } | null;
  startedAt: string | null;
  endedAt: string | null;
}

export interface Ruling {
  at: string;
  by: string;
  verdict: Verdict;
  reason: string;
  memberId?: string | null;
  runId?: string | null;
}

export interface Objection {
  at: string;
  by: string;
  role: string;
  text: string;
}

export interface WorkflowView {
  ticketId: string;
  templateKey: string;
  templateName: string;
  templateVersion: number;
  state: WorkflowState;
  stopReason: StopReason | null;
  stopDetail: string | null;
  reviewDepth: ReviewDepth | null;
  depthBy: 'triage' | 'person' | null;
  depthNote: string | null;
  /** Fast mode on this ticket; absent from an older server. */
  pace?: Pace;
  /** The depth the review runs at (fast mode lowers it unless a person set it). */
  reviewRunsAt?: ReviewDepth;
  /** Round counts per pair of roles. The keys are camel-cased on the way in, so only the values are used. */
  rounds: Record<string, number>;
  /** The tickets a stopped-for-split workflow waits for. */
  split: string[];
  rulings: Ruling[];
  objections: Objection[];
  steps: ViewStep[];
  createdAt?: string | null;
}

export type TddEvidence =
  | {
      proven: true;
      red: { run: string; at: string; command: string; failed: number; failing: string[]; why: string };
      green: { run: string; at: string; command: string; passed: number };
      file: string;
    }
  | { proven: false; why: string; runsSeen: number };

export interface ArbitrationResult {
  side: 'reviewer' | 'dev' | 'split';
  newTicket?: { id?: string; title?: string } | string | null;
  workflow: WorkflowView;
}
