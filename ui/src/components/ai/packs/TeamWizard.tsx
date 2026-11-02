import { useMemo, useState, type ReactNode } from 'react';
import { useProject } from '../../../api/projects';
import { useAiWindows } from '../../../api/aiWindows';
import {
  packKeys,
  useApplyScan,
  useCatalogue,
  useLatestScan,
  usePacks,
  useScan,
  useScanPoll,
} from '../../../api/aiPacks';
import { extractError } from '../../../api/extractError';
import { useQueryClient } from '@tanstack/react-query';
import type {
  ApplyResult,
  CheckName,
  CommandName,
  HandoverKind,
  Scan,
  SuggestedMember,
  WorkflowKey,
} from '../../../types/aiPacks';
import { WORKFLOW_NAME, WORKFLOW_ROLES, lostRoles, workflowFor } from './packLabels';
import { Dialog } from './PackDialogs';
import { CommandsStep, type CmdLook } from './CommandsStep';
import { CHECKS, COMMANDS, ROW_NAME, failCounts, fmtSeconds, isBad, jobOf, type RowKind } from './scanParts';
import {
  checksOffOf,
  draftFromScan,
  isCheckOn,
  isDecided,
  jobKey,
  kindsOf,
  takeProposal,
  toDraft,
  withChoice,
  type Draft,
} from './wizardDraft';
import { Ico } from './wizardIcons';
import './packs.css';

const STEPS = ['Read the repository', 'The team', 'Commands', 'Confirm'];

const Check = () => (
  <svg
    width="11"
    height="11"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);

/**
 * The wizard as a page (design ai-team-process D): breadcrumb, title with the project chip, "Nothing is created until
 * the last step" on the right, then the steps at one fixed width. It covers the window like a page;
 * "I will do it myself" and the close button leave it.
 */
function WizardPage({
  projectId,
  onClose,
  children,
  foot,
}: {
  projectId: string;
  onClose: () => void;
  children: ReactNode;
  foot: ReactNode;
}) {
  const project = useProject(projectId);
  const name = project.data?.name ?? 'This project';
  return (
    <div className="pk-page" role="dialog" aria-modal="true" aria-label="Set up the AI team">
      <div className="pk-page-crumb">
        {name} <span>/</span> Project settings <span>/</span> AI <span>/</span> <b>Set up the AI team</b>
      </div>
      <div className="pk-page-head">
        <h1>Set up the AI team</h1>
        <span className="pk-page-chip">{name}</span>
        <span style={{ flex: 1 }} />
        <span className="ai-hint">Nothing is created until the last step</span>
        <button type="button" className="ai-icobtn" aria-label="Close" title="Close" onClick={onClose}>
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
      <div className="pk-page-body">
        <div className="pk-page-inner">{children}</div>
      </div>
      <div className="pk-page-foot">
        <div className="pk-page-inner pk-page-foot-row">{foot}</div>
      </div>
    </div>
  );
}

const HANDOVER: Record<HandoverKind, string> = {
  pr: 'Opening a pull request',
  branch: 'Pushing a branch',
  local: 'Leaving it in the worktree',
};

const WORD = ['No', 'One', 'Two', 'Three'];

/** What a left-over scan was doing, for the notice in step 1. */
function leftOver(scan: Scan): string {
  const job = jobOf(scan);
  if (job?.state === 'running')
    return job.mode === 'ai' ? 'The AI is still setting up the commands' : 'The commands are still running';
  if (job?.state === 'timeout') return 'The AI ran out of time before it had all four commands';
  return job?.mode === 'try' ? 'The commands were tried' : 'The AI finished setting up the commands';
}

/** One line of the Confirm step's COMMANDS list: icon, name, command and what the board found. */
function statusLine(
  n: CommandName,
  kind: RowKind,
  seconds: number | undefined,
  tail: string[],
  isCheck: boolean,
  checkOn: boolean,
): { icon: string; color: string; text: string } {
  const suffix = isCheck ? (checkOn ? ' · used as a check anyway' : ' · saved, not a check yet') : '';
  switch (kind) {
    case 'works':
      return { icon: 'check', color: '#2E6F40', text: `works · ${fmtSeconds(seconds ?? 0)}` };
    case 'fails': {
      const c = n === 'test' ? failCounts(tail) : null;
      const what = n === 'test' ? 'repo tests fail' : n === 'prepare' ? 'exits with an error' : `repo ${n} fails`;
      return { icon: 'warn', color: '#B8860B', text: `${what}${c ? ` (${c.failed} of ${c.total})` : ''}${suffix}` };
    }
    case 'wrong':
      return { icon: 'xcircle', color: '#C4432A', text: `command is wrong${suffix}` };
    case 'timeout':
      return { icon: 'clock', color: '#B8860B', text: 'timed out' };
    case 'untried':
      return { icon: 'dot', color: '#9AA8A0', text: 'not tried' };
    case 'changed':
      return { icon: 'edit', color: '#B8860B', text: 'changed since the last run' };
    case 'empty':
      return { icon: 'dash', color: '#9AA8A0', text: 'empty' };
    default:
      return { icon: 'dash', color: '#9AA8A0', text: 'not run' };
  }
}

/** The wizard: 1 Read the repository, 2 The team, 3 Commands, 4 Confirm. Nothing exists until Create (design D). */
export function TeamWizard({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const scanM = useScan(projectId);
  const apply = useApplyScan(projectId);
  const packs = usePacks(projectId);
  const catalogue = useCatalogue();
  const windows = useAiWindows();
  const latest = useLatestScan(projectId);
  const [step, setStep] = useState(1);
  const [folder, setFolder] = useState('');
  const [scanId, setScanId] = useState<string | null>(null);
  const scanQ = useScanPoll(scanId);
  const scan = scanQ.data ?? null;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [look, setLook] = useState<CmdLook>('choose');
  const [accountId, setAccountId] = useState('local');
  const [workflowNote, setWorkflowNote] = useState<string | null>(null);
  const [result, setResult] = useState<ApplyResult | null>(null);

  // A finished AI run puts its commands and folders in the boxes, once
  const key = jobKey(scan);
  if (draft && scan && key && draft.syncedJob !== key) setDraft(takeProposal(draft, scan));

  const packList = useMemo(() => packs.data ?? [], [packs.data]);
  const setD = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const roleName = (key: string) => packList.find((p) => p.key === key)?.name ?? key;
  const glyph = (key: string) => packList.find((p) => p.key === key)?.glyph ?? key.slice(0, 2).toUpperCase();

  const runScan = () =>
    scanM.mutate(
      { folder: folder.trim() },
      {
        onSuccess: (s) => {
          setScanId(s.id);
          setDraft(toDraft(s.suggested));
          setLook('choose');
          setStep(2);
        },
      },
    );

  // A scan left earlier: its commands come back, and step 3 shows them
  const continueScan = (s: Scan) => {
    qc.setQueryData(packKeys.scan(s.id), s);
    setScanId(s.id);
    setFolder(s.folder);
    setDraft(draftFromScan(s));
    setLook(jobOf(s) ? 'result' : 'choose');
    setStep(3);
  };
  const left = latest.data;
  const leftJob = jobOf(left);
  const resumable =
    !!left && !left.appliedAt && !!leftJob && ['running', 'done', 'timeout'].includes(leftJob.state) && !scanId;

  const changeTeam = (team: SuggestedMember[]) => {
    if (!draft) return;
    const roles = team.map((m) => m.pack);
    const next = workflowFor(roles, draft.workflow);
    setDraft({ ...draft, team, workflow: next });
    if (next !== draft.workflow) {
      const lost = lostRoles(draft.workflow, next).map(roleName);
      setWorkflowNote(
        `The default workflow is now ${WORKFLOW_NAME[next]} (was ${WORKFLOW_NAME[draft.workflow]}). The steps for ${lost.join(', ')} would go.`,
      );
    } else setWorkflowNote(null);
  };

  const create = () => {
    if (!scan || !draft) return;
    apply.mutate(
      {
        scanId: scan.id,
        body: {
          commands: {
            test: draft.test.trim() || null,
            lint: draft.lint.trim() || null,
            build: draft.build.trim() || null,
          },
          prepare: draft.prepare.trim() || null,
          basePort: draft.basePort ? Number(draft.basePort) : null,
          workflowDefault: draft.workflow,
          handover: draft.handover,
          worktrees: draft.worktrees,
          team: draft.team,
          plugins: draft.plugins,
          accountId: accountId === 'local' ? null : accountId,
          envPath: draft.env.map((e) => e.path),
          checksOff: checksOffOf(scan, draft),
        },
      },
      { onSuccess: setResult },
    );
  };

  const missingRoles = packList.filter(
    (p) => p.builtin && draft && !draft.team.some((m) => m.pack === p.key) && WORKFLOW_ROLES.feature_ui.includes(p.key),
  );

  const stepper = (
    <div className="ai-stepper" aria-label="Steps">
      {STEPS.map((s, i) => (
        <span key={s} style={{ display: 'contents' }}>
          <span
            className={`ai-step${step === i + 1 ? ' ai-step-active' : ''}${step > i + 1 ? ' ai-step-done' : ''}`}
            aria-current={step === i + 1 ? 'step' : undefined}
          >
            <span className="ai-step-n">{step > i + 1 ? <Check /> : i + 1}</span>
            {s}
          </span>
          {i < STEPS.length - 1 && <span className={`ai-step-line${step > i + 1 ? ' ai-step-line-done' : ''}`} />}
        </span>
      ))}
    </div>
  );

  if (result)
    return (
      <Dialog
        title="The team is ready"
        onClose={onClose}
        foot={
          <button className="ai-btn ai-btn-primary" onClick={onClose}>
            Done
          </button>
        }
      >
        <div data-testid="apply-result" className="pk-form">
          <div className="ai-ok-text">
            Created {result.created.length} member{result.created.length === 1 ? '' : 's'}:{' '}
            {result.created.map((c) => c.name).join(', ') || 'none'}.
          </div>
          {result.skipped.map((s) => (
            <div key={s.name} className="ai-notice ai-notice-warn">
              Skipped {s.name}: {s.why}
            </div>
          ))}
          {result.plugins.length > 0 && <div className="ai-sub">Plugins attached: {result.plugins.join(', ')}.</div>}
          {result.pluginFailures.map((f) => (
            <div key={f.plugin} className="ai-notice ai-notice-error">
              {f.plugin} could not be attached: {f.why}
            </div>
          ))}
        </div>
      </Dialog>
    );

  const d = draft;
  const kinds = scan && d ? kindsOf(scan, d) : null;
  // Test, lint and build that the board proved wrong or failing, and the person has not decided about yet
  const undecided: CheckName[] =
    scan && d && kinds ? CHECKS.filter((n) => d[n].trim() && isBad(kinds[n]) && !isDecided(d, n, kinds[n])) : [];
  const undecidedFails = undecided.filter((n) => kinds?.[n] === 'fails');
  const undecidedWrong = undecided.filter((n) => kinds?.[n] === 'wrong');
  const keepAll = (names: CheckName[]) =>
    setDraft((x) => (x && kinds ? names.reduce((acc, n) => withChoice(acc, n, kinds[n], false), x) : x));

  return (
    <WizardPage
      projectId={projectId}
      onClose={onClose}
      foot={
        <>
          {step === 1 && (
            <button className="ai-btn ai-btn-primary" disabled={!folder.trim() || scanM.isPending} onClick={runScan}>
              {scanM.isPending ? 'Reading…' : 'Read the repository'}
            </button>
          )}
          {step === 2 && (
            <button className="ai-btn ai-btn-primary" onClick={() => setStep(3)}>
              Next: commands
            </button>
          )}
          {step === 4 && (
            <button className="ai-btn ai-btn-primary" disabled={apply.isPending || !d?.team.length} onClick={create}>
              {apply.isPending ? 'Creating…' : 'Create the team'}
            </button>
          )}
          {(step === 2 || step === 4) && !scanM.isPending && (
            <button className="ai-btn" onClick={() => setStep(step - 1)}>
              Back
            </button>
          )}
          <span className="pk-grow" style={{ flex: 1 }} />
          <button className="ai-btn" onClick={onClose}>
            I will do it myself
          </button>
        </>
      }
    >
      {stepper}
      {step === 1 && (
        <div className="pk-form" data-testid="wizard-step-1">
          <div className="ai-sub">
            Nothing is created until the last step. This step reads the code only: manifests, lock files, the CI
            workflow, CLAUDE.md, the README, the test folders and the git remote. It runs no command and uses no AI
            quota. The commands are set up in step 3.
          </div>
          {resumable && left && (
            <div className="ai-notice ai-notice-info" role="status" data-testid="resume-scan">
              <div style={{ flex: 1 }}>
                <b>{leftOver(left)}</b> for <span className="ai-code">{left.folder}</span>. You can pick it up where it
                stopped instead of reading the repository again.
              </div>
              <button className="ai-btn ai-btn-sm" onClick={() => continueScan(left)}>
                Continue it
              </button>
            </div>
          )}
          <label>
            Repository folder{' '}
            <input
              className="ai-input pk-cmd"
              placeholder="/path/to/the/repository"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
            />
          </label>
          {scanM.isPending && (
            <div role="status" aria-live="polite" data-testid="scan-progress">
              <div className="pk-progress">
                <span />
              </div>
              <div className="ai-sub">Reading the files. This takes a few seconds.</div>
            </div>
          )}
          {scanM.error && (
            <span className="ai-error-text" role="alert">
              {extractError(scanM.error)}
            </span>
          )}
        </div>
      )}

      {step === 2 && scan && d && (
        <div className="pk-form pk-two" data-testid="wizard-step-2">
          {/* D, step 2: what the board read on the left, what it suggests on the right */}
          <div className="pk-box pk-two-left">
            <div className="pk-box-title">What the board read</div>
            <FoundList scan={scan} />
            <div className="ai-sub">All of it read from files. No quota spent.</div>
          </div>
          <div className="pk-form pk-two-right">
            <div className="pk-box-title">What it suggests — change anything</div>

            <div className="pk-box" data-testid="team-box">
              <div className="pk-box-title">The team</div>
              {scan.suggested.why.team && <div className="ai-sub">{scan.suggested.why.team}</div>}
              {d.team.map((m, i) => (
                <div className="pk-team-row" key={`${m.pack}-${i}`}>
                  <span className="pk-glyph" aria-hidden="true">
                    {glyph(m.pack)}
                  </span>
                  <input
                    className="ai-input"
                    aria-label={`Name of ${roleName(m.pack)}`}
                    value={m.name}
                    onChange={(e) =>
                      setD(
                        'team',
                        d.team.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
                      )
                    }
                  />
                  {m.pack === 'user_tester' && (
                    <input
                      className="ai-input"
                      aria-label="Plays"
                      placeholder="Plays: first time here"
                      value={m.plays ?? ''}
                      onChange={(e) =>
                        setD(
                          'team',
                          d.team.map((x, j) => (j === i ? { ...x, plays: e.target.value } : x)),
                        )
                      }
                    />
                  )}
                  <button
                    className="ai-btn ai-btn-sm"
                    disabled={m.pack === 'triage'}
                    title={m.pack === 'triage' ? 'Triage is always in: it puts a workflow on a new ticket' : undefined}
                    aria-label={`Remove ${m.name}`}
                    onClick={() => changeTeam(d.team.filter((_, j) => j !== i))}
                  >
                    Remove
                  </button>
                </div>
              ))}
              {missingRoles.length > 0 && (
                <select
                  className="ai-select"
                  aria-label="Add a role"
                  value=""
                  onChange={(e) => {
                    const p = packList.find((x) => x.key === e.target.value);
                    if (p) changeTeam([...d.team, { pack: p.key, name: p.name }]);
                  }}
                >
                  <option value="">Add a role…</option>
                  {missingRoles.map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.name}
                    </option>
                  ))}
                </select>
              )}
              <div className="ai-sub">
                The team always covers every role the suggested workflow needs. Removing a role changes the workflow
                too, and the screen says which steps would go.
              </div>
              {workflowNote && (
                <div className="ai-notice ai-notice-warn" role="status" data-testid="workflow-note">
                  {workflowNote}
                </div>
              )}
            </div>

            <label>
              Default workflow{' '}
              <select
                className="ai-select"
                value={d.workflow}
                onChange={(e) => {
                  const w = e.target.value as WorkflowKey;
                  const roles = d.team.map((m) => m.pack);
                  const add = WORKFLOW_ROLES[w].filter((r) => !roles.includes(r));
                  const extra = add.flatMap((r) => {
                    const p = packList.find((x) => x.key === r);
                    return p ? [{ pack: r, name: p.name }] : [];
                  });
                  setDraft({ ...d, workflow: w, team: [...d.team, ...extra] });
                  setWorkflowNote(
                    extra.length
                      ? `${extra.map((x) => x.name).join(', ')} added: ${WORKFLOW_NAME[w]} has steps for them.`
                      : null,
                  );
                }}
              >
                {(Object.keys(WORKFLOW_NAME) as WorkflowKey[]).map((w) => (
                  <option key={w} value={w}>
                    {WORKFLOW_NAME[w]}
                  </option>
                ))}
              </select>
            </label>

            <div className="pk-box">
              <div className="pk-box-title">Hand over by</div>
              {scan.suggested.why.handover && <div className="ai-sub">{scan.suggested.why.handover}</div>}
              <select
                className="ai-select"
                aria-label="Hand over by"
                value={d.handover}
                onChange={(e) => setD('handover', e.target.value as HandoverKind)}
              >
                {(Object.keys(HANDOVER) as HandoverKind[]).map((h) => (
                  <option key={h} value={h}>
                    {HANDOVER[h]}
                  </option>
                ))}
              </select>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', flexDirection: 'row' }}>
                <input type="checkbox" checked={d.worktrees} onChange={(e) => setD('worktrees', e.target.checked)} />A
                worktree for each ticket
              </label>
              <label>
                Ports: first port for worktrees{' '}
                <input
                  className="ai-input"
                  type="number"
                  value={d.basePort}
                  onChange={(e) => setD('basePort', e.target.value)}
                />
              </label>
            </div>

            <div className="pk-box" data-testid="plugins-box">
              <div className="pk-box-title">Plugins</div>
              <div className="ai-sub">Suggested for the roles chosen above.</div>
              {d.plugins.length === 0 && <div className="ai-muted">None suggested.</div>}
              {d.plugins.map((k) => {
                const entry = catalogue.data?.find((c) => c.key === k);
                return (
                  <label key={k} style={{ display: 'flex', gap: 6, alignItems: 'center', flexDirection: 'row' }}>
                    <input
                      type="checkbox"
                      checked
                      onChange={() =>
                        setD(
                          'plugins',
                          d.plugins.filter((x) => x !== k),
                        )
                      }
                    />
                    {entry?.name ?? k}
                    {entry?.what && <span className="ai-muted"> — {entry.what}</span>}
                  </label>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {step === 3 && scan && d && (
        <div data-testid="wizard-step-3" className="pk-form">
          <CommandsStep
            scan={scan}
            draft={d}
            setDraft={(f) => setDraft((x) => (x ? f(x) : x))}
            look={look}
            setLook={setLook}
            onBack={() => setStep(2)}
            onContinue={() => setStep(4)}
            onRecheck={() => void scanQ.refetch()}
          />
        </div>
      )}

      {step === 4 && d && scan && kinds && (
        <div className="pk-form" data-testid="wizard-step-4">
          <div className="ai-notice ai-notice-info">Nothing exists until you press Create.</div>
          <div className="pk-box">
            <div className="pk-box-title">The team</div>
            <div className="pk-team-row" style={{ flexWrap: 'wrap' }}>
              {d.team.map((m, i) => (
                <span key={i} className="ai-chip" style={{ background: '#dceee1', color: '#2e6f40' }}>
                  {glyph(m.pack)} {m.name}
                  {m.plays ? ` · ${m.plays}` : ''}
                </span>
              ))}
            </div>
            <div className="ai-sub">
              Default workflow: {WORKFLOW_NAME[d.workflow]} · hand over by {HANDOVER[d.handover].toLowerCase()}
              {d.plugins.length ? ` · plugins: ${d.plugins.join(', ')}` : ''}
            </div>
            <div className="pk-box-title" style={{ marginTop: 4 }}>
              Commands
            </div>
            <div data-testid="confirm-commands">
              {COMMANDS.map((n) => {
                const isCheck = (CHECKS as CommandName[]).includes(n);
                const line = statusLine(
                  n,
                  kinds[n],
                  scan.trial?.[n]?.seconds,
                  scan.trial?.[n]?.tail ?? [],
                  isCheck,
                  isCheck && isCheckOn(d, n as CheckName, kinds[n]),
                );
                return (
                  <div className="pk-conf-row" key={n} data-testid={`confirm-${n}`}>
                    <Ico name={line.icon} color={line.color} sw={2.3} />
                    <span className="pk-conf-name">{n}</span>
                    <span className="pk-cmd pk-conf-cmd">{d[n].trim()}</span>
                    <span className="ai-hint">{line.text}</span>
                  </div>
                );
              })}
            </div>
            {d.env.length > 0 && (
              <div className="ai-sub" data-testid="confirm-env">
                {/* one child: .ai-sub is a flex column, which would put each part on its own line */}
                <span>
                  Environment: PATH +{' '}
                  {d.env.map((e, i) => (
                    <span key={e.path}>
                      {i > 0 && ', '}
                      <span className="ai-code">{e.path}</span>
                    </span>
                  ))}
                  , for this project only
                </span>
              </div>
            )}
          </div>
          {undecided.length > 0 && (
            <div className="pk-banner pk-banner-warn" data-testid="confirm-stop-banner" role="status">
              <Ico name="warn" size={17} color="#B8860B" sw={2} />
              <div style={{ flex: 1 }}>
                <div className="pk-banner-title">
                  {undecided.length === 1
                    ? 'One command would stop tickets if it were a check'
                    : `${WORD[Math.min(undecided.length, 3)]} commands would stop tickets if they were checks`}
                </div>
                <div className="ai-hint pk-banner-body">
                  {undecidedWrong.map((n) => (
                    <span key={n}>
                      <b>{ROW_NAME[n]}</b> does not run: the command is wrong. As a check it would send every ticket
                      back to Dev to “fix” it, and because checks stop at the first failure, the ones after it would
                      never run.{' '}
                    </span>
                  ))}
                  {undecidedFails.map((n) => {
                    const c = n === 'test' ? failCounts(scan.trial?.[n]?.tail ?? []) : null;
                    return (
                      <span key={n}>
                        <b>{ROW_NAME[n]}</b> fails {c ? `${c.failed} tests` : 'in the repository itself'}
                        {c ? ' in the repository itself' : ''}; as a check it would send every ticket back until{' '}
                        {c ? 'they pass' : 'it passes'}.{' '}
                      </span>
                    );
                  })}
                  <b>Suggested:</b> keep {undecided.length === 1 ? 'it' : 'both'} saved,{' '}
                  {undecided.length === 1 ? 'not a check yet' : 'neither a check yet'}. Nothing loops, and you can fix
                  the text under Project settings › AI › Commands.
                </div>
                <div className="pk-btns" style={{ marginTop: 9 }}>
                  <button className="ai-btn ai-btn-primary ai-btn-sm" onClick={() => keepAll(undecided)}>
                    <Ico name="check" />
                    {undecided.length === 1 ? 'Keep it saved, not a check yet' : 'Keep both saved, not checks yet'}
                  </button>
                  {undecidedWrong.map((n) => (
                    <button key={n} className="ai-btn ai-btn-sm" onClick={() => setD(n, '')}>
                      Leave {n} empty for now
                    </button>
                  ))}
                  {undecidedFails.map((n) => (
                    <button
                      key={n}
                      className="ai-btn ai-btn-sm"
                      onClick={() => setDraft((x) => (x ? withChoice(x, n, kinds[n], true) : x))}
                    >
                      Use {n} as a check anyway
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
          <label>
            The members run as{' '}
            <select className="ai-select" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="local">This computer’s own Claude login</option>
              {(windows.data?.accounts ?? [])
                .filter((a) => a.key !== 'local')
                .map((a) => (
                  <option key={a.key} value={a.key}>
                    {a.name}
                    {a.email ? ` · ${a.email}` : ''}
                  </option>
                ))}
            </select>
          </label>
          {apply.error && (
            <span className="ai-error-text" role="alert">
              {extractError(apply.error)}
            </span>
          )}
        </div>
      )}
    </WizardPage>
  );
}

function FoundList({ scan }: { scan: Scan }) {
  const f = scan.found;
  const rows: [string, string][] = [
    ['Languages', [...f.languages, ...f.frameworks].join(', ') || 'none found'],
    ['Packages', f.packages.length ? f.packages.map((p) => `${p.path || '.'} (${p.kind})`).join(', ') : 'none'],
    ['From the CI workflow', f.ciCommands.length ? f.ciCommands.join(' && ') : 'none'],
    ['Agent files', f.agentFiles.length ? f.agentFiles.join(', ') : 'none'],
    ['Remote', f.remote ?? (f.git ? 'git, no remote' : 'not a git repository')],
    ['Shape', `${f.monorepo ? 'A monorepo' : 'One package'} · ${f.files} files${f.ui ? ' · a web UI' : ''}`],
  ];
  return (
    <>
      {rows.map(([k, v]) => (
        <div key={k} className="pk-team-row">
          <strong style={{ width: 150, flexShrink: 0 }}>{k}</strong>
          <span className={k === 'From the CI workflow' ? 'pk-cmd' : undefined}>{v}</span>
        </div>
      ))}
    </>
  );
}
