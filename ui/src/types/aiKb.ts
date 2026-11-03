export type KbKind = 'text' | 'pdf' | 'image' | 'code';
export type KbStore = 'project' | 'shared';

export interface KbDocument {
  id: string;
  title: string;
  summary: string;
  store: KbStore;
  kind: KbKind;
  tokens: number;
  /** The questions the document answers (shown as its keywords). */
  answers: string[];
}

export interface KbList {
  stores: KbStore[];
  documents: KbDocument[];
  /** The shared store, whether or not this project searches it (the Shared tab, WV-7). */
  sharedDocuments?: KbDocument[];
}

export interface KbDetail extends KbDocument {
  textPreview: string;
  keywords: string[];
  describedBy: 'model' | 'code';
  sourceName: string | null;
  private: boolean;
  createdBy: string | null;
  createdAt: string;
  lastReadAt: string | null;
}

export interface KbHit {
  id: string;
  title: string;
  store: KbStore;
  kind: KbKind;
  summary: string;
  /** Matches sit in [brackets]. */
  snippet: string;
  score: number;
}

export interface KbUpload {
  file?: File | null;
  text?: string;
  title: string;
  store: KbStore;
  private: boolean;
}
