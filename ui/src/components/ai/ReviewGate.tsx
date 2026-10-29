import { useState } from 'react';
import { aiApi, useAiMutation } from '../../api/ai';
import { updateTicketStatus } from '../../api/tickets';
import { extractError } from '../../api/extractError';
import type { AiRun, TestCounts } from '../../types/ai';
import type { Ticket } from '../../types';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { useToast } from '../Toast';
import { TakeOverButton, UndoRunDialog } from './RunActions';
import { AiAvatar, SparkleIcon, fmtElapsed, hhmm, money, useAiBoardState } from './aiUi';
import './ticketWork.css';

/** Test counts of a run: what the board read from a test command, else the agent's own claim (and which). */
export function testsOf(run: AiRun): { counts: TestCounts; source: 'board' | 'claim' } | null {
  if (run.tests) return { counts: run.tests, source: 'board' };
  const claim = run.report.tests;
  return claim ? { counts: claim, source: 'claim' } : null;
}

/** Chips “14 passed · 1 failed · lint clean” of a test summary. */
export function TestChips({ counts }: { counts: TestCounts }) {
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }} data-testid="test-chips">
      {(counts.passed > 0 || counts.failed === 0) && (
        <span className="tw-test tw-test-ok">✓ {counts.passed} passed</span>
      )}
      {counts.failed > 0 && <span className="tw-test tw-test-bad">⚠ {counts.failed} failed</span>}
      {counts.lint && <span className="tw-test tw-test-ok">✓ lint {counts.lint}</span>}
    </div>
  );
}

/**
 * Review gate (F1): the AI's summary is a claim, not proof. What changed, the tests it ran, the files, which
 * criteria it says it met and which it could not verify, and the reviewer's actions: Approve, Request changes,
 * Take over (to a person), Undo run's changes.
 */
export function SummaryCard({ run, ticket, onOpenRun }: { run: AiRun; ticket: Ticket; onOpenRun: () => void }) {
  const toast = useToast();
  const { members } = useAiBoardState();
  const ai = members.get(run.memberId);
  const [mode, setMode] = useState<null | 'changes'>(null);
  const [undo, setUndo] = useState(false);
  const [text, setText] = useState('');
  const [cont, setCont] = useState(true);
  const done = useAiMutation(() => updateTicketStatus(ticket.id, 'done'));
  const changes = useAiMutation(() => aiApi.requestChanges(ticket.id, text, cont));
  const criteria = run.report.criteria ?? [];
  const met = criteria.filter((c) => c.met).length;
  const unverified = criteria.length - met;
  const tests = testsOf(run);
  const ceilingStops = ai && ['none', 'backlog', 'todo', 'in-progress', 'review', 'testing'].includes(ai.ceiling);
  return (
    <div className="tw-gate" data-testid="ai-summary-card">
      <div className="tw-gate-head">
        <span className="ai-chip" style={{ background: '#1E2A22', color: '#fff' }}>
          <SparkleIcon size={10} /> AI
        </span>
        <b style={{ fontSize: 15 }}>AI summary</b>
        {ai && <AiAvatar provider={ai.provider} color={ai.color} glyph={ai.glyph} size={26} />}
        <span className="ai-muted" style={{ fontSize: 12.5 }}>
          {run.memberName} · run #{run.number} · finished {hhmm(run.endedAt)} · {fmtElapsed(run.elapsedS)}
        </span>
        <span style={{ flex: 1 }} />
        <span className="tw-pillbox ai-mono">{run.metered ? money(run.costUsd) : 'Ⓢ Not metered'}</span>
        <button type="button" className="ai-link" onClick={onOpenRun} data-testid="summary-open-run">
          Open run
        </button>
      </div>
      <div className="tw-gate-body">
        <div style={{ minWidth: 0 }}>
          <div className="ai-label">What changed</div>
          <div style={{ fontSize: 13.5, lineHeight: 1.55, marginTop: 4 }} data-testid="summary-what-changed">
            <MarkdownRenderer>{run.summary ?? 'No summary was written.'}</MarkdownRenderer>
          </div>
          {tests && (
            <div style={{ marginTop: 14 }} data-testid="summary-tests">
              <div className="ai-label">
                Tests run{' '}
                <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 500 }}>
                  {tests.source === 'board' ? '· read from the command’s output' : '· the AI’s claim'}
                </span>
              </div>
              <div style={{ margin: '6px 0' }}>
                <TestChips counts={tests.counts} />
              </div>
              {(tests.counts.failing?.length ?? 0) > 0 && (
                <div style={{ fontSize: 12.5, color: '#5B6B60' }}>
                  Failing:{' '}
                  {tests.counts.failing!.map((f) => (
                    <span key={f} className="ai-code" style={{ marginRight: 6 }}>
                      {f}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
          {run.files.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div className="ai-label">Files · {run.files.length}</div>
              <div style={{ display: 'flex', gap: '2px 14px', flexWrap: 'wrap', marginTop: 4, fontSize: 12.5 }}>
                {run.files.map((f) => (
                  <span key={f.path} className="ai-mono">
                    {f.new ? '+ ' : ''}
                    {f.path} <span style={{ color: '#2E6F40' }}>+{f.added}</span>
                    {!f.new && f.removed > 0 && <span style={{ color: '#C4432A' }}> −{f.removed}</span>}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
        {criteria.length > 0 && (
          <div style={{ minWidth: 0 }} data-testid="summary-criteria">
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <span className="ai-label">Criteria · AI’s claim</span>
              <span
                style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 700, color: unverified ? '#B4571F' : '#2E6F40' }}
              >
                {met} of {criteria.length} met{unverified > 0 ? ` · ${unverified} unverified` : ''}
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>
              {criteria.map((c, i) => (
                <div key={i} style={{ display: 'flex', gap: 9 }}>
                  <span
                    className={`tw-claim ${c.met ? 'tw-claim-met' : 'tw-claim-open'}`}
                    aria-label={c.met ? 'Met' : 'Not verified'}
                  >
                    {c.met ? '✓' : '?'}
                  </span>
                  <span style={{ fontSize: 13.5, minWidth: 0 }}>
                    {c.text}
                    {c.met && c.evidence ? <div className="ai-hint">{c.evidence}</div> : null}
                    {!c.met && (
                      <div style={{ fontSize: 12.5, color: '#B4571F' }}>
                        {c.evidence ? `Not verified: ${c.evidence}` : 'Not verified'}
                      </div>
                    )}
                  </span>
                </div>
              ))}
            </div>
            <div className="ai-hint" style={{ marginTop: 10, color: '#9AA8A0' }}>
              Claims are shown as the AI’s words. Tick the criteria yourself; the ticket’s own checkboxes are not
              changed by the AI.
            </div>
          </div>
        )}
      </div>
      {ceilingStops && (
        <div className="ai-hint" style={{ padding: '0 16px 8px' }}>
          {run.memberName}’s permission stops at {ai?.ceiling === 'review' ? 'Review' : ai?.ceiling}: moving to Done is
          yours.
        </div>
      )}
      <div className="tw-gate-foot">
        <button
          type="button"
          className="ai-btn ai-btn-primary"
          disabled={done.isPending}
          onClick={async () => {
            try {
              await done.mutateAsync(undefined);
              toast.success('Moved to Done', `${ticket.id} · approved by you`);
            } catch (err) {
              toast.error("Couldn't move to Done", extractError(err));
            }
          }}
          data-testid="ai-approve-done"
        >
          ✓ Approve → Done
        </button>
        <button
          type="button"
          className="ai-btn"
          aria-expanded={mode === 'changes'}
          onClick={() => setMode(mode === 'changes' ? null : 'changes')}
          data-testid="ai-request-changes"
        >
          ↻ Request changes
        </button>
        <TakeOverButton ticketId={ticket.id} projectId={ticket.projectId} />
        <span style={{ flex: 1 }} />
        <button type="button" className="ai-link" onClick={() => setUndo(true)} data-testid="ai-undo-run">
          Undo run’s changes ↶
        </button>
      </div>
      {mode === 'changes' && (
        <div className="tw-changes" data-testid="request-changes-card">
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <b style={{ fontSize: 14 }}>Request changes</b>
            <span className="ai-muted">reuses the Reopen idea; the comment becomes the reason</span>
          </div>
          <textarea
            className="ai-textarea"
            style={{ marginTop: 8 }}
            placeholder="The touch case is not covered. Add a test for pointerType: touch and fix the failing focus test."
            value={text}
            onChange={(e) => setText(e.target.value)}
            data-testid="request-changes-text"
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            {[
              { v: true, label: 'Continue the session (keeps context)' },
              { v: false, label: 'Start a fresh run' },
            ].map((o) => (
              <button
                key={o.label}
                type="button"
                className={`ai-option ${cont === o.v ? 'ai-option-active' : ''}`}
                style={{ width: 'auto' }}
                onClick={() => setCont(o.v)}
              >
                <span className={`ai-radio ${cont === o.v ? 'ai-radio-on' : ''}`} /> {o.label}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
            <span className="tw-pillbox" data-testid="request-changes-preview">
              → In Progress, run #{run.number + 1}
            </span>
            <span style={{ flex: 1 }} />
            <button type="button" className="ai-btn ai-btn-sm" onClick={() => setMode(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="ai-btn ai-btn-sm ai-btn-primary"
              disabled={!text.trim() || changes.isPending}
              data-testid="request-changes-send"
              onClick={async () => {
                try {
                  await changes.mutateAsync(undefined);
                  setMode(null);
                  toast.success('Sent back to the AI', `→ In Progress, run #${run.number + 1}`);
                } catch (err) {
                  toast.error("Couldn't request changes", extractError(err));
                }
              }}
            >
              Request changes
            </button>
          </div>
        </div>
      )}
      {undo && <UndoRunDialog run={run} onClose={() => setUndo(false)} />}
    </div>
  );
}
