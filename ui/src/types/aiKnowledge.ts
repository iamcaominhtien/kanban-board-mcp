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
}
