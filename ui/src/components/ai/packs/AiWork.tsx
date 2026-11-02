import { useEffect, useRef, useState } from 'react';
import type { JobStep, ScanJob } from '../../../types/aiPacks';
import { clock, logTone } from './scanParts';
import { Ico } from './wizardIcons';

function StepIcon({ state }: { state: JobStep['state'] }) {
  if (state === 'done') return <Ico name="check" size={16} color="#2E6F40" sw={2.2} />;
  if (state === 'running') return <Ico name="refresh" size={16} color="#2F6FB0" sw={2.2} spin />;
  if (state === 'failed') return <Ico name="xcircle" size={16} color="#C4432A" sw={2.2} />;
  if (state === 'skipped') return <Ico name="dash" size={16} color="#B6C3BB" sw={2.2} />;
  return <Ico name="dot" size={16} color="#B6C3BB" sw={2.2} />;
}

/** The AI at work (design C1): what it did so far, how long, the live log, and Cancel. */
export function AiWork({ job, onCancel, cancelling }: { job: ScanJob; onCancel: () => void; cancelling: boolean }) {
  const [showLog, setShowLog] = useState(true);
  const logRef = useRef<HTMLDivElement>(null);
  const steps = job.steps ?? [];
  const log = job.log ?? [];
  const done = steps.filter((s) => s.state === 'done' || s.state === 'skipped').length;
  const running = steps.some((s) => s.state === 'running') ? 0.5 : 0;
  const pct = steps.length ? Math.max(4, Math.round(((done + running) / steps.length) * 100)) : 4;

  // the log follows its newest line
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log.length, showLog]);

  return (
    <div className="pk-work" data-testid="ai-work">
      <div className="pk-work-left">
        <div className="pk-work-title">
          <Ico name="sparkle" size={16} color="#2E6F40" sw={2} />
          <div style={{ flex: 1 }}>The AI is setting up the commands</div>
          <span className="ai-mono pk-work-clock" data-testid="work-clock">
            {clock(job.elapsedS)}
          </span>
        </div>
        <div
          className="pk-bar"
          role="progressbar"
          aria-label="Progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          <i style={{ width: `${pct}%` }} />
        </div>
        <div data-testid="work-steps">
          {steps.map((s) => (
            <div className="pk-step" key={s.key} data-state={s.state}>
              <span style={{ marginTop: 1 }}>
                <StepIcon state={s.state} />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className={s.state === 'waiting' ? 'pk-step-wait' : 'pk-step-label'}>{s.label}</div>
                {s.detail && s.state !== 'waiting' && <div className="ai-hint pk-step-detail">{s.detail}</div>}
              </div>
              {s.atS != null && <span className="ai-mono pk-step-at">{clock(s.atS)}</span>}
            </div>
          ))}
        </div>
        <div className="ai-hint">Usually 1 to 3 minutes. It stops by itself after 10.</div>
        <div className="pk-btns">
          <button type="button" className="ai-btn ai-btn-sm" disabled={cancelling} onClick={onCancel}>
            <Ico name="x" />
            Cancel
          </button>
          <button type="button" className="ai-btn ai-btn-sm" onClick={() => setShowLog(!showLog)}>
            <Ico name={showLog ? 'eyeoff' : 'eye'} />
            {showLog ? 'Hide the log' : 'Show the log'}
          </button>
        </div>
      </div>
      <div className="pk-work-right">
        {showLog && (
          <div className="pk-out pk-out-big">
            <div className="pk-out-head">
              <Ico name="terminal" size={12} color="#9DB3A5" sw={2} />
              <span className="ai-mono">full log · live</span>
            </div>
            <div className="pk-out-body pk-out-scroll" ref={logRef} data-testid="work-log">
              {log.map((l, i) => (
                <div key={i} className={`pk-log pk-log-${logTone(l)}`}>
                  {l}
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="pk-note">
          <span style={{ marginTop: 2 }}>
            <Ico name="sparkle" size={13} color="#2E6F40" sw={2} />
          </span>
          <div>
            <b>These are the repository’s own scripts.</b> They run in a temporary copy, with your user and network
            access, as in a terminal. The AI does not edit your checkout, push, or touch a ticket. The copy is deleted
            when it is done, whatever happened.
          </div>
        </div>
        <div className="ai-hint">You can close this window. It keeps going; open the wizard again to pick it up.</div>
      </div>
    </div>
  );
}
