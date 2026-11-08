import { useEffect, useState } from 'react';
import { aiApi, useAiMutation } from '../../api/ai';
import { extractError } from '../../api/extractError';
import type { AiSettings, AiTeam } from '../../types/ai';
import { useToast } from '../Toast';
import { PAUSE_COLOR, PauseGlyph, agoText, canResume, clockTime, pausedSummary, sentence } from './pausedUi';

/** The kill switch: Pause all AI stops every team of the project; Resume lifts it (design/screens/ai-paused.md). */

/** Esc closes a dialog like the other dialogs. */
function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
}

/** Top bar: the state is a label and the action a separate button, so reading the state never starts anything. */
export function PauseAllButton({
  projectId,
  settings,
  members,
}: {
  projectId: string;
  settings: AiSettings;
  members: AiTeam[];
}) {
  const [dialog, setDialog] = useState<'pause' | 'resume' | null>(null);
  const running = members.reduce((n, m) => n + m.slotsInUse, 0);
  const onePaused = members.filter((m) => m.paused).length;
  if (!members.length) return null;
  const since = clockTime(settings.pausedAt);
  return (
    <>
      {settings.pausedAll ? (
        <span className="ai-pausebar" data-testid="ai-paused-bar">
          <span className="ai-pausebar-wrap">
            <span
              className="ai-pausebar-label"
              tabIndex={0}
              aria-label={`AI paused${since ? ` since ${since}` : ''}. ${pausedSummary(settings)}`}
              title={pausedSummary(settings)}
              data-testid="ai-paused-label"
            >
              <PauseGlyph />
              AI paused
              {since && <span className="ai-pausebar-since">since {since}</span>}
            </span>
          </span>
          {canResume(settings) && (
            <button
              type="button"
              className="ai-pausebar-resume"
              onClick={() => setDialog('resume')}
              data-testid="ai-resume-all"
            >
              Resume…
            </button>
          )}
        </span>
      ) : (
        <>
          {onePaused > 0 && (
            <span
              className="ai-chip"
              style={{ background: '#FEF3D9', color: '#7A5A06', gap: 5 }}
              title="Paused on its own. The project is still working."
              data-testid="ai-one-paused"
            >
              <PauseGlyph size={11} color="#7A5A06" />
              {onePaused} team paused
            </span>
          )}
          <button
            type="button"
            className="ai-btn ai-btn-sm ai-btn-danger-outline"
            onClick={() => setDialog('pause')}
            data-testid="ai-pause-all"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="5" width="4" height="14" rx="1" />
              <rect x="14" y="5" width="4" height="14" rx="1" />
            </svg>
            Pause all AI
            {running > 0 && (
              <span className="ai-chip" style={{ height: 18, background: '#FBEEEA', color: '#C4432A' }}>
                {running} running
              </span>
            )}
          </button>
        </>
      )}
      {dialog === 'pause' && <PauseAllDialog projectId={projectId} running={running} onClose={() => setDialog(null)} />}
      {dialog === 'resume' && <ResumeAllDialog projectId={projectId} onClose={() => setDialog(null)} />}
    </>
  );
}

function PauseAllDialog({ projectId, running, onClose }: { projectId: string; running: number; onClose: () => void }) {
  const [cancelRunning, setCancelRunning] = useState(true);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const pause = useAiMutation(() => aiApi.pauseAll(projectId, { cancelRunning, reason: reason.trim() || undefined }));
  useEscape(onClose);
  return (
    <div className="ai-overlay" onClick={onClose}>
      <div
        className="ai-modal"
        style={{ width: 480 }}
        role="dialog"
        aria-modal="true"
        aria-label="Pause all AI"
        data-testid="pause-all-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ai-modal-head">
          <h2 className="ai-modal-title">Pause all AI for this project</h2>
          <div className="ai-hint">Nothing new starts, and every message to a team waits until you resume.</div>
        </div>
        <div className="ai-modal-body">
          <button
            type="button"
            className={`ai-option ${cancelRunning ? 'ai-option-active' : ''}`}
            onClick={() => setCancelRunning(true)}
          >
            <span className={`ai-radio ${cancelRunning ? 'ai-radio-on' : ''}`} />
            <span>
              <b style={{ fontSize: 13 }}>Cancel what is running now</b>
              <div className="ai-muted">
                {running ? `${running} run${running === 1 ? '' : 's'} stop at once.` : 'No run is working now.'} Files
                stay as they are.
              </div>
            </span>
          </button>
          <button
            type="button"
            className={`ai-option ${!cancelRunning ? 'ai-option-active' : ''}`}
            onClick={() => setCancelRunning(false)}
          >
            <span className={`ai-radio ${!cancelRunning ? 'ai-radio-on' : ''}`} />
            <span>
              <b style={{ fontSize: 13 }}>Let them finish</b>
              <div className="ai-muted">Runs already going end on their own; nothing new starts.</div>
            </span>
          </button>
          <label className="ai-field">
            <span className="ai-label ai-label-dark">Reason (optional)</span>
            <input
              className="ai-input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Shown on the banner"
              maxLength={200}
            />
          </label>
          {error && (
            <div className="ai-error-text" role="alert">
              Could not pause: {sentence(error)} Nothing was changed.
            </div>
          )}
        </div>
        <div className="ai-modal-foot">
          <span style={{ flex: 1 }} />
          <button type="button" className="ai-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="ai-btn ai-btn-danger"
            disabled={pause.isPending}
            data-testid="pause-all-confirm"
            onClick={async () => {
              try {
                await pause.mutateAsync(undefined);
                toast.success('AI paused', 'Nothing new starts until you resume.');
                onClose();
              } catch (err) {
                setError(extractError(err));
              }
            }}
          >
            Pause all AI
          </button>
        </div>
      </div>
    </div>
  );
}

/** Resume: lift the kill switch. */
export function ResumeAllDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const resume = useAiMutation(() => aiApi.resumeAll(projectId));
  useEscape(onClose);
  return (
    <div className="ai-overlay" onClick={onClose}>
      <div
        className="ai-modal"
        style={{ width: 440 }}
        role="dialog"
        aria-modal="true"
        aria-label="Resume AI"
        data-testid="resume-all-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ai-modal-head">
          <h2 className="ai-modal-title">Resume AI for this project</h2>
          <div className="ai-hint">Queued runs start again, in the order they were asked.</div>
        </div>
        {error && (
          <div className="ai-modal-body">
            <div className="ai-error-text" role="alert">
              {error}
            </div>
          </div>
        )}
        <div className="ai-modal-foot">
          <span style={{ flex: 1 }} />
          <button type="button" className="ai-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="ai-btn ai-btn-primary"
            disabled={resume.isPending}
            data-testid="resume-all-confirm"
            onClick={async () => {
              try {
                await resume.mutateAsync(undefined);
                toast.success('AI resumed', 'Queued runs start again.');
                onClose();
              } catch (err) {
                setError(extractError(err));
              }
            }}
          >
            Resume AI
          </button>
        </div>
      </div>
    </div>
  );
}

/** Banner shown on every screen while AI is paused for the project. */
export function AiPausedBanner({ settings }: { settings: AiSettings }) {
  const [dialog, setDialog] = useState(false);
  if (!settings.pausedAll) return null;
  const at = clockTime(settings.pausedAt);
  const ago = agoText(settings.pausedAt);
  return (
    <div className="ai-paused-banner" role="status" data-testid="ai-paused-banner">
      <div className="ai-paused-head">
        <span className="ai-paused-ico">
          <PauseGlyph size={14} />
        </span>
        <div className="ai-paused-title">
          <b>AI is paused</b>
          <span>
            {at ? `since ${at}` : ''}
            {ago && <span style={{ opacity: 0.8 }}> · {ago}</span>}
            {settings.pausedReason && <span style={{ opacity: 0.8 }}> · “{settings.pausedReason}”</span>}
          </span>
        </div>
        <span style={{ flex: 1 }} />
        {canResume(settings) && (
          <button
            type="button"
            className="ai-btn ai-btn-sm"
            data-testid="ai-banner-resume"
            style={{ color: PAUSE_COLOR }}
            onClick={() => setDialog(true)}
          >
            Resume…
          </button>
        )}
      </div>
      {dialog && <ResumeAllDialog projectId={settings.projectId} onClose={() => setDialog(false)} />}
    </div>
  );
}
