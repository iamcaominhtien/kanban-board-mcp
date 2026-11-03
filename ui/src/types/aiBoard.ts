/** What the Board AI may do by itself, and the AI signals (design/screens/ai-board-wave3.md, A–F). */

export type Tier = 'free' | 'undo' | 'ask';

export interface TierRow {
  op: string;
  tier: Tier;
  default: Tier;
  locked: boolean;
  /** Setting up the AI team: its tier follows the switch `managesTeam`, not a tier of its own. */
  team?: boolean;
}

export interface BoardAiView {
  acts: boolean;
  /** The Board AI sets up the AI team by itself, with an Undo (the owner's switch). */
  managesTeam: boolean;
  tiers: TierRow[];
  locked: string[];
  bulkTickets: number;
}

export interface BoardAiPatch {
  acts?: boolean;
  managesTeam?: boolean;
  tiers?: Record<string, 'free' | 'undo'>;
}

export type SignalKind = 'ai_hang' | 'ai_failing' | 'quota_near' | 'needs_queue' | 'arbitration_wait';

export interface AiSignal {
  kind: SignalKind;
  key: string;
  ticketId: string | null;
  runId?: string | null;
  memberId?: string | null;
  title: string;
  detail: string;
  data: { actions?: string[]; [k: string]: unknown };
  score: number;
  /** The label of the card's button. */
  action: string;
}
