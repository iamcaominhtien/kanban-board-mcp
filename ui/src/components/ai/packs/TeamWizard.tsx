import { useMemo, useState } from 'react';
import { useAiWindows } from '../../../api/aiWindows';
import { useApplyScan, useCatalogue, usePacks, useScan } from '../../../api/aiPacks';
import { extractError } from '../../../api/extractError';
import type {
  ApplyResult,
  HandoverKind,
  Scan,
  Suggestion,
  SuggestedMember,
  TrialRun,
  WorkflowKey,
} from '../../../types/aiPacks';
import { WORKFLOW_NAME, WORKFLOW_ROLES, lostRoles, workflowFor } from './packLabels';
import { Dialog } from './PackDialogs';
import './packs.css';

const STEPS = ['Read the repository', 'What it suggests', 'Try the commands', 'Confirm'];

const HANDOVER: Record<HandoverKind, string> = {
  pr: 'Opening a pull request',
  branch: 'Pushing a branch',
  local: 'Leaving it in the worktree',
};

/** Everything the person can change before Create; it lives here so the steps keep it. */
interface Draft {
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
}

function toDraft(s: Suggestion): Draft {
  return {
    test: s.commands.test ?? '',
    lint: s.commands.lint ?? '',
    build: s.commands.build ?? '',
    prepare: s.prepare ?? '',
    basePort: s.basePort == null ? '' : String(s.basePort),
    workflow: s.workflowDefault,
    handover: s.handover,
    worktrees: s.worktrees,
    team: s.team.map((m) => ({ ...m })),
    plugins: [...s.plugins],
  };
}

function Trial({ label, run, current }: { label: string; run: TrialRun | null; current: string }) {
  if (!run) return <div className="pk-trial">{label}: not tried (no command).</div>;
  const stale = current.trim() !== run.command;
  return (
    <div className={`pk-trial${run.ok ? '' : ' pk-trial-fail'}`} data-testid={`trial-${label.toLowerCase()}`}>
      <strong>
        {label} · <code>{run.command}</code> · {run.ok ? 'passed' : `failed (exit ${run.exitCode ?? '?'})`} ·{' '}
        {run.seconds.toFixed(1)} s
      </strong>
      {run.tail.length > 0 && <pre>{run.tail.join('\n')}</pre>}
      {stale && (
        <span className="ai-error-text">You changed this command after it was tried. Try again to prove it.</span>
      )}
    </div>
  );
}

/** The one-pass wizard: 1 Scan, 2 Review, 3 Try, 4 Confirm. Nothing exists until Create (design D). */
export function TeamWizard({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const scanM = useScan(projectId);
  const apply = useApplyScan(projectId);
  const packs = usePacks(projectId);
  const catalogue = useCatalogue();
  const windows = useAiWindows();
  const [step, setStep] = useState(1);
  const [folder, setFolder] = useState('');
  const [scan, setScan] = useState<Scan | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [accountId, setAccountId] = useState('local');
  const [workflowNote, setWorkflowNote] = useState<string | null>(null);
  const [result, setResult] = useState<ApplyResult | null>(null);

  const packList = useMemo(() => packs.data ?? [], [packs.data]);
  const setD = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const roleName = (key: string) => packList.find((p) => p.key === key)?.name ?? key;
  const glyph = (key: string) => packList.find((p) => p.key === key)?.glyph ?? key.slice(0, 2).toUpperCase();

  const runScan = (keepDraft: boolean) =>
    scanM.mutate(folder.trim(), {
      onSuccess: (s) => {
        setScan(s);
        if (!keepDraft || !draft) setDraft(toDraft(s.suggested));
        setStep(keepDraft ? 3 : 2);
      },
    });

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
          commands: { test: draft.test || null, lint: draft.lint || null, build: draft.build || null },
          prepare: draft.prepare || null,
          basePort: draft.basePort ? Number(draft.basePort) : null,
          workflowDefault: draft.workflow,
          handover: draft.handover,
          worktrees: draft.worktrees,
          team: draft.team,
          plugins: draft.plugins,
          accountId: accountId === 'local' ? null : accountId,
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
            <span className="ai-step-n">{i + 1}</span>
            {s}
          </span>
          {i < STEPS.length - 1 && <span className="ai-step-line" />}
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
  return (
    <Dialog
      title="Set up the AI team"
      onClose={onClose}
      foot={
        <>
          {step === 1 && (
            <button
              className="ai-btn ai-btn-primary"
              disabled={!folder.trim() || scanM.isPending}
              onClick={() => runScan(false)}
            >
              {scanM.isPending ? 'Reading…' : 'Read the repository'}
            </button>
          )}
          {step === 2 && (
            <button className="ai-btn ai-btn-primary" onClick={() => setStep(3)}>
              Next: try the commands
            </button>
          )}
          {step === 3 && (
            <>
              <button className="ai-btn ai-btn-primary" onClick={() => setStep(4)}>
                Next: confirm
              </button>
              <button className="ai-btn" disabled={scanM.isPending} onClick={() => runScan(true)}>
                {scanM.isPending ? 'Trying…' : 'Try again'}
              </button>
            </>
          )}
          {step === 4 && (
            <button className="ai-btn ai-btn-primary" disabled={apply.isPending || !d?.team.length} onClick={create}>
              {apply.isPending ? 'Creating…' : 'Create the team'}
            </button>
          )}
          {step > 1 && !scanM.isPending && (
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
            Nothing is created until the last step. The scan reads manifests, lock files, the CI workflow, CLAUDE.md,
            the README, the test folders and the git remote, and it proves its commands by running them once in a
            scratch worktree. It creates nothing until you press Create.
          </div>
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
              <div className="ai-sub">Reading the files and trying the commands. This can take a minute or two.</div>
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
        <div className="pk-form" data-testid="wizard-step-2">
          <div className="pk-box">
            <div className="pk-box-title">What the board read</div>
            <FoundList scan={scan} />
            <div className="ai-sub">All of it read from files. No quota spent.</div>
          </div>
          {!d.test && !d.lint && !d.build && !d.prepare && (
            <div className="ai-notice ai-notice-warn" role="status" data-testid="scan-found-nothing">
              The scan found no manifest and no CI workflow, so it has no commands to suggest and will not invent them.
              Type the prepare, test, lint and build commands below by hand.
            </div>
          )}
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
              The team always covers every role the suggested workflow needs. Removing a role changes the workflow too,
              and the screen says which steps would go.
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
            <div className="pk-box-title">Commands</div>
            {scan.suggested.why.commands && <div className="ai-sub">{scan.suggested.why.commands}</div>}
            <div className="pk-two">
              <label>
                Prepare command{' '}
                <input
                  className="ai-input pk-cmd"
                  value={d.prepare}
                  onChange={(e) => setD('prepare', e.target.value)}
                />
              </label>
              <label>
                Test command{' '}
                <input className="ai-input pk-cmd" value={d.test} onChange={(e) => setD('test', e.target.value)} />
              </label>
              <label>
                Lint command{' '}
                <input className="ai-input pk-cmd" value={d.lint} onChange={(e) => setD('lint', e.target.value)} />
              </label>
              <label>
                Build command{' '}
                <input className="ai-input pk-cmd" value={d.build} onChange={(e) => setD('build', e.target.value)} />
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
          </div>

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
      )}

      {step === 3 && scan && d && (
        <div className="pk-form" data-testid="wizard-step-3">
          <div className="ai-sub">
            The prepare command and the test command were run once in a scratch worktree. A command that fails is shown
            failing, not quietly dropped. The scratch worktree is removed afterwards.
          </div>
          <Trial label="Prepare" run={scan.trial.prepare} current={d.prepare} />
          <Trial label="Test" run={scan.trial.test} current={d.test} />
          {scanM.error && (
            <span className="ai-error-text" role="alert">
              {extractError(scanM.error)}
            </span>
          )}
        </div>
      )}

      {step === 4 && d && (
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
            <div className="ai-sub pk-cmd">
              {[
                d.prepare && `prepare: ${d.prepare}`,
                d.test && `test: ${d.test}`,
                d.lint && `lint: ${d.lint}`,
                d.build && `build: ${d.build}`,
              ]
                .filter(Boolean)
                .join(' · ') || 'No commands.'}
            </div>
          </div>
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
    </Dialog>
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
