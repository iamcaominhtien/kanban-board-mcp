import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  askAi,
  boardFileUrl,
  canvasFailure,
  canvasKeys,
  decideProposal,
  fetchAiJob,
  useCanvasProposals,
  type AiJob,
  type CanvasBoard,
  type CanvasProposal,
  type ProposalChange,
} from '../../api/canvases';
import { resolveOrigin } from '../../api/resolveOrigin';
import { actorName } from '../../utils/relativeTime';
import { useToast } from '../Toast';
import { CanvasIcon } from './CanvasIcon';
import { diffCounts, lineDiff } from './lineDiff';
import styles from './Canvas.module.css';

/** A job the editor shows as a purple ribbon on the boards it works on. */
export interface WorkingJob {
  jobId: string;
  boardIds: string[];
  who: string;
}

interface AskProps {
  canvasId: string;
  boards: CanvasBoard[];
  initialPrompt?: string;
  onClose: () => void;
  onStarted: (job: WorkingJob) => void;
  onFinished: (jobId: string, job: AiJob) => void;
}

/**
 * "Ask AI about" the selected boards (Ctrl J): say what you want, and an AI member prepares a proposal. While it works
 * the boards show a purple ribbon and stay usable.
 * @param props - The canvas, the selected boards and what to do as the job moves.
 */
export function AskAiPanel({ canvasId, boards, initialPrompt = '', onClose, onStarted, onFinished }: AskProps) {
  const [text, setText] = useState(initialPrompt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => area.current?.focus(), []);
  const editable = boards.filter((b) => b.kind === 'html' || b.kind === 'empty');
  const send = async () => {
    if (!text.trim() || busy || !editable.length) return;
    setBusy(true);
    setError(null);
    try {
      const job = await askAi(canvasId, { boardIds: editable.map((b) => b.id), request: text.trim() });
      onStarted({ jobId: job.id, boardIds: editable.map((b) => b.id), who: 'AI' });
      void poll(job.id, onFinished);
      onClose();
    } catch (e) {
      const f = canvasFailure(e);
      const detail = (e as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
      setError(typeof detail === 'string' ? detail : f.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`${styles.root} ${styles.aiPanel}`} role="dialog" aria-label="Ask AI" data-testid="canvas-ai-panel">
      <div className={styles.aiHead}>
        <CanvasIcon name="spark" size={16} /> Ask AI
        <span>about</span>
        {boards.map((b) => (
          <span key={b.id} className={styles.aiAbout}>
            + {b.name}
          </span>
        ))}
        <span className={styles.spacer} />
        <button type="button" className={styles.iconBtn} aria-label="Close" onClick={onClose}>
          <CanvasIcon name="close" size={14} />
        </button>
      </div>
      <textarea
        ref={area}
        className={styles.input}
        rows={3}
        value={text}
        placeholder="Move the error under the password field and show it in red on both boards."
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send();
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
        data-testid="canvas-ai-text"
      />
      {error && (
        <div role="alert" style={{ color: '#a93822', fontSize: 13, marginTop: 6 }} data-testid="canvas-ai-error">
          {error}
        </div>
      )}
      {!editable.length && (
        <div className={styles.hint}>Pick at least one HTML or empty frame. AI proposes changes to HTML frames.</div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
        <span className={styles.hint}>Proposes a new version. Nothing changes until you accept.</span>
        <span className={styles.spacer} />
        <button
          type="button"
          className={`${styles.btn} ${styles.btnPrimary}`}
          disabled={!text.trim() || busy || !editable.length}
          onClick={() => void send()}
          data-testid="canvas-ai-send"
        >
          <CanvasIcon name="send" size={14} /> {busy ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  );
}

async function poll(jobId: string, done: (id: string, job: AiJob) => void) {
  for (let i = 0; i < 160; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const job = await fetchAiJob(jobId);
      if (job.state === 'finished' || job.state === 'failed' || job.state === 'cancelled') {
        done(jobId, job);
        return;
      }
    } catch {
      /* keep trying */
    }
  }
}

interface ReviewProps {
  canvasId: string;
  /** The version a person's accept will make. */
  onAccepted: () => void;
  onClose: () => void;
  canDecide: boolean;
  proposalId?: string | null;
}

/**
 * The proposal: before and after of each board the AI would change, with Accept both, Accept one, Reject and Compare
 * in source. Accepted boards save as one new version. A board somebody is editing waits: the AI never takes a lock.
 * @param props - The canvas and what to do when a decision is made.
 */
export function ProposalReview({ canvasId, onAccepted, onClose, canDecide, proposalId }: ReviewProps) {
  const q = useCanvasProposals(canvasId);
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [src, setSrc] = useState<Record<string, boolean>>({});
  const proposals = q.data ?? [];
  const p: CanvasProposal | undefined = proposals.find((x) => x.id === proposalId) ?? proposals[0];
  const open = p?.changes.filter((c) => c.status === 'open' || c.status === 'stale') ?? [];

  const decide = async (accept: string[] | 'all', reject?: string[] | 'rest' | 'all') => {
    if (!p) return;
    setBusy(true);
    setError(null);
    try {
      const out = await decideProposal(canvasId, p.id, { accept, reject });
      void qc.invalidateQueries({ queryKey: canvasKeys.proposals(canvasId) });
      void qc.invalidateQueries({ queryKey: canvasKeys.versions(canvasId) });
      const accepted = out.changes.filter((c) => c.status === 'accepted').length;
      if (accepted)
        toast.success(
          'Saved as a new version',
          `Version ${out.version}: ${accepted} board${accepted === 1 ? '' : 's'} changed.`,
        );
      onAccepted();
      if (out.status !== 'open') onClose();
    } catch (e) {
      const f = canvasFailure(e);
      setError(f.message);
    } finally {
      setBusy(false);
    }
  };

  if (!p) return null;
  const waiting = open.find((c) => c.waitingFor);
  return (
    <div
      className={`${styles.root} ${styles.proposal}`}
      data-testid="canvas-proposal"
      role="dialog"
      aria-label="AI proposal"
    >
      <div className={styles.proposalCard}>
        <div className={styles.drawerHead}>
          <CanvasIcon name="spark" size={16} />
          <span style={{ color: '#5b3aa6' }}>
            {actorName(p.author)} proposes a change to {p.changes.length} board{p.changes.length === 1 ? '' : 's'}
          </span>
          <span className={styles.spacer} />
          <button type="button" className={styles.iconBtn} aria-label="Close" onClick={onClose}>
            <CanvasIcon name="close" size={14} />
          </button>
        </div>
        <div className={styles.proposalBody}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 6 }}>
            <span className={styles.chip} style={{ background: '#efe8fb', color: '#5b3aa6' }}>
              Proposal
            </span>
            <span className={styles.hint}>Version {p.nextVersion} · nothing is saved yet</span>
          </div>
          {p.note && <div style={{ marginBottom: 10 }}>{p.note}</div>}
          {p.request && <div className={styles.hint}>Asked: “{p.request}”</div>}
          {waiting && (
            <div
              className={`${styles.bannerWarn}`}
              style={{ margin: '10px 0', padding: 12, border: '1px solid #f1d98a', borderRadius: 10 }}
              data-testid="canvas-ai-waiting"
            >
              <b>
                {actorName(p.author)} is waiting for {waiting.name}
              </b>
              <div style={{ fontSize: 13 }}>
                {waiting.waitingFor} is editing it. The proposal is prepared and kept, and can be accepted when the lock
                ends. AI members never take a lock from a person.
              </div>
            </div>
          )}
          {error && (
            <div role="alert" style={{ color: '#a93822', margin: '8px 0' }} data-testid="canvas-proposal-error">
              {error}
            </div>
          )}
          {p.changes.map((ch) => (
            <ChangeView
              key={ch.boardId}
              canvasId={canvasId}
              ch={ch}
              showSource={!!src[ch.boardId]}
              onToggleSource={() => setSrc((s) => ({ ...s, [ch.boardId]: !s[ch.boardId] }))}
              onAccept={
                canDecide && ch.status === 'open' && !ch.waitingFor
                  ? () => void decide([ch.boardId], 'rest')
                  : undefined
              }
              busy={busy}
            />
          ))}
          <div className={styles.hint}>
            Not touched: the other boards, notes and comments. Accepting saves a new version you can restore.
          </div>
        </div>
        <div className={styles.dialogFoot}>
          {canDecide && open.length > 0 && (
            <>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnPrimary}`}
                disabled={busy || !!waiting || open.every((c) => c.status === 'stale')}
                onClick={() => void decide('all')}
                data-testid="canvas-proposal-accept-all"
              >
                Accept {open.length > 1 ? 'both' : ''}
              </button>
              <button
                type="button"
                className={styles.btn}
                disabled={busy}
                onClick={() => void decide([], 'all')}
                data-testid="canvas-proposal-reject"
              >
                Reject
              </button>
            </>
          )}
          <button type="button" className={styles.btn} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function ChangeView({
  canvasId,
  ch,
  showSource,
  onToggleSource,
  onAccept,
  busy,
}: {
  canvasId: string;
  ch: ProposalChange;
  showSource: boolean;
  onToggleSource: () => void;
  onAccept?: () => void;
  busy: boolean;
}) {
  const beforeUrl = ch.baseRev != null ? boardFileUrl(canvasId, ch.boardId, ch.baseRev, ch.entry) : null;
  const afterUrl = ch.entryUrlAfter ? `${resolveOrigin()}${ch.entryUrlAfter}` : null;
  const diffs = useMemo(() => {
    const before = ch.before ?? [];
    const after = ch.after ?? [];
    return after
      .map((f) => ({ path: f.path, rows: lineDiff(before.find((x) => x.path === f.path)?.text ?? '', f.text) }))
      .filter((d) => diffCounts(d.rows).added + diffCounts(d.rows).removed > 0);
  }, [ch.before, ch.after]);
  return (
    <div className={styles.proposalChange} data-testid="canvas-change">
      <div className={styles.proposalChangeHead}>
        {ch.name}
        <span className={styles.hint}>
          · {ch.lines} line{ch.lines === 1 ? '' : 's'}
        </span>
        <span className={`${styles.state} ${ch.status === 'stale' ? styles.stateRemoved : styles.stateChanged}`}>
          {ch.status === 'stale' ? 'Changed since' : 'Changed'}
        </span>
        {ch.blocked.length > 0 && <span className={styles.hint}>scripts and outside addresses were removed</span>}
        <span className={styles.spacer} />
        <button type="button" className={`${styles.btn} ${styles.btnSm}`} onClick={onToggleSource}>
          Compare in source
        </button>
        {onAccept && (
          <button type="button" className={`${styles.btn} ${styles.btnSm}`} disabled={busy} onClick={onAccept}>
            Accept this one
          </button>
        )}
      </div>
      {ch.status === 'stale' && (
        <div className={styles.hint} style={{ padding: 10 }}>
          {ch.name} changed since this proposal was made. Ask the AI again.
        </div>
      )}
      <div className={styles.beforeAfter}>
        <div className={styles.baPane}>
          <span className={styles.baLabel}>Before</span>
          {beforeUrl ? (
            <iframe
              className={styles.baFrame}
              title={`${ch.name} before`}
              src={beforeUrl}
              sandbox=""
              referrerPolicy="no-referrer"
            />
          ) : (
            <div className={styles.baFrame} />
          )}
        </div>
        <div className={styles.baPane}>
          <span className={styles.baLabel}>After</span>
          {afterUrl ? (
            <iframe
              className={styles.baFrame}
              title={`${ch.name} after`}
              src={afterUrl}
              sandbox=""
              referrerPolicy="no-referrer"
              data-testid="canvas-after-frame"
            />
          ) : (
            <div className={styles.baFrame} />
          )}
        </div>
      </div>
      {showSource &&
        diffs.map((d) => (
          <pre key={d.path} className={styles.diffBox} data-testid="canvas-source-diff">
            <b style={{ color: '#9db3a5' }}>{d.path}</b>
            {'\n'}
            {d.rows.map((r, i) => (
              <span key={i} className={r.t === '+' ? styles.diffAdd : r.t === '-' ? styles.diffDel : undefined}>
                {r.t} {r.s}
                {'\n'}
              </span>
            ))}
          </pre>
        ))}
    </div>
  );
}
