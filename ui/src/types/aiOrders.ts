/** Standing orders (GET /projects/{id}/ai/orders): a rule in words, tried before it does anything. */
export type SignalKind =
  | 'ai_hang'
  | 'ai_failing'
  | 'quota_near'
  | 'needs_queue'
  | 'arbitration_wait'
  | 'run_failed_network'
  | 'review_stale'
  | 'ci_red';

export type OrderState = 'off' | 'trial' | 'on';

export interface RuleConditions {
  minMinutes?: number;
  confident?: boolean;
  memberId?: string;
  label?: string;
}

export type RuleThen = { mode: 'diagnose' } | { mode: 'fixed'; action: string };

export interface Rule {
  /** Empty only while a person is still picking the signal in the editor. */
  when: SignalKind | '';
  if: RuleConditions;
  then: RuleThen;
  afterwards: { lesson: boolean };
  maxPerDay: number;
  maxPerTarget: number;
  onlyProject: boolean;
}

export interface OrderTemplate {
  key: string;
  name: string;
  sentence: string;
  rule: Rule;
}

export interface OrderTemplates {
  templates: OrderTemplate[];
  /** Keyed in camelCase by the client (stopChild); the action values inside rules stay snake_case. */
  actions: Record<string, { label: string; signals: SignalKind[] }>;
  signals: SignalKind[];
}

export interface Order {
  id: string;
  projectId: string;
  name: string;
  sentence: string;
  rule: Rule;
  state: OrderState;
  trialDays: number;
  trialStartedAt: string | null;
  trialFiredAt: string | null;
  canGoLive: boolean;
  fired: number;
  wouldHave: number;
  lastFiredAt: string | null;
  lastSummary: string | null;
  template: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface Firing {
  id: string;
  orderId: string;
  at: string;
  target: string | null;
  ticketId: string | null;
  trigger: { kind: string; title: string; detail: string; data?: Record<string, unknown> };
  action: { action: string; label: string };
  /** Trial: nothing was applied. */
  would: boolean;
  result: string | null;
  canUndo: boolean;
  undoneAt: string | null;
  undoneBy: string | null;
}

export interface OrderDraft {
  name: string;
  sentence: string;
  rule: Rule;
  template?: string | null;
}

export interface OrderPatch {
  state?: OrderState;
  trialDays?: number;
  rule?: Rule;
  name?: string;
}
