/** What the board needs to find its way around tickets that run on a workflow (design/screens/ai-team-process.md, K and L). */
export type StepKind = 'ai' | 'code' | 'person';

/** One ticket on a workflow, from GET /projects/{pid}/ai/workflow-board. */
export interface WorkflowBoardRow {
  ticketId: string;
  templateKey: string;
  templateName: string;
  state: string;
  stopReason: string | null;
  reviewDepth: string | null;
  /** Label of the current step. */
  step: string | null;
  stepKind: StepKind | null;
  /** Role pack key, or null for a step without a role (a check by code, a person). */
  role: string | null;
  holderId: string | null;
  holderName: string | null;
  waitsForPerson: boolean;
}

/** One template's measures over a period, from GET /projects/{pid}/ai/workflow-metrics. */
export interface WorkflowMetric {
  templateKey: string;
  tickets: number;
  medianHours: number | null;
  /** 0..1, or null when nothing was reviewed. */
  passedFirst: number | null;
  roundsAvg: number | null;
  costPerTicket: number | null;
}

export interface WorkflowName {
  key: string;
  name: string;
}

/** The filters K adds to the board's filter bar. */
export interface WorkflowFilterState {
  waitingForMe: boolean;
  role: string;
  template: string;
  step: string;
}
