/** Run history and one run's transcript (design/screens/ai-operations.md, F and G). Keys are camel-cased by the client. */

import type { RunDiagnosis, RunState } from './ai';

export interface TranscriptInfo {
  bytes: number;
  events: number;
  pinned: boolean;
  pinnedBy: string | null;
  endedAt: string | null;
  removedAt: string | null;
}

export interface HistoryRow {
  id: string;
  number: number;
  projectId: string;
  ticketId: string;
  ticketTitle: string | null;
  memberId: string;
  memberName: string | null;
  mode: 'work' | 'ask';
  trigger: string;
  state: RunState;
  model: string | null;
  queuedAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationS: number | null;
  costUsd: number | null;
  tokens: number | null;
  summary: string | null;
  endedReason: string | null;
  files: number;
  skills: string[];
  transcript: TranscriptInfo | null;
  diagnosis: RunDiagnosis | null;
  /** The matching part of the transcript, when searching. */
  snippet?: string;
}

export interface HistoryPage {
  runs: HistoryRow[];
  total: number;
}

export interface SkillUsage {
  name: string;
  kind: 'skill' | 'subagent';
  plugin: string | null;
  uses: number;
  runs: number;
  members: string[];
  last: string | null;
}

export interface TranscriptUsage {
  bytes: number;
  runs: number;
  pinned: number;
}

/** The board's own notes inside a transcript. */
export type NoteKind = 'restart' | 'diagnosis' | 'retry' | 'window' | 'stop_child' | 'sleep' | 'end' | 'moved' | string;

export type Entry =
  | {
      type: 'sent';
      at: string;
      system?: string | null;
      prompt?: string | null;
      note?: string | null;
      resume?: boolean;
      args?: string[];
    }
  | {
      type: 'init';
      at: string;
      model?: string | null;
      tools?: number;
      skills?: string[];
      plugins?: string[];
      mcpServers?: { name: string; status: string }[];
    }
  | { type: 'say'; at: string; text: string }
  | { type: 'think'; at: string; text: string }
  | {
      type: 'tool';
      at: string;
      id?: string;
      name: string;
      input?: unknown;
      output?: unknown;
      isError?: boolean;
      endedAt?: string | null;
    }
  | { type: 'message'; at: string; text: string }
  | { type: 'note'; at: string; kind: NoteKind; text: string }
  | { type: 'compact'; at: string; before?: number; after?: number }
  | {
      type: 'result';
      at: string;
      isError?: boolean;
      text?: string | null;
      costUsd?: number | null;
      turns?: number;
      apiError?: string | null;
    }
  | { type: 'quota'; at: string; status?: string; windows?: unknown }
  | { type: 'output'; at: string; text: string };

export interface TranscriptResponse {
  run: HistoryRow;
  transcript: TranscriptInfo | null;
  entries: Entry[];
  available: boolean;
}

/** The filters of the history list, as the person set them. */
export interface HistoryFilters {
  /** All | Failed | Needed you | Pinned. */
  view: 'all' | 'failed' | 'needs' | 'pinned';
  memberId: string;
  ticketId: string;
  skill: string;
  /** Days back; 0 = all time. */
  days: number;
  q: string;
}
