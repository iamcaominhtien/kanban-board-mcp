/** What the Evidence block reads from a ticket's workflow, test-first proof, runs and test cases (ai-story-flow N). */
import type { AiRun } from '../../../types/ai';
import type { TestCase } from '../../../types';
import type { StepAccepted, TddEvidence, ViewStep, WorkflowView } from '../../../types/aiWorkflow';
import { hasProof, isUnprovable } from '../../../utils/proofRules';

/** The roles whose step hands in proof of testing (server: EVIDENCE_ROLES). */
export const EVIDENCE_ROLES = ['qa', 'user_tester'];

/** The state of the gate, one per row of the table in N. */
export type GateState = 'complete' | 'missing' | 'tdd_unproven' | 'accepted' | 'tdd_off' | 'open';

/** The last step of a role in the strip (a step sent back is replaced by its next attempt). */
export function lastStepOf(view: WorkflowView, roles: string[]): ViewStep | undefined {
  return [...view.steps].reverse().find((s) => !!s.role && roles.includes(s.role));
}

/** Who took a step without its evidence, when and why: `result.accepted`, else read from the step note. */
export function acceptedOf(step: ViewStep | undefined): StepAccepted | null {
  if (!step || step.outcome !== 'accepted') return null;
  if (step.result?.accepted) return step.result.accepted;
  const m = /Accepted without (?:test-first )?evidence by ([^:\n.]+)(?::\s*(.+))?/.exec(step.note ?? '');
  if (!m) return { by: '', at: step.endedAt ?? '', reason: null };
  return { by: m[1].trim(), at: step.endedAt ?? '', reason: m[2]?.trim() || null };
}

/** The name a person who acted is shown with: the board's own user is "You". */
export function actorName(by: string): string {
  return !by || by === 'user' ? 'You' : by;
}

/** "MT" for Minh Tran, "You" for the board user. */
export function actorInitials(by: string): string {
  const name = actorName(by);
  if (name === 'You') return 'You';
  const parts = name.trim().split(/\s+/);
  return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : name.slice(0, 2)).toUpperCase();
}

/** What a test case's proof is made of: its first picture, its first command output, a link. */
export interface CaseProof {
  tc: TestCase;
  image: string | null;
  log: string | null;
  link: string | null;
  unprovable: boolean;
}

const IMAGE = /!\[[^\]]*\]\(([^)\s]+)[^)]*\)/;
const FENCE = /```[^\n]*\n([\s\S]*?)```/;
const LINK = /\bhttps?:\/\/[^\s)]+/;

/** Read a test case's Markdown proof into a picture, a log and a link. */
export function proofOf(tc: TestCase): CaseProof {
  const text = tc.proof ?? '';
  const image = IMAGE.exec(text)?.[1] ?? null;
  const log = FENCE.exec(text)?.[1]?.trim() || null;
  const link = image ? null : (LINK.exec(text)?.[0] ?? null);
  return { tc, image, log, link, unprovable: isUnprovable(tc) };
}

/** The Tester's side of the evidence: the results given, their proofs, and the counts the gate shows. */
export function testerProof(cases: TestCase[] | undefined) {
  const given = (cases ?? []).filter((t) => t.status === 'pass' || t.status === 'fail');
  const proofs = given.map(proofOf);
  const trusted = proofs.filter((p) => p.unprovable);
  const missing = given.filter((t) => !hasProof(t));
  const shown = given.length - missing.length - trusted.length;
  return {
    given,
    proofs,
    pictures: proofs.filter((p) => p.image),
    logs: proofs.filter((p) => p.log),
    trusted,
    missing,
    shown,
  };
}

/** The run behind a step, else the latest work run of its member. */
export function runOfStep(step: ViewStep | undefined, runs: AiRun[]): AiRun | undefined {
  if (!step) return undefined;
  return (
    (step.runId ? runs.find((r) => r.id === step.runId) : undefined) ??
    runs.find((r) => r.mode === 'work' && !!step.memberId && r.memberId === step.memberId)
  );
}

/** The state of the gate from the steps: N's table, top to bottom. */
export function gateState(view: WorkflowView, tdd: TddEvidence | undefined, tddRequired: boolean): GateState {
  const dev = lastStepOf(view, ['dev']);
  const tester = lastStepOf(view, EVIDENCE_ROLES);
  if (tester?.outcome === 'no_evidence') return 'missing';
  if (dev?.outcome === 'unproven') return 'tdd_unproven';
  if (dev?.outcome === 'accepted' || tester?.outcome === 'accepted') return 'accepted';
  if (dev && !tdd?.proven && !tddRequired) return 'tdd_off';
  const reviewer = lastStepOf(view, ['reviewer']);
  const testerOk = !tester || tester.state === 'done' || tester.state === 'skipped';
  const reviewOk = !reviewer || (reviewer.state === 'done' && reviewer.outcome === 'pass');
  if (tdd?.proven && testerOk && reviewOk) return 'complete';
  return 'open';
}

/** Whether, in this state, the board may move the ticket to Done by itself (the last column of N's table). */
export const BOARD_MAY_MOVE: Record<GateState, boolean> = {
  complete: true,
  missing: false,
  tdd_unproven: false,
  accepted: true,
  tdd_off: true,
  open: false,
};
