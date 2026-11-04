/** The AI Team view, Now tab (GET /projects/{id}/ai/team/now; keys are camel-cased by the API client). */

import type { CardMemory } from './aiResources';

export type TeamRange = 'today' | '7d' | '30d';

export type CardState = 'working' | 'waiting' | 'queued' | 'paused' | 'offline' | 'idle';

export interface RunRef {
  runId: string;
  number: number;
  ticketId: string;
  ticketTitle: string | null;
  state: string;
  mode: 'work' | 'ask';
}

export interface TeamUsage {
  runs: number;
  ok: number;
  failed: number;
  metered: boolean;
  costUsd?: number | null;
  dailyBudget?: number | null;
  tokens?: number;
  /** Set when the runner reports the cached part apart (Claude Code). */
  tokensCached?: number;
  tokensKind?: 'new_and_cached' | 'input_per_call';
}

export interface TeamCard {
  id: string;
  name: string;
  color: string;
  glyph: string | null;
  /** The role pack the member was made from ("reviewer"), for the role code on its avatar (AT-4); null otherwise. */
  role?: string | null;
  provider: string;
  providerLabel: string;
  connection: 'local' | 'api_key' | 'inbox';
  model: string | null;
  state: CardState;
  status: { code: string; label: string; detail: string | null };
  connectionUnknown: boolean;
  paused: boolean;
  /** Why this AI is paused (set while the project is paused or the AI is paused on its own). */
  pause?: {
    project: boolean;
    own: boolean;
    ownLabel: string | null;
    cancelled: { ticketId: string; step: number; at: string | null } | null;
  } | null;
  current:
    | (RunRef & {
        step: { n: number; kind: string | null; text: string } | null;
        elapsedS: number | null;
        limitMin: number | null;
        paused: boolean;
        question: { text: string; askedAt: string | null; options: unknown[] } | null;
        /** RAM and CPU of its CLI right now (null before the first reading). */
        memory: CardMemory | null;
      })
    | null;
  queued: RunRef[];
  assigned: string[];
  last: (RunRef & { summary: string | null; endedAt: string | null; agoS: number | null; usage: TeamUsage }) | null;
  usage: TeamUsage;
  spark: number[];
}

interface ItemBase {
  since: string | null;
  waitingS: number | null;
  memberId: string;
  memberName: string | null;
  ticketId?: string | null;
  ticketTitle?: string | null;
  blocks?: string | null;
  text?: string | null;
}

export type NeedsItem =
  | (ItemBase & { kind: 'question'; runId: string; options: unknown[] })
  | (ItemBase & { kind: 'offline'; label: string; ticketsWaiting: string[] })
  | (ItemBase & { kind: 'memory_stop'; runId: string; peakRssMb: number | null; limitMb: number | null });

export interface HandoffEnd {
  id: string;
  name: string;
  color: string | null;
  kind: 'ai' | 'person';
}

export interface TeamNow {
  range: TeamRange;
  since: string;
  generatedAt: string;
  pausedAll: boolean;
  members: TeamCard[];
  counts: Partial<Record<CardState, number>>;
  needsYou: NeedsItem[];
  /** Live runs the system restarted for memory: a dot on the tab until they end. */
  restartedRuns: number;
  totals: {
    runs: number;
    ok: number;
    failed: number;
    running: number;
    spentUsd: number;
    dailyCap: number | null;
  };
}
