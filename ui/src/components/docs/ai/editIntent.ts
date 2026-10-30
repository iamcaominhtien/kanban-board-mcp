/**
 * "Edit with AI…" and "Suggest links" open the editor with the AI menu ready. The reader and the editor are different
 * screens, so the wish travels in this small module-level note, which the editor reads once when it opens.
 */
let wanted: string | null = null;

/** Ask the editor of this page to open with the AI menu ready. */
export function requestAiOnEdit(pageId: string): void {
  wanted = pageId;
}

/** True once if the AI menu was asked for on this page. */
export function consumeAiOnEdit(pageId: string): boolean {
  if (wanted !== pageId) return false;
  wanted = null;
  return true;
}
