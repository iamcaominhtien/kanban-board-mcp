import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { aiApi, aiKeys } from '../../../api/ai';
import { aiOpsApi } from '../../../api/aiOps';
import { extractError } from '../../../api/extractError';
import type { AiRun } from '../../../types/ai';
import { openRun } from '../../aiteam/runLink';
import { ContinueNoteDialog } from './ContinueNoteDialog';
import { HandToDialog } from './HandToDialog';
import { TROUBLE_LABELS, isTroubleAction, liveDiagnosis, processWords, troubleTitle } from './troubleUi';
import './trouble.css';

type Dialog = 'note' | 'hand' | null;

/** One line of the card: an icon word, a bold lead and the text. */
function Line({ lead, tone, children }: Readonly<{ lead: string; tone?: 'amber' | 'grey'; children: string }>) {
  return (
    <div className="tc-line">
      <span className={`tc-mark tc-mark-${tone ?? 'amber'}`} aria-hidden="true" />
      <div>
        <b>{lead}.</b> {children}
      </div>
    </div>
  );
}

/**
 * An AI in trouble (design/screens/ai-operations.md, C): what the board found, what it means, what was already tried
 * and the actions the diagnosis allows. Shows only for a diagnosis that has not cleared.
 */
export function TroubleCard({ run }: Readonly<{ run: AiRun }>) {
  const qc = useQueryClient();
  const d = liveDiagnosis(run);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  if (!d) return null;

  const refresh = () => void qc.invalidateQueries({ queryKey: aiKeys.all });
  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    setError(null);
    setSaid(null);
    try {
      const out = await fn();
      const text = (out as { text?: string } | undefined)?.text;
      if (text) setSaid(text);
      refresh();
    } catch (err) {
      setError(extractError(err));
    } finally {
      setBusy(null);
    }
  };
  const run1 = (id: string) => {
    if (id === 'continue_note') return setDialog('note');
    if (id === 'hand_to') return setDialog('hand');
    if (id === 'retry') return act(id, () => aiApi.retry(run.id));
    if (isTroubleAction(id)) return act(id, () => aiOpsApi.trouble(run.id, id));
    return undefined;
  };
  const ways = d.actions.filter((a) => a in TROUBLE_LABELS);
  const facts = processWords(d);
  const tried = d.tried.length > 0 ? d.tried.join(' ') : 'Nothing. This is the first time this run stopped moving.';

  return (
    <div className="tc-card" data-testid="trouble-card">
      <div className="tc-head">
        <div className="tc-headtext">
          <div className="tc-title">{troubleTitle(d, run.memberName ?? 'The AI')}</div>
          <div className="ai-muted">
            On {run.ticketId} · step {run.steps.length}
            {facts ? ` · ${facts}` : ''}
          </div>
        </div>
        <span className={`tc-chip ${d.boardFault ? 'tc-chip-fault' : ''}`}>
          {d.boardFault ? 'Board fault' : 'Diagnosed'}
        </span>
      </div>
      <hr className="tc-rule" />
      <Line lead="What the board found">{d.what}</Line>
      <Line lead="What that means">{d.means}</Line>
      <Line lead="Already tried" tone="grey">
        {tried}
      </Line>
      <div className="tc-actions">
        {ways.map((a, i) => (
          <button
            key={a}
            type="button"
            className={`ai-btn ai-btn-sm ${i === 0 ? 'ai-btn-primary' : ''}`}
            disabled={busy !== null}
            data-testid={`trouble-${a}`}
            onClick={() => void run1(a)}
          >
            {TROUBLE_LABELS[a]}
          </button>
        ))}
        <button type="button" className="ai-btn ai-btn-sm" onClick={() => openRun(run.id)} data-testid="trouble-open">
          Open the run
        </button>
      </div>
      {d.actions.includes('stop_child') && (
        <div className="ai-hint">
          Stopping the command ends that child process only. The run goes on from step {run.steps.length} and is told
          what happened.
        </div>
      )}
      {said && (
        <div className="ai-hint" role="status">
          {said}
        </div>
      )}
      {error && (
        <div className="ai-error-text" role="alert">
          {error}
        </div>
      )}
      {dialog === 'note' && (
        <ContinueNoteDialog
          ended={false}
          onSubmit={async (note) => {
            await aiOpsApi.continueWith(run.id, note);
            refresh();
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'hand' && (
        <HandToDialog
          projectId={run.projectId}
          currentMemberId={run.memberId}
          onSubmit={async (memberId, note) => {
            await aiOpsApi.handTo(run.id, memberId, note);
            refresh();
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
