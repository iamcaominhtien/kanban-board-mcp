/**
 * A piece of text in an editor that AI helped with: what is selected (or the paragraph at the cursor), the text
 * around it, where it is on screen, and how to put an answer back as one undoable step.
 */
export interface EditorCapture {
  /** The selected text, or the paragraph the cursor is in or just below when nothing is selected ("" when none). */
  selection: string;
  /** Text above the selection or cursor, and below it (windows, not the whole text). */
  before: string;
  after: string;
  /** Where the selection (or cursor) is now, in viewport coordinates (it moves when the page scrolls); null if unknown. */
  where: () => DOMRect | null;
  /** The selection as it is now, or null when it changed or is gone (the "text changed while drafting" state). */
  current: () => string | null;
  /**
   * Put text in. `replace` swaps the selection; `insert` adds it after the selection (or at the cursor), on a new
   * block when `block` is set. One undoable step (Ctrl+Z takes it back). False when it could not be done.
   */
  apply: (text: string, how: { kind: 'replace' | 'insert'; block?: boolean }) => boolean;
}

/** How a kind of editor tells the AI layer about its text. See `adapters.ts` for the three that exist. */
export interface EditorAdapter {
  /** The element the layer sits by; it gets `data-ai-editor` so Ctrl+J belongs to the editor while it has focus. */
  root: () => HTMLElement | null;
  /** The current selection (or, with `paragraph`, the paragraph at the cursor when nothing is selected). */
  capture: (mode: 'selection' | 'paragraph') => EditorCapture | null;
  /** "/ai" typed just before the cursor: where it is and how to remove it. Null when it is not there. */
  slash?: () => { rect: DOMRect | null; remove: () => void } | null;
}
