import type {
  CheckName,
  CommandName,
  CommandTexts,
  EnvFolder,
  HandoverKind,
  Scan,
  Suggestion,
  SuggestedMember,
  WorkflowKey,
} from '../../../types/aiPacks';
import { CHECKS, COMMANDS, isBad, jobOf, proposalOf, rowKind, type RowKind } from './scanParts';

/** The person's choice for one check: on or off, valid while the command and its status stay as they were. */
export interface CheckChoice {
  on: boolean;
  key: string;
}

/** Everything the person can change before Create; it lives in the wizard so the steps keep it. */
export interface Draft {
  test: string;
  lint: string;
  build: string;
  prepare: string;
  basePort: string;
  workflow: WorkflowKey;
  handover: HandoverKind;
  worktrees: boolean;
  team: SuggestedMember[];
  plugins: string[];
  /** The extra PATH folders the commands run with. */
  env: EnvFolder[];
  /** Explicit "use as a check" choices; without one, a failing or wrong command is not a check yet. */
  checks: Partial<Record<CheckName, CheckChoice>>;
  /** The finished AI job whose proposal the boxes already took. */
  syncedJob: string;
}

/** The team half of the suggestion; the four commands start empty and are set in step 3. */
export function toDraft(s: Suggestion): Draft {
  return {
    test: '',
    lint: '',
    build: '',
    prepare: '',
    basePort: s.basePort == null ? '' : String(s.basePort),
    workflow: s.workflowDefault,
    handover: s.handover,
    worktrees: s.worktrees,
    team: s.team.map((m) => ({ ...m })),
    plugins: [...s.plugins],
    env: [],
    checks: {},
    syncedJob: '',
  };
}

/** The four boxes. */
export function textsOf(d: Draft): CommandTexts {
  return { prepare: d.prepare, test: d.test, lint: d.lint, build: d.build };
}

/** Identifies a finished job, so its proposal is taken once. */
export function jobKey(scan: Scan | null): string {
  const job = jobOf(scan);
  return scan && job && job.state !== 'running' ? `${scan.id}|${job.startedAt}|${job.state}` : '';
}

/** The boxes take what a finished AI job proposed (a "try" job never changes the boxes). */
export function takeProposal(d: Draft, scan: Scan): Draft {
  const key = jobKey(scan);
  const job = jobOf(scan);
  const prop = proposalOf(scan);
  const next: Draft = { ...d, syncedJob: key };
  if (job?.mode === 'ai' && prop) {
    for (const n of COMMANDS) {
      const c = prop.commands[n]?.command;
      if (c != null) next[n] = c;
    }
    next.env = (prop.envPath ?? []).map((f) => ({ ...f }));
  }
  return next;
}

/** A draft for a scan that was left earlier (the notice in step 1): the boxes show what was last proved or proposed. */
export function draftFromScan(scan: Scan): Draft {
  const d = toDraft(scan.suggested);
  const prop = proposalOf(scan);
  for (const n of COMMANDS) d[n] = scan.trial?.[n]?.command ?? prop?.commands[n]?.command ?? '';
  d.env = (prop?.envPath ?? []).map((f) => ({ ...f }));
  d.syncedJob = jobKey(scan);
  return d;
}

/** What each row shows, from the boxes and the board's last runs. */
export function kindsOf(scan: Scan, d: Draft): Record<CommandName, RowKind> {
  const t = textsOf(d);
  return Object.fromEntries(COMMANDS.map((n) => [n, rowKind(t[n], scan.trial?.[n])])) as Record<CommandName, RowKind>;
}

const keyOf = (d: Draft, n: CommandName, kind: RowKind) => `${d[n].trim()}|${kind}`;

/** Is this command a check? Without a choice a failing or wrong command is not (the suggestion); others are. */
export function isCheckOn(d: Draft, n: CheckName, kind: RowKind): boolean {
  const c = d.checks[n];
  if (c && c.key === keyOf(d, n, kind)) return c.on;
  return !isBad(kind);
}

/** Has the person decided for this row? */
export function isDecided(d: Draft, n: CheckName, kind: RowKind): boolean {
  return d.checks[n]?.key === keyOf(d, n, kind);
}

/** Record the person's choice for a check. */
export function withChoice(d: Draft, n: CheckName, kind: RowKind, on: boolean): Draft {
  return { ...d, checks: { ...d.checks, [n]: { on, key: keyOf(d, n, kind) } } };
}

/** The commands that are saved but not run as checks. */
export function checksOffOf(scan: Scan, d: Draft): CheckName[] {
  const kinds = kindsOf(scan, d);
  return CHECKS.filter((n) => d[n].trim() && !isCheckOn(d, n, kinds[n]));
}
