// Unsaved drawings, kept in this browser (IndexedDB) every few seconds so a crash or a closed window does not
// lose work. Nothing here leaves the computer. Every call fails softly: a draft is a convenience.

const DB_NAME = 'kanban-sketch-drafts';
const STORE = 'drafts';

/** The state of an unsaved drawing, and where it belongs. */
export interface SketchDraft {
  key: string;
  ownerKind: string;
  ownerId: string;
  projectId?: string;
  sketchId?: string;
  /** Version of the saved sketch the draft started from; 0 for a new one. */
  baseVersion: number;
  title: string;
  ownerLabel?: string;
  savedAt: number;
  /** The editable source as JSON text. */
  source: string;
  /** The key the AI chat of a sketch without an id is kept under; the chat is found again when the draft is restored. */
  chatKey?: string;
}

/**
 * The key a draft is kept under: one draft per saved sketch, or per owner for a new one.
 * @param d - Where the drawing belongs.
 */
export function draftKey(d: { ownerKind: string; ownerId: string; sketchId?: string }): string {
  return d.sketchId ? `sketch:${d.sketchId}` : `new:${d.ownerKind}:${d.ownerId}`;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available'));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'key' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/**
 * Keep a draft. Returns false when it could not be stored (private window, no space left).
 * @param draft - The draft.
 */
export async function putDraft(draft: SketchDraft): Promise<boolean> {
  try {
    await run('readwrite', (s) => s.put(draft));
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a draft.
 * @param key - Its key.
 */
export async function getDraft(key: string): Promise<SketchDraft | null> {
  try {
    return (await run<SketchDraft | undefined>('readonly', (s) => s.get(key))) ?? null;
  } catch {
    return null;
  }
}

/**
 * Throw a draft away.
 * @param key - Its key.
 */
export async function deleteDraft(key: string): Promise<void> {
  try {
    await run('readwrite', (s) => s.delete(key));
  } catch {
    /* nothing to clean up */
  }
}

/** Every draft kept here, newest first. */
export async function listDrafts(): Promise<SketchDraft[]> {
  try {
    const all = await run<SketchDraft[]>('readonly', (s) => s.getAll());
    return all.sort((a, b) => b.savedAt - a.savedAt);
  } catch {
    return [];
  }
}
