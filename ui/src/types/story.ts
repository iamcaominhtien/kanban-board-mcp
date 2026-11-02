/**
 * A Story: a job a person hands to the PM, from the goal to Done (design/screens/ai-story-flow.md B to F). The wire
 * shape is docs/specs/ai-story-flow-implementation.md, "Story API" and "Decisions API", camel-cased by the client.
 */

export type StoryState = 'draft' | 'planning' | 'in_progress' | 'review' | 'done' | 'dropped';

/** Who approves the plan before it runs. */
export type StoryApprove = 'person' | 'pm';

export type StoryBlockedKind = 'approval' | 'question' | 'budget' | 'quota' | 'stopped' | 'plan';

export interface StoryBlocked {
  kind: StoryBlockedKind;
  text: string;
  ticketId: string | null;
}

export interface StoryCriterion {
  id: string;
  text: string;
  done: boolean;
  ticketId: string | null;
  state: 'met' | 'in_progress' | 'not_started';
}

export interface StoryPlanItem {
  order: number;
  ticketId: string;
  title: string;
  status: string;
  heldBy: { id: string; name: string; role: string } | null;
  step: string | null;
  /** Tickets this one waits for. */
  after: string[];
  /** Criteria it covers (their numbers). */
  covers: number[];
  startedAt: string | null;
  endedAt: string | null;
}

export interface StoryPlan {
  version: number;
  by: string | null;
  at: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  note: string | null;
  items: StoryPlanItem[];
  changes: { at: string; text: string }[];
}

export interface StoryView {
  id: string;
  projectId: string;
  title: string;
  goal: string;
  state: StoryState;
  blocked: StoryBlocked | null;
  planWaiting: boolean;
  approve: StoryApprove;
  paused: boolean;
  pm: { id: string; name: string; color: string } | null;
  criteria: StoryCriterion[];
  plan: StoryPlan | null;
  progress: { done: number; total: number; building: number; waiting: number };
  tokens: { used: number; budget: number };
  costUsd: number;
  interventions: { count: number; needed: number; avoidable: number; byRule: number };
  handedAt: string | null;
  startedAt: string | null;
  closedAt: string | null;
  createdAt: string;
}

export type DecisionKind =
  'approve_design' | 'send_back' | 'split' | 'retry' | 'answer' | 'permission' | 'approve_plan';

export interface Decision {
  id: string;
  at: string;
  kind: DecisionKind | string;
  title: string;
  why: string;
  ticketId: string | null;
  storyId: string | null;
  storyTitle: string | null;
  member: { id: string; name: string } | null;
  state: 'in_effect' | 'overridden';
  canOverride: boolean;
  whyNot: string | null;
  result: string;
  overriddenBy: string | null;
  overriddenAt: string | null;
  overrideNote: string | null;
}

/** GET /stories/{id}: the view plus its decisions (newest first) and its children. */
export interface StoryDetail extends StoryView {
  decisions: Decision[];
  children: string[];
}

export interface DecisionList {
  items: Decision[];
  totals: { decided: number; inEffect: number; overridable: number; overridden: number; final: number };
  kinds: { kind: string; count: number }[];
}

export interface CreateStoryBody {
  title: string;
  goal: string;
  criteria: string[];
  approve: StoryApprove;
  budgetTokens: number;
  /** false makes a Draft. */
  hand: boolean;
}
