/** Workflows on tickets (design/screens/ai-team-process.md, E–I), as the client sees them after camelCase conversion. */

export type StepKind = 'ai' | 'code' | 'person';
export type Gives = 'ticket' | 'criteria' | 'design' | 'previous_note' | 'transcript';
export type ReviewDepth = 'light' | 'standard' | 'deep';

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
export type StopReason = 'no_progress' | 'board_fault' | 'quota_cap' | 'split';
export type StepState = 'pending' | 'active' | 'waiting' | 'blocked' | 'done' | 'failed' | 'skipped';
/** `unproven`: a Dev step with no failing test run before the passing one; `accepted`: a person took it without;
 * `board`: the Done step the board moved itself (autonomy.done = after_review). */
export type StepOutcome = 'pass' | 'changes' | 'approved' | 'sent_back' | 'failed' | 'unproven' | 'accepted' | 'board';
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
  outcome: StepOutcome | null;
  result: { checks?: CheckResult[]; tdd?: unknown; noCommands?: boolean } | null;
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
