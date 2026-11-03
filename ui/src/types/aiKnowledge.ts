/** Project knowledge (GET /projects/{id}/ai/knowledge): instructions for every AI and the lessons they learned. */
export type LessonState = 'proposed' | 'kept';

export interface Lesson {
  id: string;
  text: string;
  state: LessonState;
  tokens: number;
  sourceTicketId: string | null;
  sourceRunId: string | null;
  /** 'model' (a light model read the run), 'diagnosis', or a person's name. */
  proposedBy: string | null;
  keptBy: string | null;
  uses: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InstructionsVersion {
  at: string;
  by: string | null;
  text: string;
}

/** Where a note lives (issue #274): a role's memory, a member's (no role), or a ticket's. */
export type NoteScope = 'role' | 'member' | 'ticket';

/** A note an AI keeps across runs; live at once, editable by a person. */
export interface MemoryNote {
  id: string;
  scope: NoteScope;
  scopeKey: string;
  /** The role's name, the member's name, or "KEY · title". */
  scopeLabel: string | null;
  text: string;
  /** 'feedback': a person told the AI. */
  kind: 'learned' | 'feedback';
  tokens: number;
  writtenBy: string | null;
  sourceRunId: string | null;
  sourceTicketId: string | null;
  uses: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Why a lesson or a note should be looked at again (hygiene). */
export interface MemoryFlag {
  /** The lesson or note it is about. */
  id: string;
  kind: 'missing_path' | 'newer';
  text: string;
  otherId?: string;
  paths?: string[];
}

export interface Knowledge {
  projectId: string;
  instructions: string;
  instructionsTokens: number;
  updatedAt: string | null;
  updatedBy: string | null;
  history: InstructionsVersion[];
  lessons: Lesson[];
  lessonsTokens: number;
  lessonCap: number;
  totalTokens: number;
  budget: number;
  unused: string[];
  /** Lessons proposed and waiting for a person. */
  proposals: number;
  notes: MemoryNote[];
  noteCaps: Record<NoteScope, number>;
  flags: MemoryFlag[];
}
