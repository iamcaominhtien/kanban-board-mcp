import { client } from './client';
import type { AiRun } from '../types/ai';

/** The ways a person can answer a run that stopped moving (design/screens/ai-operations.md, C). */
export type TroubleAction = 'stop_child' | 'tell_ai' | 'wait' | 'continue_note' | 'cancel';

/** Where a sentence sent to a running AI went: into its input, or held for its next board call. */
export type TellDelivery = 'input' | 'next_board_call';

/** Acting on an AI in trouble, on a stopped run, and on a running one (ai-operations C and D, ai-team-process J). */
export const aiOpsApi = {
  trouble: async (runId: string, action: TroubleAction, note?: string) =>
    (await client.post<{ done: boolean; text: string }>(`/ai/runs/${runId}/trouble`, { action, note })).data,
  /** A running run resumes with the note; an ended run gets a new run that resumes its conversation. */
  continueWith: async (runId: string, note: string) =>
    (await client.post<AiRun>(`/ai/runs/${runId}/continue`, { note })).data,
  handTo: async (runId: string, memberId: string, note?: string) =>
    (await client.post<AiRun>(`/ai/runs/${runId}/hand-to`, { memberId, note })).data,
  tell: async (runId: string, text: string) =>
    (await client.post<{ delivered: TellDelivery }>(`/ai/runs/${runId}/tell`, { text })).data,
  moveAccount: async (runId: string, accountId: string) =>
    (await client.post<AiRun>(`/ai/runs/${runId}/move-account`, { accountId })).data,
  conflict: async (ticketId: string, choice: 'ai' | 'me') =>
    (await client.post(`/tickets/${ticketId}/ai/conflict`, { choice })).data,
  arbitration: async (ticketId: string, side: 'reviewer' | 'dev' | 'split') =>
    (await client.post(`/tickets/${ticketId}/ai/arbitration`, { side })).data,
};

/** What a person reads after "Tell the AI": which way their sentence went. */
export function deliveredWords(d: TellDelivery): string {
  return d === 'input' ? 'Sent. The AI reads it at its next turn.' : 'Held. The AI gets it with its next board call.';
}
