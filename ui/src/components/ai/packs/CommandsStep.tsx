import { useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useScanJob } from '../../../api/aiPacks';
import { extractError } from '../../../api/extractError';
import type { CheckName, CommandName, EnvFolder, Scan } from '../../../types/aiPacks';
import { AiWork } from './AiWork';
import { CommandRow } from './CommandRow';
import { EnvBlock } from './EnvBlock';
import { COMMANDS, fmtSeconds, isBad, jobOf, proposalOf } from './scanParts';
import { isCheckOn, isDecided, kindsOf, textsOf, withChoice, type Draft } from './wizardDraft';
import { Ico } from './wizardIcons';

/** Step 3 shows the choice, or the commands as boxes with the board's runs. */
export type CmdLook = 'choose' | 'result';

const WORD = ['No', 'One', 'Two', 'Three', 'Four'];

function Bullet({ icon, color = '#2E6F40', children }: { icon: string; color?: string; children: ReactNode }) {
  return (
    <div className="pk-bullet">
      <span style={{ flex: 'none', marginTop: 3 }}>
        <Ico name={icon} color={color} sw={2} />
      </span>
      <div>{children}</div>
    </div>
  );
}

function Banner({
  tone,
  icon,
  title,
  children,
  testId,
}: {
  tone: 'ok' | 'warn' | 'err';
  icon: string;
  title: string;
  children?: ReactNode;
  testId: string;
}) {
  const color = { ok: '#2E6F40', warn: '#B8860B', err: '#C4432A' }[tone];
  return (
    <div className={`pk-banner pk-banner-${tone}`} data-testid={testId} role="status">
      <Ico name={icon} size={17} color={color} sw={2} />
      <div style={{ flex: 1 }}>
        <div className="pk-banner-title">{title}</div>
        {children && <div className="ai-hint pk-banner-body">{children}</div>}
      </div>
    </div>
  );
}

/**
 * Step 3 · Commands (design/screens/ai-repo-commands.md, B to E): choose how the commands get set, watch the AI work,
 * then one row per command with the board's own run of it.
 */
export function CommandsStep({
  scan,
  draft,
  setDraft,
  look,
  setLook,
  onBack,
  onContinue,
  onRecheck,
  footSlot,
}: {
  scan: Scan;
  draft: Draft;
  setDraft: (f: (d: Draft) => Draft) => void;
  look: CmdLook;
  setLook: (l: CmdLook) => void;
  onBack: () => void;
  onContinue: () => void;
  /** The wizard's footer: when given, the action row is drawn there (one footer row, design B–D). */
  footSlot?: HTMLElement | null;
  onRecheck: () => void;
}) {
  const { startAi, tryCommands, cancel } = useScanJob();
  const [hint, setHint] = useState('');
  const [fixHint, setFixHint] = useState('');
  const [restFor, setRestFor] = useState('');
  const inputs = useRef<Partial<Record<CommandName, HTMLInputElement | null>>>({});

  const job = jobOf(scan);
  const prop = proposalOf(scan);
  const texts = textsOf(draft);
  const kinds = kindsOf(scan, draft);
  const paths = draft.env.map((e) => e.path);
  const aiOn = scan.aiAvailable;
  const working = job?.state === 'running' && job.mode === 'ai';
  const busy = job?.state === 'running' || tryCommands.isPending || startAi.isPending;
  const filled = COMMANDS.filter((n) => texts[n].trim());
  const err = startAi.error ?? tryCommands.error ?? cancel.error;

  const typedByPerson = (n: CommandName) => texts[n].trim() !== (prop?.commands[n]?.command ?? '');
  /** Rows the AI must leave alone: the ones that work and the ones the person typed. */
  const keepNames = (): CommandName[] => filled.filter((n) => kinds[n] === 'works' || typedByPerson(n));

  const ask = (text: string, keep: CommandName[]) =>
    startAi.mutate(
      {
        scanId: scan.id,
        body: {
          hint: text.trim(),
          ...(filled.length ? { commands: texts, keep } : {}),
          ...(paths.length ? { envPath: paths } : {}),
        },
      },
      { onSuccess: () => setLook('result') },
    );
  const tryAll = (envPaths: string[] = paths) =>
    tryCommands.mutate({ scanId: scan.id, body: { commands: texts, envPath: envPaths } });
  const tryOne = (n: CommandName) =>
    tryCommands.mutate({ scanId: scan.id, body: { commands: texts, envPath: paths, only: [n] } });
  const setText = (n: CommandName, v: string) => setDraft((d) => ({ ...d, [n]: v }));
  const setEnv = (next: EnvFolder[]) => {
    setDraft((d) => ({ ...d, env: next }));
    if (filled.length && !busy) tryAll(next.map((f) => f.path));
  };
  const stop = () =>
    cancel.mutate(scan.id, {
      onSuccess: (s) => {
        const p = proposalOf(s);
        const any = COMMANDS.some((n) => s.trial?.[n] || p?.commands[n]?.command);
        setLook(any ? 'result' : 'choose');
      },
    });

  const errLine = err && (
    <span className="ai-error-text" role="alert">
      {extractError(err)}
    </span>
  );

  // The AI at work
  if (working && job) return <AiWork job={job} onCancel={stop} cancelling={cancel.isPending} />;

  // Choose
  if (look === 'choose')
    return (
      <div className="pk-form" data-testid="cmd-choose">
        {job?.mode === 'ai' && (job.state === 'failed' || job.state === 'cancelled') && (
          <div className="ai-notice ai-notice-warn" role="status" data-testid="ai-stopped">
            {job.state === 'cancelled'
              ? 'The AI was stopped.'
              : `The AI could not finish: ${job.error ?? 'it stopped.'}`}
          </div>
        )}
        <div className="pk-choose">
          <div className={`pk-opt${aiOn ? ' pk-opt-on' : ''}`} data-testid="choose-ai">
            <div className="pk-opt-head">
              <div className="pk-opt-title">Let the AI work it out</div>
              <span className={`ai-chip ${aiOn ? 'pk-c-ok' : 'pk-c-bad'}`}>
                {aiOn ? 'Recommended' : 'Not available'}
              </span>
            </div>
            <div className={`pk-opt-list${aiOn ? '' : ' pk-dim'}`}>
              <Bullet icon="search">
                Reads the CI workflow, the package files and the README, and picks the prepare, test, lint and build
                commands.
              </Bullet>
              <Bullet icon="play">
                Runs each one <b>once</b> in a temporary copy of the repository and keeps the output as proof.
              </Bullet>
              <Bullet icon="lock">
                The AI only reads files itself. To try the commands it runs the repository’s own install and test
                scripts in a temporary copy, as you would in a terminal. It does not edit your checkout, push, or touch
                a ticket.
              </Bullet>
              <Bullet icon="clock" color="#5B6B60">
                Usually 1 to 3 minutes. Uses this computer’s own Claude login, about as much of your window as a short
                ticket.
              </Bullet>
            </div>
            {aiOn ? (
              <div className="pk-field">
                <span className="pk-field-label">
                  Anything it should know? <span className="pk-opt-sub">optional</span>
                </span>
                <input
                  className="ai-input pk-cmd"
                  aria-label="Anything it should know?"
                  placeholder="e.g. this repo uses pnpm; the app is in ui/"
                  value={hint}
                  onChange={(e) => setHint(e.target.value)}
                />
              </div>
            ) : (
              <div className="pk-warn" data-testid="ai-unavailable">
                <Ico name="warn" size={14} color="#B8860B" sw={2} />
                <div>
                  <b>{scan.aiUnavailableWhy || 'The AI is not available on this computer.'}</b> The AI needs it to read
                  the repository.
                  {/signed in/i.test(scan.aiUnavailableWhy ?? '') && (
                    <> Sign in by running claude in a terminal, then check again.</>
                  )}
                  <div className="pk-btns" style={{ marginTop: 7 }}>
                    <button type="button" className="ai-btn ai-btn-sm" onClick={onRecheck}>
                      <Ico name="refresh" />
                      Check again
                    </button>
                  </div>
                </div>
              </div>
            )}
            <div>
              <button
                type="button"
                className={`ai-btn ai-btn-sm${aiOn ? ' ai-btn-primary' : ''}`}
                disabled={!aiOn || busy}
                onClick={() => ask(hint, keepNames())}
              >
                <Ico name="sparkle" />
                Start
              </button>
            </div>
          </div>
          <div className={`pk-opt${aiOn ? '' : ' pk-opt-on'}`} data-testid="choose-type">
            <div className="pk-opt-head">
              <div className="pk-opt-title">Type them myself</div>
              {!aiOn && <span className="ai-chip pk-c-ok">Use this for now</span>}
            </div>
            <div className="pk-opt-list">
              <Bullet icon="edit" color="#5B6B60">
                Four empty boxes: prepare, test, lint, build. Leave any of them empty.
              </Bullet>
              <Bullet icon="play" color="#5B6B60">
                Try one command, or all of them, whenever you like. Skipping the trial is fine.
              </Bullet>
              <Bullet icon="gear" color="#5B6B60">
                Everything stays editable later under Project settings › AI › Commands.
              </Bullet>
            </div>
            <div>
              <button
                type="button"
                className={`ai-btn ai-btn-sm${aiOn ? '' : ' ai-btn-primary'}`}
                onClick={() => setLook('result')}
              >
                <Ico name="edit" />
                Type the commands
              </button>
            </div>
          </div>
        </div>
        {errLine}
        <div className="pk-bar-actions">
          <button type="button" className="ai-btn ai-btn-sm" onClick={onBack}>
            <Ico name="back" />
            Back
          </button>
        </div>
      </div>
    );

  // Result: one row per command
  const compact = !COMMANDS.some((n) => scan.trial?.[n]);
  const nothingFound =
    job?.mode === 'ai' &&
    job.state === 'done' &&
    filled.length === 0 &&
    !!prop &&
    COMMANDS.every((n) => !prop.commands[n]?.command);
  const timeoutOpen = job?.state === 'timeout' && restFor !== job.startedAt;
  const bad = COMMANDS.filter((n) => isBad(kinds[n]));
  const failing = bad.filter((n) => kinds[n] === 'fails');
  const wrong = bad.filter((n) => kinds[n] === 'wrong');
  const allGood = filled.length > 0 && filled.every((n) => kinds[n] === 'works');
  const needsChoice = failing.filter((n) => n !== 'prepare' && !isDecided(draft, n as CheckName, kinds[n])).length;
  const needsFix = wrong.length + failing.filter((n) => n === 'prepare').length;
  const sick = bad.length > 0 || COMMANDS.some((n) => kinds[n] === 'timeout');
  const proved = filled.filter((n) => kinds[n] === 'works');

  let banner: ReactNode = null;
  if (job?.state === 'timeout') {
    const found = filled.length;
    const minutes = Math.max(1, Math.round((job.elapsedS || 600) / 60));
    const missing = COMMANDS.filter((n) => !texts[n].trim()).map((n) => n);
    banner = (
      <Banner
        tone="warn"
        icon="warn"
        testId="banner-timeout"
        title={`The AI stopped after ${minutes} minutes with ${found} of 4 commands`}
      >
        {found > 0 ? (
          <>
            It found {filled.join(' and ')} and proved{' '}
            {proved.length === 0
              ? 'none of them'
              : proved.length === found
                ? found === 1
                  ? 'it'
                  : found === 2
                    ? 'both'
                    : 'all of them'
                : proved.join(' and ')}
            .{missing.length > 0 && <> It did not get to {missing.join(' and ')}.</>}
          </>
        ) : (
          <>It did not find any command in time.</>
        )}
      </Banner>
    );
  } else if (job?.state === 'failed') {
    banner = (
      <Banner tone="err" icon="xcircle" testId="banner-failed" title="The run did not finish">
        {job.error ?? 'It stopped before the end.'}
      </Banner>
    );
  } else if (nothingFound) {
    banner = (
      <Banner tone="warn" icon="warn" testId="banner-nothing" title="The AI looked and found no commands">
        No CI workflow, no package scripts, no Makefile or task file. It says so instead of making something up.
      </Banner>
    );
  } else if (job?.state === 'done' && bad.length > 0) {
    const mixed = failing.length > 0 && wrong.length > 0;
    banner = (
      <Banner
        tone="warn"
        icon="warn"
        testId="banner-problems"
        title={`${WORD[Math.min(bad.length, 4)]} thing${bad.length === 1 ? ' needs' : 's need'} a look${mixed ? ' — and they are not the same kind of problem' : ''}`}
      >
        {failing.map((n) =>
          n === 'prepare' ? (
            <span key={n}>The prepare command ran but exits with an error: read its output. </span>
          ) : (
            <span key={n}>
              The {n} command is fine, but the repository fails it: choose whether it is a check yet, because a check
              that fails sends every ticket back to Dev.{' '}
            </span>
          ),
        )}
        {wrong.map((n) => (
          <span key={n}>
            The {n} command does not run; fix it{n === 'prepare' ? '' : ', or leave it empty for now'}.{' '}
          </span>
        ))}
      </Banner>
    );
  } else if (job?.mode === 'ai' && job.state === 'done' && allGood) {
    banner = (
      <Banner
        tone="ok"
        icon="check"
        testId="banner-ok"
        title={`The AI finished in ${fmtSeconds(job.elapsedS)} — ${filled.length === 4 ? 'all four commands' : `all ${filled.length} command${filled.length === 1 ? '' : 's'} it found`} work${filled.length === 1 ? 's' : ''}`}
      >
        {prop?.notes ? `${prop.notes} ` : 'It read the repository. '}The board ran each command once, the way a ticket
        runs it, in a temporary copy. Edit any of them, or run one again.
      </Banner>
    );
  }

  const rowElapsed = (n: CommandName) => {
    const s = job?.steps.find((x) => x.key === n && x.state === 'running');
    return Math.max(0, (job?.elapsedS ?? 0) - (s?.atS ?? 0));
  };

  const rows = COMMANDS.map((n) => (
    <CommandRow
      key={n}
      name={n}
      text={texts[n]}
      onText={(v) => setText(n, v)}
      inputRef={(el) => {
        inputs.current[n] = el;
      }}
      kind={kinds[n]}
      run={scan.trial?.[n]}
      proposed={prop?.commands[n]}
      compact={compact}
      elapsed={rowElapsed(n)}
      busy={busy}
      aiAvailable={aiOn}
      checkOn={n === 'prepare' ? false : isCheckOn(draft, n, kinds[n])}
      onCheck={(on) => n !== 'prepare' && setDraft((d) => withChoice(d, n, kinds[n], on))}
      onRun={() => tryOne(n)}
      onFix={() =>
        ask(
          `Fix the ${n} command.`,
          COMMANDS.filter((x) => x !== n && texts[x].trim()),
        )
      }
      onLeaveEmpty={() => setText(n, '')}
      onCancel={stop}
    />
  ));

  let actions: ReactNode;
  if (timeoutOpen) {
    actions = (
      <>
        {aiOn && (
          <button
            type="button"
            className="ai-btn ai-btn-primary ai-btn-sm"
            disabled={busy}
            onClick={() => ask('', proved)}
          >
            <Ico name="sparkle" />
            Try the missing ones
          </button>
        )}
        <button type="button" className="ai-btn ai-btn-sm" onClick={() => setLook('choose')}>
          <Ico name="refresh" />
          Start over
        </button>
        <button
          type="button"
          className="ai-btn ai-btn-sm"
          onClick={() => {
            setRestFor(job?.startedAt ?? '');
            inputs.current[COMMANDS.find((n) => !texts[n].trim()) ?? 'prepare']?.focus();
          }}
        >
          <Ico name="edit" />
          Type the rest
        </button>
      </>
    );
  } else if (nothingFound) {
    actions = (
      <>
        <button type="button" className="ai-btn ai-btn-primary ai-btn-sm" onClick={onContinue}>
          <Ico name="next" />
          Continue with these empty
        </button>
        {aiOn && (
          <button type="button" className="ai-btn ai-btn-sm" disabled={busy} onClick={() => ask('', [])}>
            <Ico name="sparkle" />
            Let the AI look again
          </button>
        )}
        <button type="button" className="ai-btn ai-btn-sm" onClick={() => setLook('choose')}>
          <Ico name="back" />
          Back
        </button>
      </>
    );
  } else if (compact) {
    actions = (
      <>
        <button
          type="button"
          className="ai-btn ai-btn-primary ai-btn-sm"
          disabled={busy || !filled.length}
          onClick={() => tryAll()}
        >
          <Ico name="play" />
          Try them
        </button>
        <button type="button" className="ai-btn ai-btn-sm" onClick={onContinue}>
          Skip trying
        </button>
        <button type="button" className="ai-btn ai-btn-sm" onClick={() => setLook('choose')}>
          <Ico name="sparkle" />
          Let the AI do it instead
        </button>
        <button type="button" className="ai-btn ai-btn-sm" onClick={() => setLook('choose')}>
          <Ico name="back" />
          Back
        </button>
      </>
    );
  } else {
    actions = (
      <>
        <button type="button" className="ai-btn ai-btn-primary ai-btn-sm" disabled={busy} onClick={onContinue}>
          <Ico name="next" />
          {filled.length === 0 ? 'Continue with these empty' : allGood ? 'Continue' : 'Continue anyway'}
        </button>
        <button type="button" className="ai-btn ai-btn-sm" disabled={busy || !filled.length} onClick={() => tryAll()}>
          <Ico name="refresh" />
          Run all again
        </button>
        {aiOn && (
          <button type="button" className="ai-btn ai-btn-sm" disabled={busy} onClick={() => ask('', keepNames())}>
            <Ico name="sparkle" />
            Ask the AI to check again
          </button>
        )}
        <button type="button" className="ai-btn ai-btn-sm" onClick={onBack}>
          <Ico name="back" />
          Back
        </button>
        <span style={{ flex: 1 }} />
        <span className="ai-hint" data-testid="cmd-summary">
          {needsChoice + needsFix > 0
            ? [needsChoice && `${needsChoice} needs a choice`, needsFix && `${needsFix} needs fixing`]
                .filter(Boolean)
                .join(' · ')
            : 'The status always comes from a run by the board; the AI’s log is only context.'}
        </span>
      </>
    );
  }

  return (
    <div className="pk-form" data-testid="cmd-result" data-compact={compact || undefined}>
      {banner}
      {!job && !prop && compact && (
        <div className="ai-hint">
          Leave any box empty. You can edit all of this later under Project settings › AI › Commands.
        </div>
      )}
      <div className={compact ? 'pk-crows' : 'pk-rows'}>{rows}</div>
      {sick && aiOn && !working && !timeoutOpen && (
        <div className="pk-ask" data-testid="ask-fix">
          <div className="pk-row-name">Ask the AI to fix what is wrong</div>
          <div className="pk-ask-in">
            <input
              className="ai-input pk-cmd"
              aria-label="What the AI should know"
              placeholder="e.g. this repo uses pnpm, and the app is in ui/"
              value={fixHint}
              onChange={(e) => setFixHint(e.target.value)}
            />
            <button
              type="button"
              className="ai-btn ai-btn-primary ai-btn-sm"
              disabled={busy || !fixHint.trim()}
              onClick={() => ask(fixHint, keepNames())}
            >
              Send
            </button>
          </div>
          <div className="ai-hint">
            It starts again with your sentence, keeps the commands that already work, and changes only the rows that do
            not. Rows you typed yourself are left alone.
          </div>
        </div>
      )}
      {!compact && (
        <EnvBlock
          folders={draft.env}
          basePath={scan.basePath}
          onChange={setEnv}
          changeNote="Changing it runs the commands again."
          disabled={busy}
        />
      )}
      {errLine}
      {footSlot ? createPortal(<>{actions}</>, footSlot) : <div className="pk-bar-actions">{actions}</div>}
    </div>
  );
}
