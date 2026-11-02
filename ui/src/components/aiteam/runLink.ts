/**
 * Opening one run's detail from anywhere (design/screens/ai-operations.md, G: "one run: what it was given and what it
 * did"). Like the Timeline link, a request made inside the app travels as an event; AI Team › Run history shows it.
 */

export const OPEN_RUN_EVENT = 'kanban:open-run';

let pending: string | null = null;

/** Ask the app to show this run's detail (AI Team › Run history). */
export function openRun(runId: string): void {
  pending = runId;
  window.dispatchEvent(new CustomEvent(OPEN_RUN_EVENT));
}

/** The run waiting to be shown, once. */
export function takePendingRun(): string | null {
  const id = pending;
  pending = null;
  return id;
}
