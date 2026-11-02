import type { AiRun, RunDiagnosis } from '../../../types/ai';
import type { TroubleAction } from '../../../api/aiOps';

/** The wording of each way out, as the design has it (ai-operations C, D). */
export const TROUBLE_LABELS: Record<string, string> = {
  stop_child: 'Stop that command, keep the run',
  tell_ai: 'Tell the AI to run it in the background',
  wait: 'Wait, tell me again at 30 min',
  continue_note: 'Continue with a note',
  cancel: 'Cancel the run',
  retry: 'Try again',
  hand_to: 'Hand to another AI',
};

/** The actions the trouble endpoint takes (the others are other endpoints). */
export const TROUBLE_ENDPOINT_ACTIONS: readonly string[] = ['stop_child', 'tell_ai', 'wait', 'continue_note', 'cancel'];

/** Whether an action id is one the trouble endpoint takes. */
export function isTroubleAction(a: string): a is TroubleAction {
  return TROUBLE_ENDPOINT_ACTIONS.includes(a);
}

/** The diagnosis a card should show: one that is there and has not cleared. */
export function liveDiagnosis(run: Pick<AiRun, 'diagnosis'>): RunDiagnosis | null {
  const d = run.diagnosis;
  return d && !d.clearedAt ? d : null;
}

/** "Dev An has produced nothing for 22 minutes" when the board timed the quiet; otherwise the trigger as it is. */
export function troubleTitle(d: RunDiagnosis, memberName: string): string {
  if (d.quietS && d.quietS >= 60) {
    const min = Math.round(d.quietS / 60);
    return `${memberName} has produced nothing for ${min} minute${min === 1 ? '' : 's'}`;
  }
  return d.trigger ? `${memberName}: ${d.trigger.charAt(0).toLowerCase()}${d.trigger.slice(1)}` : memberName;
}

/** The facts under the title: the process and its CPU, when the board has them. */
export function processWords(d: RunDiagnosis): string | null {
  if (!d.process) return null;
  return `the process is ${d.process.alive ? 'alive' : 'gone'}, CPU ${Math.round(d.process.cpu)}%`;
}
