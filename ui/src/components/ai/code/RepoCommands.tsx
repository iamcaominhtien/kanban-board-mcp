import { useEffect, useRef, useState } from 'react';
import { aiScanApi, useLatestScan } from '../../../api/aiScan';
import { useAiTeams, useRunnerInfo } from '../../../api/ai';
import { usePatchProjectOps, useProjectOps } from '../../../api/aiProjectOps';
import { agoWords } from '../../../utils/accountList';
import { extractError } from '../../../api/extractError';
import type { CommandName, EnvFolder, Scan } from '../../../types/aiPacks';
import { LineIcon } from '../../ui/LineIcon';
import { LoadError } from '../aiUi';
import { EnvBlock } from '../packs/EnvBlock';
import { CommandRow, ScanLog, ScanStrip } from './RepoCommandsParts';
import { COMMAND_ORDER, jobOf, proposedTexts, rowView, keepList, type CommandTexts } from './repoCommandsLogic';
import './repoCommands.css';

const same = (a: CommandTexts, b: CommandTexts) => COMMAND_ORDER.every((n) => a[n].trim() === b[n].trim());
const sameEnv = (a: EnvFolder[], b: EnvFolder[]) => a.length === b.length && a.every((f, i) => f.path === b[i].path);

/**
 * "Commands the project runs" (design/screens/ai-repo-commands.md): the prepare, test, lint and build commands as four
 * boxes you can type in at any time, and one button that lets the AI find them. The AI and the board's trial of
 * each command are a job on the server (`/ai/scans`), so closing the page does not stop them. Nothing here is a
 * condition for a ticket: the board never turns a command into a gate on the AI.
 */
export function RepoCommands({ projectId }: { projectId: string }) {
  const ops = useProjectOps(projectId);
  const patch = usePatchProjectOps(projectId);
  const teams = useAiTeams(projectId);
  const runner = useRunnerInfo();
  const { query, put } = useLatestScan(projectId);
  const scan: Scan | null = query.data ?? null;
  const job = jobOf(scan);
  const running = job?.state === 'running';

  const wt = (ops.data?.worktrees ?? {}) as { repo?: string | null; prepare?: string };
  const folder = (wt.repo || teams.data?.[0]?.workingDir || '').trim();
  const saved: CommandTexts = {
    prepare: wt.prepare ?? '',
    test: ops.data?.commands?.test ?? '',
    lint: ops.data?.commands?.lint ?? '',
    build: ops.data?.commands?.build ?? '',
  };
  const savedEnv: EnvFolder[] = (ops.data?.envPath ?? []).map((path) => ({ path, by: 'project' as const }));

  // what is typed (null: the boxes follow what is saved) and the folders as edited
  const [typed, setTyped] = useState<CommandTexts | null>(null);
  const [envEdit, setEnvEdit] = useState<EnvFolder[] | null>(null);
  const [hint, setHint] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const texts = typed ?? saved;
  const env = envEdit ?? savedEnv;
  const dirty = (typed != null && !same(typed, saved)) || (envEdit != null && !sameEnv(envEdit, savedEnv));

  // the boxes take what the AI proposed once its job has ended (also when the page is opened after it ended)
  const adopted = useRef<string | null>(null);
  const wasRunning = useRef(false);
  useEffect(() => {
    if (!scan || !job || !ops.data) return;
    const key = `${scan.id}:${job.startedAt}`;
    if (job.state === 'running') {
      wasRunning.current = true;
      adopted.current = adopted.current === key ? key : null;
      return;
    }
    if (adopted.current === key || job.mode !== 'ai' || job.state === 'cancelled') return;
    adopted.current = key;
    const proposed = proposedTexts(scan);
    const folders = (scan.proposal as { envPath?: EnvFolder[] }).envPath;
    if (proposed) {
      setTyped((cur) => {
        // a typed box that was kept stays as it is; the others take the proposal
        const next = { ...proposed };
        if (cur) for (const n of COMMAND_ORDER) if (!next[n] && cur[n]) next[n] = cur[n];
        return next;
      });
    }
    if (folders?.length) setEnvEdit(folders);
  }, [scan, job, ops.data]);

  // a scan is read by code (nothing runs) so the card knows at once whether the AI can start
  const creating = useRef(false);
  useEffect(() => {
    if (query.isLoading || query.isError || query.data !== null || !folder || creating.current) return;
    creating.current = true;
    aiScanApi
      .create(projectId, folder)
      .then(put)
      .catch((e) => setProblem(extractError(e)))
      .finally(() => {
        creating.current = false;
      });
  }, [query.isLoading, query.isError, query.data, folder, projectId, put]);

  if (ops.isLoading) return <div className="ai-skel" style={{ height: 120 }} aria-busy="true" aria-label="Loading" />;
  if (ops.error || !ops.data)
    return <LoadError what="the repository settings" error={ops.error} onRetry={() => void ops.refetch()} />;

  const envPaths = env.map((f) => f.path);
  const ensure = async (): Promise<Scan | null> => {
    if (scan) return scan;
    if (!folder) return null;
    const fresh = await aiScanApi.create(projectId, folder);
    put(fresh);
    return fresh;
  };
  const go = async (start: (s: Scan) => Promise<Scan>) => {
    setProblem(null);
    setBusy(true);
    try {
      const s = await ensure();
      if (!s) return setProblem('There is no working folder yet: add a team or set the repository path first.');
      put(await start(s));
    } catch (e) {
      setProblem(extractError(e));
    } finally {
      setBusy(false);
    }
  };
  const startAi = (opts?: { hint?: string; keep?: CommandName[] }) =>
    go((s) =>
      aiScanApi.startAi(s.id, {
        hint: opts?.hint ?? hint,
        commands: texts,
        keep: opts?.keep ?? keepList(texts, s.trial),
        envPath: envPaths,
      }),
    );
  const runCommands = (only?: CommandName[]) =>
    go((s) => aiScanApi.startTry(s.id, { commands: texts, envPath: envPaths, only }));
  const stop = () => scan && void aiScanApi.cancel(scan.id).then(put);
  const askToFix = (name: CommandName) => {
    const run = scan?.trial?.[name];
    const why = [run?.reason, ...(run?.tail ?? []).slice(-3)].filter(Boolean).join(' | ');
    void startAi({
      hint: `The ${name} command "${texts[name]}" does not work${why ? `: ${why}` : ''}. Fix only that one.`,
      keep: COMMAND_ORDER.filter((n) => n !== name && texts[n].trim()),
    });
  };
  const save = async () => {
    setProblem(null);
    try {
      await patch.mutateAsync({
        commands: { test: texts.test.trim(), lint: texts.lint.trim(), build: texts.build.trim() },
        worktrees: { prepare: texts.prepare.trim() },
        envPath: envPaths,
      });
      setTyped(null);
      setEnvEdit(null);
    } catch (e) {
      setProblem(extractError(e));
    }
  };
  const discard = () => {
    setTyped(null);
    setEnvEdit(null);
  };

  const aiOff = scan ? !scan.aiAvailable : !runner.data?.claudeFound;
  const offWhy = scan
    ? scan.aiUnavailableWhy
    : runner.data && !runner.data.claudeFound
      ? 'Claude Code is not installed on this computer (the claude command was not found).'
      : null;
  const noFolder = !scan && !folder;
  const aiJob = job?.mode === 'ai';
  const finished = !!job && !running;
  const again = job && (job.state === 'timeout' || job.state === 'failed') ? 'Run it again' : 'Set up again';
  const proposed = proposedTexts(scan);
  const nothingFound =
    finished && job.mode === 'ai' && job.state === 'done' && !!proposed && COMMAND_ORDER.every((n) => !proposed[n]);

  return (
    <div className="rc-card" data-testid="repo-commands">
      <div className="rc-head">
        <div style={{ flex: 1 }}>
          <div className="rc-title">Commands the project runs</div>
          <div className="ai-hint">
            The prepare command runs once in every new worktree; test, lint and build are what the teams run to try a
            change.
          </div>
        </div>
        <button
          type="button"
          className="ai-btn ai-btn-primary"
          data-testid="rc-find"
          disabled={running || busy || aiOff || noFolder}
          onClick={() => void startAi()}
        >
          <LineIcon name={aiJob ? 'refresh' : 'sparkle'} size={13} />
          {aiJob ? again : 'Let the AI find the commands'}
        </button>
      </div>
      {!aiJob && !aiOff && !noFolder && (
        <div className="ai-hint" data-testid="rc-how">
          The AI only reads files itself. To try the commands it runs the repository’s own install and test scripts in a
          temporary copy, as you would in a terminal. It does not edit your checkout, push, or touch a ticket. Usually 1
          to 3 minutes; it uses the board’s signed-in Claude account, else this computer’s login.
        </div>
      )}
      {aiOff && offWhy && (
        <div className="rc-why" role="status" data-testid="rc-off-why">
          <LineIcon name="warning" size={14} /> {offWhy}
        </div>
      )}
      {noFolder && (
        <div className="rc-why" role="status">
          <LineIcon name="warning" size={14} /> There is no working folder yet: add a team or set the repository path
          above, then the AI can read it.
        </div>
      )}
      {problem && (
        <div className="rc-why rc-why-bad" role="alert" data-testid="rc-problem">
          <LineIcon name="warning" size={14} /> {problem}
        </div>
      )}
      {job && <ScanStrip job={job} onStop={stop} />}
      {running && <ScanLog lines={job.log} mode={job.mode} />}
      {job && !running && job.error && job.state !== 'cancelled' && (
        <div className="rc-why rc-why-bad" data-testid="rc-job-error">
          {job.error}
        </div>
      )}
      {nothingFound && (
        <div className="rc-nothing" data-testid="rc-nothing">
          <div>
            The AI found no commands in this repository. Type them yourself below, or tell it where to look and try
            again.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              className="ai-input"
              style={{ flex: 1 }}
              aria-label="Where to look"
              placeholder="e.g. this repo uses pnpm; the app is in ui/"
              value={hint}
              onChange={(e) => setHint(e.target.value)}
            />
            <button type="button" className="ai-btn" disabled={busy || aiOff} onClick={() => void startAi()}>
              Try again
            </button>
          </div>
        </div>
      )}
      {finished && job.mode === 'ai' && job.state === 'done' && !nothingFound && (
        <div className="ai-hint" data-testid="rc-proof-note">
          Set up by the AI {agoWords(job.endedAt, Date.now())}. Proof is kept with each command.
        </div>
      )}

      <div className="rc-rows">
        {COMMAND_ORDER.map((n) => (
          <CommandRow
            key={n}
            name={n}
            text={texts[n]}
            view={rowView(n, texts[n], scan?.trial?.[n], job)}
            source={
              (scan?.proposal as { commands?: Record<string, { source?: string }> } | undefined)?.commands?.[n]?.source
            }
            proven={!!scan?.trial?.[n] && scan.trial[n]?.command.trim() === texts[n].trim()}
            disabled={running || busy}
            onChange={(v) => setTyped({ ...texts, [n]: v })}
            onRun={() => void runCommands(n === 'prepare' ? [] : [n])}
            onFix={() => askToFix(n)}
            canFix={!aiOff}
          />
        ))}
      </div>

      <EnvBlock
        folders={env}
        basePath={scan?.basePath}
        onChange={(next) => setEnvEdit(next)}
        changeNote={
          dirty
            ? 'Not saved yet: Save these commands keeps it for this project.'
            : 'Saved for this project. The next run of a command or a ticket uses it.'
        }
        disabled={patch.isPending}
      />

      {(finished || dirty || !!scan?.trial?.test) && (
        <div className="rc-bar">
          <button
            type="button"
            className="ai-btn ai-btn-primary"
            data-testid="rc-save"
            disabled={!dirty || patch.isPending}
            onClick={() => void save()}
          >
            <LineIcon name="check" size={13} /> Save these commands
          </button>
          <button type="button" className="ai-btn" disabled={!dirty} onClick={discard}>
            Discard
          </button>
          <span className="ai-hint" style={{ flex: 1 }}>
            {dirty
              ? 'A failing command can still be saved: it is yours to keep.'
              : 'Saved for this project. Nothing else changes.'}
          </span>
          <button
            type="button"
            className="ai-btn ai-btn-sm"
            data-testid="rc-run-all"
            disabled={running || busy || !COMMAND_ORDER.some((n) => texts[n].trim())}
            onClick={() => void runCommands()}
          >
            <LineIcon name="refresh" size={13} /> Run all again
          </button>
        </div>
      )}
    </div>
  );
}
