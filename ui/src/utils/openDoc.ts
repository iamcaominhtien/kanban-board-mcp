/** Ask the app to open a Docs page from somewhere that has no navigation of its own (the Approvals list). */
export const OPEN_DOC_EVENT = 'kanban:open-doc';

/** Open a Docs page (the Docs view is shown, the AI page closed). */
export function requestOpenDoc(pageId: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_DOC_EVENT, { detail: { pageId } }));
}
