import { useEffect, useRef, useState } from 'react';
import type { CommandName, JobStep, ScanJob } from '../../../types/aiPacks';
import { LineIcon, type LineIconName } from '../../ui/LineIcon';
import { useNow } from '../aiUi';
import { COMMAND_TITLE, clock, jobPill, sourceParts, type RowKind, type RowView } from './repoCommandsLogic';

const CHIP_ICON: Partial<Record<RowKind, LineIconName>> = {
  works: 'check',
  fails: 'warning',
  wrong: 'close',
  timeout: 'clock',
  running: 'refresh',
  changed: 'edit',
};

const STEP_AFTER_END: Record<JobStep['state'], JobStep['state']> = {
  done: 'done',
  running: 'failed',
  waiting: 'skipped',
  failed: 'failed',
  skipped: 'skipped',
};

const STEP_ICON: Record<JobStep['state'], React.ReactNode> = {
  done: <LineIcon name="check" size={13} />,
  running: <span className="rc-dot rc-dot-on" />,
  waiting: <span className="rc-dot" />,
  failed: <LineIcon name="close" size={13} />,
  skipped: <span className="rc-dot rc-dot-skip" />,
};

/** The strip: which step the job is on, how long it has taken and Stop (design B, frames 4 and 5). */
export function ScanStrip({ job, onStop }: { job: ScanJob; onStop: () => void }) {
  const pill = jobPill(job.state);
  const title = job.mode === 'ai' ? 'The AI is setting up the commands' : 'The board is running the commands';
  return (
    <div className="rc-strip" data-testid="rc-strip" data-state={job.state}>
      <div className="rc-strip-head">
        <LineIcon name="sparkle" size={15} />
        <b>{title}</b>
        <span className={`rc-pill rc-pill-${pill.tone}`}>{pill.label}</span>
        <span className="ai-mono rc-clock">{clock(job.elapsedS)}</span>
        <span style={{ flex: 1 }} />
        {job.state === 'running' && (
          <button type="button" className="ai-btn ai-btn-sm" data-testid="rc-stop" onClick={onStop}>
            <LineIcon name="square" size={12} /> Stop
          </button>
        )}
      </div>
      <div
        className="rc-steps"
        style={{ gridTemplateColumns: `repeat(${Math.max(job.steps.length, 1)}, minmax(0, 1fr))` }}
      >
        {job.steps.map((raw) => {
          // a job that ended (or was lost in a restart) leaves no step live or waiting
          const s = job.state === 'running' ? raw : { ...raw, state: STEP_AFTER_END[raw.state] };
          return (
            <div key={s.key} className={`rc-step rc-step-${s.state}`} data-testid={`rc-step-${s.key}`}>
              <span className="rc-step-icon">{STEP_ICON[s.state]}</span>
              <div>
                <div className="rc-step-label">{s.label}</div>
                {s.detail && <div className="rc-step-detail">{s.detail}</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** What the AI and the board are doing, live: the job's log, newest line last. */
export function ScanLog({ lines, mode }: { lines: string[]; mode: ScanJob['mode'] }) {
  const box = useRef<HTMLPreElement>(null);
  // follow the newest line inside the box only: scrolling the page itself would pull Settings away from the person
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines.length]);
  return (
    <>
      <div className="rc-log" data-testid="rc-log">
        <div className="rc-log-head">
          <LineIcon name="frame" size={12} /> what the {mode === 'ai' ? 'AI' : 'board'} is doing · live
        </div>
        <pre ref={box}>{lines.slice(-40).join('\n')}</pre>
      </div>
      <div className="ai-hint">
        Closing this page does not stop it: it is a job on the server. Come back and the strip is where it was.
      </div>
    </>
  );
}

function Elapsed() {
  const start = useRef(Date.now());
  const now = useNow(1000, true);
  return <> · {clock((now - start.current) / 1000)}</>;
}

/** One command: its box, where it came from, the status the server decided and the last lines of the output. */
export function CommandRow({
  name,
  text,
  view,
  source,
  proven,
  disabled,
  canFix,
  onAi,
  pathNote,
  onChange,
  onRun,
  onFix,
}: {
  name: CommandName;
  text: string;
  view: RowView;
  source?: string;
  /** The text in the box is the one the board ran. */
  proven: boolean;
  disabled: boolean;
  canFix: boolean;
  /** Run the AI again (the row of a command that was not run because the AI ran out of time). */
  onAi: () => void;
  /** Why a command that was not found is probably the PATH, when the AI found the folder. */
  pathNote?: string | null;
  onChange: (v: string) => void;
  onRun: () => void;
  onFix: () => void;
}) {
  const [showAll, setShowAll] = useState<boolean | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const hasOutput = view.tail.length > 0;
  const open = showAll ?? (hasOutput && (view.kind === 'fails' || view.kind === 'wrong'));
  const src = proven ? sourceParts(source) : null;
  const running = view.kind === 'running';
  return (
    <div className={`rc-row rc-row-${view.kind}`} data-testid={`rc-row-${name}`} data-kind={view.kind}>
      <div className="rc-row-name">
        <b>{COMMAND_TITLE[name]}</b>
        {name === 'prepare' && <span className="ai-hint">once per worktree</span>}
      </div>
      <div className="rc-row-main">
        <input
          ref={input}
          className={`ai-input ai-mono rc-box ${view.kind === 'changed' ? 'rc-box-changed' : ''} ${view.kind === 'wrong' ? 'rc-box-wrong' : ''}`}
          aria-label={`${COMMAND_TITLE[name]} command`}
          data-testid={name === 'prepare' ? 'wt-prepare' : `cmd-${name}`}
          value={text}
          placeholder={
            name === 'prepare'
              ? 'npm ci && uv sync'
              : name === 'test'
                ? 'npm test'
                : name === 'lint'
                  ? 'npm run lint'
                  : 'npm run build'
          }
          onChange={(e) => onChange(e.target.value)}
        />
        {src && (
          <div className="rc-source">
            <LineIcon name="page" size={12} /> From <span className="ai-code">{src.file}</span>
            {src.rest && <span> {src.rest}</span>}
          </div>
        )}
        {view.kind === 'changed' && <div className="rc-edited">You edited this box after it was proven.</div>}
        {open && hasOutput && (
          <pre className="rc-out" data-testid={`rc-out-${name}`}>
            <span className="rc-out-head">last lines</span>
            {view.tail.join('\n')}
          </pre>
        )}
        {(open || view.kind === 'wrong') && (view.note ?? pathNote) && (
          <div className="rc-note">{view.note ?? pathNote}</div>
        )}
      </div>
      <div className="rc-row-status">
        <span className={`ai-chip rc-chip rc-chip-${view.kind}`} data-testid={`rc-chip-${name}`}>
          {CHIP_ICON[view.kind] && <LineIcon name={CHIP_ICON[view.kind]!} size={11} />}
          {view.chip}
          {running && <Elapsed />}
        </span>
        {view.sub && <div className="rc-row-sub">{view.sub}</div>}
        <div className="rc-row-actions">
          {view.kind === 'wrong' && canFix && (
            <button type="button" className="ai-btn ai-btn-sm ai-btn-primary" disabled={disabled} onClick={onFix}>
              <LineIcon name="sparkle" size={12} /> Ask the AI to fix
            </button>
          )}
          {view.kind !== 'empty' && !running && (
            <button
              type="button"
              className="ai-btn ai-btn-sm"
              disabled={disabled}
              data-testid={`rc-run-${name}`}
              onClick={onRun}
            >
              <LineIcon name="play" size={11} />
              {view.kind === 'untried' || view.kind === 'waiting' || view.kind === 'not_run'
                ? 'Run'
                : view.kind === 'changed'
                  ? 'Run this one again'
                  : 'Run again'}
            </button>
          )}
          {view.kind === 'not_run' && view.sub && canFix && (
            <button type="button" className="ai-btn ai-btn-sm" disabled={disabled} onClick={onAi}>
              <LineIcon name="sparkle" size={12} /> Run the AI again
            </button>
          )}
          {view.kind === 'empty' && (
            <button type="button" className="ai-btn ai-btn-sm" onClick={() => input.current?.focus()}>
              Type one
            </button>
          )}
          {hasOutput && (
            <button type="button" className="ai-btn ai-btn-sm" onClick={() => setShowAll(!open)}>
              {open ? 'Hide output' : 'Output'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
