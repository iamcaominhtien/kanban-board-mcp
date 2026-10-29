// ─── Idea Space ───────────────────────────────────────────────────────────────

export type IdeaStage = 'inbox' | 'exploring' | 'ready' | 'building' | 'parked' | 'shipped' | 'archived';
export type IdeaScope = 'project' | 'all' | 'none';
export type AssumptionImpact = 'low' | 'medium' | 'high';
export type AssumptionState = 'untested' | 'testing' | 'validated' | 'disproved';
export type EvidenceKind = 'comment' | 'file' | 'link' | 'ticket' | 'sketch' | 'diagram' | 'note';
export type ArchiveReason = 'already_exists' | 'too_big' | 'not_now' | 'wrong_direction' | 'other';
export type LogKind = 'note' | 'research' | 'interview' | 'experiment' | 'finding' | 'decision';
export type ReadinessState = 'not_started' | 'growing' | 'ready' | 'at_risk';
export type IdeaSource = 'manual' | 'selection' | 'doc' | 'comment' | 'ticket' | 'picture' | 'ai' | 'import';

export const IDEA_STAGES: IdeaStage[] = ['inbox', 'exploring', 'ready', 'building', 'parked', 'shipped', 'archived'];

export interface IdeaEvidence {
  id: string;
  kind: EvidenceKind;
  title: string;
  ref: string;
  createdBy?: string | null;
  createdAt: string;
}

export interface IdeaAssumption {
  id: string;
  text: string;
  /** What the old board understood: untested | validated | invalidated. */
  status: string;
  state: AssumptionState;
  impact: AssumptionImpact;
  testTicketId?: string | null;
  evidence: IdeaEvidence[];
  at: string;
}

export interface IdeaReadiness {
  state: ReadinessState;
  total: number;
  validated: number;
  testing: number;
  untested: number;
  disproved: number;
  highOpen: number;
  highDisproved: number;
  nextId: string | null;
}

export interface IdeaSourceRef {
  kind?: string;
  id?: string;
  label?: string;
  quote?: string;
  url?: string;
  by?: string;
  why?: string;
}

export interface IdeaActivityEntry {
  id: string;
  label: string;
  at: string;
  author?: string | null;
  kind?: string;
  ai?: boolean;
  meta?: Record<string, unknown>;
}

export interface IdeaTicketLink {
  id: string;
  title: string;
  status: string;
  projectId: string;
  assignee?: string | null;
}

export interface Idea {
  id: string;
  projectId: string | null;
  title: string;
  description: string;
  stage: IdeaStage;
  parkUntil: string | null;
  archiveReason: ArchiveReason | null;
  parkNote: string | null;
  archiveNote: string | null;
  source: IdeaSource;
  sourceRef: IdeaSourceRef;
  body: string;
  details: string;
  tags: string[];
  votes: number;
  voters: string[];
  createdBy: string | null;
  owner: string | null;
  stageChangedAt: string | null;
  mergedIntoId: string | null;
  mergedAt: string | null;
  shippedAt: string | null;
  outcome: 'worked' | 'partly' | 'no' | null;
  outcomeNote: string | null;
  effortGuess: string | null;
  workspaceRetention: 'open_then_30' | '30_days' | 'forever';
  formerTicketId: string | null;
  commentCount: number;
  logCount: number;
  evidenceCount: number;
  readiness: IdeaReadiness;
  assumptions: IdeaAssumption[];
  problemStatement: string | null;
  activityTrail: IdeaActivityEntry[];
  promotedToTicketId: string | null;
  promotedAt: string | null;
  ticket: IdeaTicketLink | null;
  createdAt: string;
  updatedAt: string;
}

/** A row of the Idea Space list: the idea with what the row warns about. */
export interface IdeaRow extends Idea {
  /** stale:<days>, waiting:<days> or at_risk */
  warnings: string[];
}

export interface IdeaBucketCounts {
  stages: Record<IdeaStage, number>;
  active: number;
  total: number;
}

export interface IdeaCounts {
  all: IdeaBucketCounts;
  none: IdeaBucketCounts;
  projects: (IdeaBucketCounts & { projectId: string })[];
  totalInbox: number;
}

export interface IdeaComment {
  id: string;
  ideaId: string;
  author: string | null;
  body: string;
  ai: boolean;
  runId: string | null;
  createdAt: string;
  editedAt: string | null;
}

export interface IdeaLogEntry {
  id: string;
  ideaId: string;
  kind: LogKind;
  body: string;
  author: string | null;
  ai: boolean;
  pinned: boolean;
  assumptionId: string | null;
  attachments: { name: string; url: string }[];
  ticketId: string | null;
  createdAt: string;
}

export interface IdeaEvidenceItem {
  kind: EvidenceKind;
  ref: string;
  title: string;
  createdBy?: string | null;
  createdAt: string;
  ids: string[];
  assumptions: { id: string; text: string }[];
}

export interface IdeaActivity {
  items: IdeaActivityEntry[];
  counts: Record<string, number>;
}

export interface SimilarItem {
  kind: 'idea' | 'ticket' | 'doc';
  id: string;
  title: string;
  score: number;
  stage?: IdeaStage;
  status?: string;
  projectId?: string | null;
  votes?: number;
}

export interface PromotePreview {
  canPromote: boolean;
  blockers: string[];
  alreadyPromotedTicket: { id: string; status: string } | null;
  notReady: IdeaReadiness | null;
  readiness: IdeaReadiness;
  projectId: string | null;
  draft: {
    title: string;
    type: string;
    priority: string;
    status: string;
    description: string;
    checklist: { assumptionId: string; text: string; testTicketId: string | null; status: string }[];
    confirmed: string[];
    attachments: IdeaEvidenceItem[];
    demand: string | null;
    splitSuggestion: string[];
  };
  carried: {
    openAssumptions: number;
    validatedAssumptions: number;
    disprovedAssumptions: number;
    evidence: number;
    votes: number;
    logEntries: number;
  };
}

/** What a ticket page shows about the idea it started as, and the assumption it tests. */
export interface IdeaForTicket {
  fromIdea: {
    id: string;
    title: string;
    stage: IdeaStage;
    demand: string | null;
    assumptionsTotal: number;
    assumptionsChecked: number;
    confirmed: string[];
    logCount: number;
    outcome: string | null;
    open: { id: string; text: string; testTicketId: string | null }[];
  } | null;
  tests: {
    ideaId: string;
    assumptionId: string;
    text: string;
    status: AssumptionState;
    impact: AssumptionImpact;
  } | null;
}

export const STAGE_LABELS: Record<IdeaStage, string> = {
  inbox: 'Inbox',
  exploring: 'Exploring',
  ready: 'Ready',
  building: 'Building',
  parked: 'Parked',
  shipped: 'Shipped',
  archived: 'Archived',
};

export const READINESS_LABELS: Record<ReadinessState, string> = {
  not_started: 'Not started',
  growing: 'Growing',
  ready: 'Ready',
  at_risk: 'At risk',
};

export const ARCHIVE_REASON_LABELS: Record<ArchiveReason, string> = {
  already_exists: 'Already exists',
  too_big: 'Too big',
  not_now: 'Not now',
  wrong_direction: 'Wrong direction',
  other: 'Other',
};

export const LOG_KIND_LABELS: Record<LogKind, string> = {
  note: 'Note',
  research: 'Research',
  interview: 'Interview',
  experiment: 'Experiment',
  finding: 'Finding',
  decision: 'Decision',
};
