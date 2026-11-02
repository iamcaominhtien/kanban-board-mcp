import { useState } from 'react';
import { useTicketRuns } from '../../../api/ai';
import { useProjectOps } from '../../../api/aiProjectOps';
import { useTddEvidence, useTicketWorkflow, useWorkflowMutation, workflowApi } from '../../../api/aiWorkflow';
import { extractError } from '../../../api/extractError';
import type { Ticket } from '../../../types';
import type { AiRun } from '../../../types/ai';
import type { TddEvidence, ViewStep, WorkflowView } from '../../../types/aiWorkflow';
import { caseName } from '../../../utils/proofRules';
import { openRun } from '../../aiteam/runLink';
import { hhmm, useAiBoardState } from '../aiUi';
import { RoleChip } from '../workflow/WfUi';
import { AcceptedBy } from './AcceptedBy';
import { ReasonForm } from './ReasonForm';
import {
  BOARD_MAY_MOVE,
  EVIDENCE_ROLES,
  acceptedOf,
  gateState,
  lastStepOf,
  runOfStep,
  testerProof,
  type GateState,
} from './evidenceModel';
import './evidence.css';
import { LineIcon } from '../../ui/LineIcon';

const GATE_CHIP: Record<GateState, { label: string; tone: 'ok' | 'bad' | 'plain' }> = {
  complete: { label: 'Evidence complete', tone: 'ok' },
  missing: { label: 'Evidence missing', tone: 'bad' },
  tdd_unproven: { label: 'Test first not proven', tone: 'bad' },
  accepted: { label: 'Accepted without tests', tone: 'ok' },
  tdd_off: { label: 'Test first off', tone: 'plain' },
  open: { label: 'Not complete yet', tone: 'plain' },
};

type Mark = 'ok' | 'bad' | 'wait';

function Check({ mark, title, sub, testId }: { mark: Mark; title: string; sub: string; testId: string }) {
  return (
    <div className={`ev-check ev-check-${mark}`} data-testid={testId} data-mark={mark}>
      <span className="ev-check-mark" aria-label={mark === 'ok' ? 'Passed' : mark === 'bad' ? 'Missing' : 'Not yet'}>
        {mark === 'ok' ? <LineIcon name="check" size={12} /> : mark === 'bad' ? '!' : ''}
      </span>
      <div>
        <b>{title}</b>
        <div className="ev-hint">{sub}</div>
      </div>
    </div>
  );
}

/** The four checks of the gate: test first, the checks by code, the Tester's proof, the review. */
function GateChecks({
  view,
  tdd,
  tddRequired,
  proof,
}: {
  view: WorkflowView;
  tdd: TddEvidence | undefined;
  tddRequired: boolean;
  proof: ReturnType<typeof testerProof>;
}) {
  const dev = lastStepOf(view, ['dev']);
  const tester = lastStepOf(view, EVIDENCE_ROLES);
  const reviewer = lastStepOf(view, ['reviewer']);
  const code = [...view.steps].reverse().find((s) => s.kind === 'code');
  const checks = code?.result?.checks ?? [];
  const failedCheck = checks.find((c) => !c.ok);

  const tddMark: [Mark, string] = tdd?.proven
    ? ['ok', 'red, then green']
    : dev?.outcome === 'accepted'
      ? ['ok', 'accepted without, by a person']
      : !tddRequired
        ? ['ok', 'off for this project']
        : dev?.outcome === 'unproven'
          ? ['bad', 'not proven']
          : ['wait', 'not yet'];
  const codeMark: [Mark, string] = !code
    ? ['wait', 'no checks in this workflow']
    : code.outcome === 'failed' || failedCheck
      ? ['bad', failedCheck ? `${failedCheck.name} failed` : 'failed']
      : code.state === 'done'
        ? ['ok', checks.length ? checks.map((c) => c.name).join(', ') : 'passed']
        : ['wait', 'not yet'];
  const trust = proof.trusted.length > 0 ? `, ${proof.trusted.length} on trust` : '';
  const proofMark: [Mark, string] =
    tester?.outcome === 'no_evidence'
      ? ['bad', 'nothing handed in']
      : tester?.outcome === 'accepted'
        ? ['ok', 'accepted without, by a person']
        : proof.given.length === 0
          ? ['wait', tester ? 'no results yet' : 'no test results']
          : proof.missing.length > 0
            ? ['bad', `${proof.shown} of ${proof.given.length}${trust}`]
            : ['ok', `${proof.shown} of ${proof.given.length}${trust}`];
  const reviewMark: [Mark, string] = !reviewer
    ? ['wait', 'no review in this workflow']
    : reviewer.state === 'done' && reviewer.outcome === 'pass'
      ? ['ok', 'pass']
      : reviewer.outcome === 'changes'
        ? ['bad', 'changes asked']
        : ['wait', 'not yet'];
  const bad = [tddMark, codeMark, proofMark, reviewMark].some(([m]) => m === 'bad');
  return (
    <div className={`ev-gate${bad ? ' ev-gate-bad' : ''}`} data-testid="evidence-gate">
      <Check testId="gate-tdd" mark={tddMark[0]} title="Test first" sub={tddMark[1]} />
      <Check testId="gate-checks" mark={codeMark[0]} title="Checks" sub={codeMark[1]} />
      <Check testId="gate-proof" mark={proofMark[0]} title="Tester’s proof" sub={proofMark[1]} />
      <Check testId="gate-review" mark={reviewMark[0]} title="Review" sub={reviewMark[1]} />
    </div>
  );
}

/**
 * Test first when there is no red-then-green pair to draw: not proven, taken without it by a person, or off. The
 * choices (send back, accept once with a reason, turn the rule off) stay on the workflow's test-first card, so they
 * are not offered twice.
 */
function TddSummary({ dev, tdd, tddRequired }: { dev: ViewStep; tdd: TddEvidence | undefined; tddRequired: boolean }) {
  const taken = acceptedOf(dev);
  if (taken)
    return (
      <div className="ev-card ev-card-green" data-testid="evidence-tdd" data-state="accepted">
        <span className="ev-chip ev-chip-ok" style={{ alignSelf: 'flex-start' }}>
          <LineIcon name="check" size={12} /> Accepted without tests
        </span>
        <AcceptedBy accepted={taken} />
      </div>
    );
  if (dev.outcome === 'unproven')
    return (
      <div className="ev-card ev-card-red" data-testid="evidence-tdd" data-state="unproven">
        <span className="ev-chip ev-chip-bad" style={{ alignSelf: 'flex-start' }}>
          <LineIcon name="warning" size={12} /> Test first not proven
        </span>
        <div className="ev-card-text">
          <div>{tdd && !tdd.proven ? tdd.why : 'No run where a test failed on an assertion and then passed.'}</div>
          <div className="ev-hint" style={{ fontSize: 11.5 }}>
            The Dev step is not marked done. Send it back, accept it once with a reason, or turn the rule off on the
            test-first card of the workflow.
          </div>
        </div>
      </div>
    );
  if (!tddRequired)
    return (
      <div className="ev-card" data-testid="evidence-tdd" data-state="off">
        <span className="ev-chip" style={{ alignSelf: 'flex-start' }}>
          Not required
        </span>
        <div className="ev-hint">Test first is off for this project: there is nothing to prove.</div>
      </div>
    );
  return (
    <div className="ev-hint" data-testid="evidence-tdd" data-state="none">
      No red run and green run yet{tdd && !tdd.proven && tdd.runsSeen > 0 ? ` (${tdd.runsSeen} runs looked at)` : ''}.
    </div>
  );
}

/** Dev's side: the red run and the green one, the tests the board read, the files of the diff. */
function DevColumn({
  dev,
  run,
  tdd,
  tddRequired,
}: {
  dev: ViewStep;
  run: AiRun | undefined;
  tdd: TddEvidence | undefined;
  tddRequired: boolean;
}) {
  const tests = run?.tests ?? null;
  const files = run?.files ?? [];
  return (
    <div className="ev-col" data-testid="evidence-dev">
      <div className="ev-who">
        <RoleChip role="dev" title="Dev" />
        <b>{dev.memberName ?? 'Dev'}</b>
        <span className="ev-hint">tests and diff</span>
      </div>
      {tdd?.proven ? (
        <div className="ev-pair">
          <div className="ev-run ev-run-red" data-testid="evidence-red">
            <b style={{ color: '#a5321e' }}>Red &middot; {hhmm(tdd.red.at)}</b>
            <br />
            <code className="ai-code">{tdd.red.command}</code>
            <br />
            <b>{tdd.red.failed} failed</b>
            {tdd.red.failing.length > 0 && (
              <>
                {' '}
                &middot; <code className="ai-code">{tdd.red.failing.join(', ')}</code>
              </>
            )}
            <div className="ev-hint" style={{ fontSize: 11 }}>
              {tdd.red.why}
            </div>
          </div>
          <span className="ev-arrow" aria-hidden="true">
            &rarr;
          </span>
          <div className="ev-run ev-run-green" data-testid="evidence-green">
            <b style={{ color: '#1f5a31' }}>Green &middot; {hhmm(tdd.green.at)}</b>
            <br />
            <code className="ai-code">{tdd.green.command}</code>
            <br />
            <b>{tdd.green.passed} passed</b>
            <div className="ev-hint" style={{ fontSize: 11 }}>
              same command, after the change
            </div>
          </div>
        </div>
      ) : (
        <TddSummary dev={dev} tdd={tdd} tddRequired={tddRequired} />
      )}
      {tests && (
        <div className="ev-tests" data-testid="evidence-tests">
          {(tests.passed > 0 || tests.failed === 0) && (
            <span className="ev-test">
              <LineIcon name="check" size={12} /> {tests.passed} passed
            </span>
          )}
          {tests.failed > 0 && (
            <span className="ev-test ev-test-bad">
              <LineIcon name="warning" size={12} /> {tests.failed} failed
            </span>
          )}
          {tests.lint && (
            <span className="ev-test">
              <LineIcon name="check" size={12} /> lint {tests.lint}
            </span>
          )}
          <span className="ev-hint" style={{ fontSize: 11.5 }}>
            read from the command&rsquo;s output, not the AI&rsquo;s claim
          </span>
        </div>
      )}
      {files.length > 0 && (
        <>
          <div className="ev-h">Files &middot; {files.length}</div>
          <div className="ev-files" data-testid="evidence-files">
            {files.map((f) => (
              <span key={f.path}>
                {f.new ? '+ ' : ''}
                {f.path} <span style={{ color: '#2E6F40' }}>+{f.added}</span>
                {!f.new && f.removed > 0 && <span style={{ color: '#C4432A' }}> &minus;{f.removed}</span>}
              </span>
            ))}
          </div>
        </>
      )}
      {tdd?.proven && (
        <div className="ev-actions">
          <button type="button" className="ai-btn ai-btn-sm" onClick={() => openRun(tdd.red.run)}>
            Open the red run
          </button>
          <button type="button" className="ai-btn ai-btn-sm" onClick={() => openRun(tdd.green.run)}>
            Open the green run
          </button>
        </div>
      )}
    </div>
  );
}

/** The Tester's side: the pictures and logs of the test cases, side by side, and what is taken on trust. */
function TesterColumn({ tester, proof }: { tester: ViewStep | undefined; proof: ReturnType<typeof testerProof> }) {
  const [large, setLarge] = useState(false);
  const pictures = proof.pictures.slice(0, large ? undefined : 3);
  const log = proof.logs[0];
  return (
    <div className="ev-col" data-testid="evidence-tester">
      <div className="ev-who">
        <RoleChip role={tester?.role ?? 'qa'} title="Tester" />
        <b>{tester?.memberName ?? 'Tester'}</b>
        <span className="ev-hint">screenshots and logs</span>
      </div>
      {(pictures.length > 0 || log) && (
        <div className={`ev-shots${large ? ' ev-shots-large' : ''}`}>
          {pictures.map((p) => (
            <a key={p.tc.id} className="ev-shot" href={p.image!} target="_blank" rel="noreferrer">
              <img className="ev-shot-img" src={p.image!} alt={`Proof of ${caseName(p.tc)}`} loading="lazy" />
              <span className="ev-shot-name">
                {p.tc.code ? `${p.tc.code} ` : ''}
                {p.tc.title}
              </span>
            </a>
          ))}
          {log && !large && (
            <pre className="ev-log" data-testid="evidence-log" title={`From ${caseName(log.tc)}`}>
              {log.log}
            </pre>
          )}
        </div>
      )}
      {proof.given.length > 0 ? (
        <div style={{ fontSize: 13 }} data-testid="evidence-proof-count">
          <b>
            {proof.shown} of {proof.given.length} results have a proof
          </b>{' '}
          on the ticket
          {proof.trusted.length > 0 ? ` · ${proof.trusted.length} cannot be shown` : ''}
        </div>
      ) : (
        <div className="ev-hint">No test case has a result yet.</div>
      )}
      {proof.missing.length > 0 && (
        <div className="ev-missing" data-testid="evidence-proof-missing">
          No proof: {proof.missing.map(caseName).join(', ')}. Ask for it before you approve.
        </div>
      )}
      {proof.trusted.length > 0 && (
        <div className="ev-hint" style={{ fontSize: 11.5 }} data-testid="evidence-trusted">
          Taken on trust:{' '}
          {proof.trusted.map((p, i) => (
            <span key={p.tc.id}>
              {i > 0 && ', '}
              <code className="ai-code">{caseName(p.tc)}</code> &ldquo;{(p.tc.proof ?? '').trim()}&rdquo;
            </span>
          ))}
          . Each proof is the picture, the command and its output, or a link, written in the test case.
        </div>
      )}
      {proof.pictures.length > 0 && (
        <div className="ev-actions">
          <button
            type="button"
            className="ai-btn ai-btn-sm"
            aria-pressed={large}
            data-testid="evidence-large"
            onClick={() => setLarge((x) => !x)}
          >
            {large ? 'See the pictures small' : 'See the pictures large'}
          </button>
        </div>
      )}
    </div>
  );
}

/** A testing step that finished with nothing to show: send it back, or accept it with a reason (the new card of N). */
function MissingEvidenceCard({
  ticketId,
  tester,
  proof,
}: {
  ticketId: string;
  tester: ViewStep;
  proof: ReturnType<typeof testerProof>;
}) {
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = useWorkflowMutation(ticketId, (note: string) => workflowApi.sendBack(ticketId, tester.role!, note));
  const accept = useWorkflowMutation(ticketId, (reason: string) => workflowApi.acceptEvidence(ticketId, reason));
  const passed = proof.given.filter((t) => t.status === 'pass').length;
  const who = tester.memberName ?? 'The Tester';
  const fail = (x: unknown) => setError(extractError(x));
  return (
    <div className="ev-card ev-card-red" data-testid="evidence-missing" role="status">
      <div className="wf-line">
        <b style={{ fontSize: 13, flex: 1 }}>No evidence from the Tester</b>
        <span className="ev-chip ev-chip-bad">Evidence missing</span>
      </div>
      <div className="ev-card-text">
        <div>
          {who} marked {passed} result{passed === 1 ? '' : 's'} pass and handed in no picture, command output or link.
          The board sent it back once (<i>the board, evidence</i>); the second time the step moved on.
        </div>
        {proof.missing.length > 0 && (
          <div className="ev-missing">
            No proof: {proof.missing.map(caseName).join(', ')}. Ask for it before you approve.
          </div>
        )}
        <div className="ev-hint" style={{ fontSize: 11.5 }}>
          The board does not move the ticket to Done while the evidence is missing.
        </div>
      </div>
      {asking ? (
        <ReasonForm
          testId="evidence-reason"
          label="Why is it right to accept it without evidence?"
          placeholder="For example: I tried it myself on the staging site."
          submitLabel="Accept without evidence"
          busy={accept.isPending}
          onCancel={() => setAsking(false)}
          onSubmit={(reason) => {
            setError(null);
            accept.mutate(reason, { onError: fail, onSuccess: () => setAsking(false) });
          }}
        />
      ) : (
        <div className="ev-actions">
          <button
            type="button"
            className="ai-btn ai-btn-primary ai-btn-sm"
            disabled={send.isPending || !tester.role}
            onClick={() => {
              setError(null);
              send.mutate(
                'There is no evidence on the ticket: give every test case you ran its proof (a screenshot, or the ' +
                  'command and its output), and put the screenshots of what you tried in a comment.',
                { onError: fail },
              );
            }}
          >
            <LineIcon name="reply" size={13} /> Send back to {tester.memberName ?? 'Tester'}
          </button>
          <button
            type="button"
            className="ai-btn ai-btn-sm"
            data-testid="evidence-accept"
            onClick={() => {
              setError(null);
              setAsking(true);
            }}
          >
            Accept without evidence
          </button>
        </div>
      )}
      {error && (
        <div className="ai-error-text" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

/** Whether there is anything to show yet: Dev has handed in, or a testing step has an outcome. */
function hasEvidenceToShow(view: WorkflowView): boolean {
  if (view.state === 'done') return true;
  const dev = lastStepOf(view, ['dev']);
  const tester = lastStepOf(view, EVIDENCE_ROLES);
  return (
    (!!dev && ['done', 'failed'].includes(dev.state)) ||
    (!!tester && tester.outcome !== null) ||
    view.steps.some((s) => s.kind === 'code' && s.state !== 'pending')
  );
}

/**
 * Evidence on a ticket (ai-story-flow N): one block in AI activity that gathers the gate and its four checks, Dev's
 * tests and diff, the Tester's pictures and logs, and the states the board otherwise keeps to itself: a testing step
 * with nothing to show, work taken without tests, and test first turned off.
 */
export function EvidenceBlock({ ticket }: { ticket: Ticket }) {
  const { projectId, members } = useAiBoardState();
  const hasAi = members.size > 0;
  const wf = useTicketWorkflow(ticket.id, hasAi);
  const view = wf.data;
  const dev = view ? lastStepOf(view, ['dev']) : undefined;
  const tdd = useTddEvidence(ticket.id, !!dev);
  const runs = useTicketRuns(view ? ticket.id : undefined);
  const ops = useProjectOps(view ? projectId || ticket.projectId : '');
  if (!view || view.state === 'detached' || !hasEvidenceToShow(view)) return null;
  const tddRequired = ops.data?.tdd?.required !== false;
  const state = gateState(view, tdd.data, tddRequired);
  const tester = lastStepOf(view, EVIDENCE_ROLES);
  const proof = testerProof(ticket.testCases);
  const chip = GATE_CHIP[state];
  const boardMoves = ops.data?.autonomy?.done === 'after_review';
  const testerTaken = acceptedOf(tester);
  return (
    <section className="ev-block" data-testid="evidence-block" data-state={state} aria-label="Evidence">
      <div className="ev-head">
        <span className="ev-h">Evidence</span>
        <span
          className={`ev-chip${chip.tone === 'ok' ? ' ev-chip-ok' : chip.tone === 'bad' ? ' ev-chip-bad' : ''}`}
          data-testid="evidence-state"
        >
          {chip.tone === 'ok' ? (
            <>
              <LineIcon name="check" size={12} />{' '}
            </>
          ) : chip.tone === 'bad' ? (
            <>
              <LineIcon name="warning" size={12} />{' '}
            </>
          ) : null}
          {chip.label}
        </span>
        <span style={{ flex: 1 }} />
        <span className="ev-hint" data-testid="evidence-board-moves">
          {!boardMoves ? (
            <>
              Moving to Done stays yours. With <i>the board moves it</i> on, this is what lets it.
            </>
          ) : BOARD_MAY_MOVE[state] ? (
            'The board may move it to Done.'
          ) : (
            'The board does not move it to Done until this is settled.'
          )}
        </span>
      </div>
      <div className="ev-body">
        <GateChecks view={view} tdd={tdd.data} tddRequired={tddRequired} proof={proof} />
        {state === 'missing' && tester && <MissingEvidenceCard ticketId={ticket.id} tester={tester} proof={proof} />}
        {testerTaken && (
          <div className="ev-card ev-card-green" data-testid="evidence-accepted">
            <div className="wf-line">
              <b style={{ fontSize: 13, flex: 1 }}>Taken without the Tester&rsquo;s evidence</b>
              <span className="ev-chip ev-chip-ok">Accepted without evidence</span>
            </div>
            <AcceptedBy accepted={testerTaken} />
          </div>
        )}
        <div className="ev-cols">
          {dev ? (
            <DevColumn dev={dev} run={runOfStep(dev, runs.data ?? [])} tdd={tdd.data} tddRequired={tddRequired} />
          ) : (
            <div className="ev-hint">This workflow has no Dev step.</div>
          )}
          <TesterColumn tester={tester} proof={proof} />
        </div>
      </div>
    </section>
  );
}
