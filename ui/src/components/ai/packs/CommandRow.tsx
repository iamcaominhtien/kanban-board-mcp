import { useState, type Ref } from 'react';
import type { CommandName, ProposedCommand, TrialRun } from '../../../types/aiPacks';
import {
  CHECKS,
  ROW_NAME,
  ROW_PLACEHOLDER,
  ROW_ROLE,
  clock,
  failCounts,
  fmtSeconds,
  isBad,
  logTone,
  type RowKind,
} from './scanParts';
import { Ico } from './wizardIcons';

type Tone = 'ok' | 'bad' | 'warn' | 'grey' | 'run' | 'empty';

/** A status chip in the design's colours (D4). */
export function Chip({ tone, icon, children }: { tone: Tone; icon?: string; children: React.ReactNode }) {
  const color = { ok: '#1F5A31', bad: '#A5321E', warn: '#7A5A06', grey: '#5B6B60', run: '#244E78', empty: '#7F8F85' }[
    tone
  ];
  return (
    <span className={`ai-chip pk-c-${tone}`} data-tone={tone}>
      {icon && <Ico name={icon} size={11} color={color} sw={2.4} spin={tone === 'run'} />}
      {children}
    </span>
  );
}

/** The chip a row shows for what the board found. */
export function rowChip(
  name: CommandName,
  kind: RowKind,
  run: TrialRun | null | undefined,
  elapsed: number,
): React.ReactNode {
  switch (kind) {
    case 'empty':
      if (run?.status === 'not_run' && run.reason && run.reason !== 'empty')
        return (
          <Chip tone="grey" icon="dash">
            Not run · {run.reason}
          </Chip>
        );
      return (
        <Chip tone="empty" icon="dash">
          Empty
        </Chip>
      );
    case 'untried':
      return (
        <Chip tone="empty" icon="dot">
          Not tried yet
        </Chip>
      );
    case 'changed':
      return (
        <Chip tone="warn" icon="edit">
          Changed since the last run
        </Chip>
      );
    case 'works':
      return (
        <Chip tone="ok" icon="check">
          Works · {fmtSeconds(run?.seconds ?? 0)}
        </Chip>
      );
    case 'wrong':
      return (
        <Chip tone="bad" icon="xcircle">
          Command is wrong{run?.exitCode != null ? ` · exit ${run.exitCode}` : ''}
        </Chip>
      );
    case 'fails':
      return (
        <Chip tone="warn" icon="warn">
          Runs · {failWords(name)}
        </Chip>
      );
    case 'timeout':
      return (
        <Chip tone="warn" icon="clock">
          Timed out · {fmtSeconds(run?.seconds ?? 0)}
        </Chip>
      );
    case 'running':
      return (
        <Chip tone="run" icon="refresh">
          Running · {clock(elapsed)}
        </Chip>
      );
    case 'waiting':
      return (
        <Chip tone="grey" icon="clock">
          Waiting
        </Chip>
      );
    default:
      return (
        <Chip tone="grey" icon="dash">
          Not run{run?.reason ? ` · ${run.reason}` : ''}
        </Chip>
      );
  }
}

/** "the repo’s own tests fail" (design D4: the command is right, the repository fails). */
export function failWords(name: CommandName): string {
  if (name === 'test') return 'the repo’s own tests fail';
  if (name === 'lint') return 'the repo’s own lint fails';
  if (name === 'build') return 'the repo’s own build fails';
  return 'it exits with an error';
}

/** The sentence under a row's chip. */
function sentence(name: CommandName, kind: RowKind, run: TrialRun | null | undefined): string {
  if (kind === 'works') return `Run by the board, the way a ticket runs it. Exit ${run?.exitCode ?? 0}.`;
  if (kind === 'wrong') return 'This is a mistake in the command, not in the repo.';
  if (kind === 'fails') {
    const c = name === 'test' ? failCounts(run?.tail ?? []) : null;
    return c
      ? `The command is right. ${c.failed} of ${c.total} tests fail inside the repository.`
      : `The command is right. The repository fails it${run?.exitCode != null ? ` (exit ${run.exitCode})` : ''}.`;
  }
  if (kind === 'changed') return 'The proof belongs to the old text.';
  if (kind === 'timeout') return 'The command did not finish in time. It may be waiting for input, or just slow.';
  if (kind === 'untried') return 'Run it to see if it works.';
  return '';
}

/** The dark output box: the last lines of a run, all of them on a click. */
function OutBox({ tail, full, onToggle }: { tail: string[]; full: boolean; onToggle: () => void }) {
  const long = tail.length > 5;
  const lines = full || !long ? tail : tail.slice(-5);
  const head = (
    <>
      <Ico name="terminal" size={12} color="#9DB3A5" sw={2} />
      <span className="ai-mono">
        {long ? (full ? 'all lines · click to fold' : 'last lines · click to see all') : 'last lines'}
      </span>
    </>
  );
  return (
    <div className="pk-out" data-testid="row-output">
      {long ? (
        <button type="button" className="pk-out-head" onClick={onToggle} aria-expanded={full}>
          {head}
        </button>
      ) : (
        <div className="pk-out-head">{head}</div>
      )}
      <div className="pk-out-body">
        {lines.map((l, i) => (
          <div key={i} className={`pk-log pk-log-${logTone(l)}`}>
            {l}
          </div>
        ))}
      </div>
    </div>
  );
}

/** One command: label, editable box, where it came from, the board's run and what the person can do (design D1-D4). */
export function CommandRow({
  name,
  text,
  onText,
  inputRef,
  kind,
  run,
  proposed,
  compact,
  elapsed,
  busy,
  aiAvailable,
  checkOn,
  onCheck,
  onRun,
  onFix,
  onLeaveEmpty,
  onCancel,
}: {
  name: CommandName;
  text: string;
  onText: (v: string) => void;
  inputRef?: Ref<HTMLInputElement>;
  kind: RowKind;
  run: TrialRun | null | undefined;
  proposed: ProposedCommand | undefined;
  /** The short layout of E2/E3: label, box and chip only. */
  compact: boolean;
  /** Seconds the running command has been going. */
  elapsed: number;
  /** A job is running: Run is not offered. */
  busy: boolean;
  aiAvailable: boolean;
  /** For test, lint and build: is it used as a check. */
  checkOn: boolean;
  onCheck: (on: boolean) => void;
  onRun: () => void;
  onFix: () => void;
  onLeaveEmpty: () => void;
  onCancel: () => void;
}) {
  const [showOut, setShowOut] = useState(false);
  const [full, setFull] = useState(false);
  const bad = isBad(kind);
  const isCheck = (CHECKS as CommandName[]).includes(name);
  const tail = run?.tail ?? [];
  const typed = !!proposed && text.trim() !== proposed.command;
  const inCls = `ai-input pk-cmd${kind === 'wrong' ? ' pk-in-bad' : ''}${kind === 'changed' ? ' pk-in-changed' : ''}`;
  const input = (
    <input
      ref={inputRef}
      className={inCls}
      aria-label={`${ROW_NAME[name]} command`}
      placeholder={ROW_PLACEHOLDER[name]}
      value={text}
      spellCheck={false}
      onChange={(e) => onText(e.target.value)}
    />
  );

  if (compact)
    return (
      <div className="pk-crow" data-testid={`row-${name}`} data-kind={kind}>
        <b>{ROW_NAME[name]}</b>
        {input}
        <div>{rowChip(name, kind, run, elapsed)}</div>
      </div>
    );

  const src = proposed?.source?.trim();
  const showOutput = tail.length > 0 && (kind === 'wrong' || kind === 'fails' || kind === 'timeout' || showOut);
  const canRun = !busy && kind !== 'empty' && kind !== 'running' && kind !== 'waiting';
  return (
    <div
      className={`pk-row${kind === 'fails' ? ' pk-row-fails' : ''}${kind === 'wrong' ? ' pk-row-wrong' : ''}`}
      data-testid={`row-${name}`}
      data-kind={kind}
    >
      <div>
        <div className="pk-row-name">{ROW_NAME[name]}</div>
        <div className="ai-hint pk-row-role">{ROW_ROLE[name]}</div>
      </div>
      <div className="pk-row-mid">
        {input}
        {typed ? (
          <span className="pk-from">
            <Ico name="edit" size={12} color="#5B6B60" />
            Typed by you
          </span>
        ) : (
          src && (
            <span className="pk-from">
              <Ico name="file" size={12} color="#5B6B60" />
              {/^from\b/i.test(src) ? src : `From ${src}`}
            </span>
          )
        )}
        {showOutput && <OutBox tail={tail} full={full} onToggle={() => setFull(!full)} />}
        {proposed?.note && !typed && (
          <div className="pk-note" data-testid={`note-${name}`}>
            <span style={{ marginTop: 2 }}>
              <Ico name="sparkle" size={13} color="#2E6F40" sw={2} />
            </span>
            <div>{proposed.note}</div>
          </div>
        )}
      </div>
      <div className="pk-row-side">
        {rowChip(name, kind, run, elapsed)}
        {sentence(name, kind, run) && <div className="ai-hint">{sentence(name, kind, run)}</div>}
        {kind === 'wrong' && run?.reason && <div className="ai-hint">{run.reason}</div>}
        <div className="pk-btns">
          {canRun && (
            <button type="button" className="ai-btn ai-btn-sm" onClick={onRun} aria-label={`Run ${name}`}>
              <Ico name="play" />
              Run
            </button>
          )}
          {kind === 'running' && (
            <button type="button" className="ai-btn ai-btn-sm" onClick={onCancel}>
              <Ico name="x" />
              Cancel
            </button>
          )}
          {kind === 'works' && tail.length > 0 && (
            <button
              type="button"
              className="ai-btn ai-btn-sm"
              onClick={() => setShowOut(!showOut)}
              aria-expanded={showOut}
            >
              <Ico name={showOut ? 'up' : 'down'} />
              Output
            </button>
          )}
          {kind === 'fails' && tail.length > 0 && (
            <button
              type="button"
              className="ai-btn ai-btn-sm"
              onClick={() => {
                setShowOut(true);
                setFull(true);
              }}
            >
              See all failures
            </button>
          )}
          {kind === 'wrong' && aiAvailable && !busy && (
            <button type="button" className="ai-btn ai-btn-primary ai-btn-sm" onClick={onFix}>
              <Ico name="sparkle" />
              Ask the AI to fix
            </button>
          )}
          {kind === 'wrong' && isCheck && !busy && (
            <button type="button" className="ai-btn ai-btn-sm" onClick={onLeaveEmpty}>
              Leave {name} empty for now
            </button>
          )}
        </div>
        {bad && isCheck && (
          <div className="pk-choice" role="radiogroup" aria-label={`${ROW_NAME[name]} as a check`}>
            <label className={`pk-choice-opt${checkOn ? ' pk-choice-on' : ''}`}>
              <input
                type="radio"
                name={`check-${name}`}
                checked={checkOn}
                onChange={() => onCheck(true)}
                aria-label={`Use ${name} as a check`}
              />
              <span>
                <b>Use as a check.</b>{' '}
                {kind === 'fails'
                  ? (() => {
                      const c = name === 'test' ? failCounts(tail) : null;
                      return `Every ticket is sent back to Dev until ${c ? `these ${c.failed} tests` : 'the repository'} pass${c ? '' : 'es'}.`;
                    })()
                  : 'Every ticket is sent back to Dev until the command is fixed.'}
              </span>
            </label>
            <label className={`pk-choice-opt${!checkOn ? ' pk-choice-on' : ''}`}>
              <input
                type="radio"
                name={`check-${name}`}
                checked={!checkOn}
                onChange={() => onCheck(false)}
                aria-label={`Keep ${name}, but not as a check yet`}
              />
              <span>
                <b>Keep it, but not as a check yet.</b> The command stays saved and the check step leaves it out.{' '}
                <i>Suggested.</i>
              </span>
            </label>
          </div>
        )}
      </div>
    </div>
  );
}
