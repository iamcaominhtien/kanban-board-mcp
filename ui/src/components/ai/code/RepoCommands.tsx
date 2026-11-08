import { useEffect, useRef, useState } from 'react';
import { aiScanApi, useLatestScan } from '../../../api/aiScan';
import { useAiTeams, useRunnerInfo } from '../../../api/ai';
import { usePatchProjectOps, useProjectOps } from '../../../api/aiProjectOps';
import { agoWords } from '../../../utils/accountList';
import { extractError } from '../../../api/extractError';
import type { CommandName, EnvFolder, Scan, TrialRun } from '../../../types/aiPacks';
import { LineIcon } from '../../ui/LineIcon';
import { LoadError } from '../aiUi';
import { EnvBlock } from '../packs/EnvBlock';
import { CommandRow, ScanLog, ScanStrip } from './RepoCommandsParts';
import { COMMAND_ORDER, jobOf, proposedTexts, rowView, keepList, type CommandTexts } from './repoCommandsLogic';
import './repoCommands.css';

/** The scan this card made for a folder, remembered across visits: the server keeps the real path, not the typed one. */
const madeKey = (projectId: string) => `kb-repo-scan:${projectId}`;
function readMade(projectId: string): { scanId: string; folder: string } | null {
  try {
    return JSON.parse(localStorage.getItem(madeKey(projectId)) ?? 'null');
  } catch {
    return null;
  }
}
function writeMade(projectId: string, v: { scanId: string; folder: string }) {
  try {
    localStorage.setItem(madeKey(projectId), JSON.stringify(v));
  } catch {
    // the card still works for this visit
  }
}

/** The job whose proposal this person has already seen (taken into the boxes, saved or discarded). */
const seenKey = (projectId: string) => `kb-repo-seen:${projectId}`;
function readSeen(projectId: string): string | null {
  try {
    return localStorage.getItem(seenKey(projectId));
  } catch {
    return null;
  }
}
function writeSeen(projectId: string, key: string) {
  try {
    localStorage.setItem(seenKey(projectId), key);
  } catch {
    // the card still works for this visit
  }
}

/** Frame 7: a command that ended "npm: command not found" and a folder the AI proposed that has it. */
function pathNote(run: TrialRun | null | undefined, env: EnvFolder[]): string | null {
  if (!run || run.status !== 'wrong' || run.exitCode !== 127) return null;
  const folder = env.find((f) => f.by === 'ai');
  const program = /(\S+): (?:command )?not found/.exec((run.tail ?? []).join('\n'))?.[1];
  if (!folder || !program) return null;
  return `${program} is not on the app’s PATH. It was found in ${folder.path}, which is proposed as an extra folder. Run it again once the folder is saved.`;
}

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
  const wt = (ops.data?.worktrees ?? {}) as { repo?: string | null; prepare?: string };
  const folder = (wt.repo || teams.data?.[0]?.workingDir || '').trim();
  // a scan of another folder is not this project's any more (the repository path or the team's folder changed)
  const trim = (p: string) => p.replace(/\/+$/, '');
  const latest = query.data ?? null;
  // the server keeps the real path (symlinks resolved), so a scan this card made is always this project's
  const made = readMade(projectId);
  const scan: Scan | null =
    latest && (made ? made.scanId === latest.id && made.folder === folder : trim(latest.folder) === trim(folder))
      ? latest
      : null;
  const job = jobOf(scan);
  const running = job?.state === 'running';
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

  // The boxes take what the AI proposes, only when it arrives while this page watches the job: the server keeps the
  // proposal of the last job until the next one writes its own, so the first sight of a job is its baseline
  const watched = useRef<{
    key: string;
    proposal: string;
    env: string;
    adopted: boolean;
    envAdopted: boolean;
    late: boolean;
  } | null>(null);
  // the boxes the person typed in since the job started: the AI's answer does not replace them
  const touched = useRef<Set<CommandName>>(new Set());
  useEffect(() => {
    if (!scan || !job || !ops.data || job.mode !== 'ai') return;
    const key = `${scan.id}:${job.startedAt}`;
    const sig = JSON.stringify(scan.proposal ?? {});
    const envSig = JSON.stringify((scan.proposal as { envPath?: EnvFolder[] }).envPath ?? null);
    const w = watched.current;
    const proposed = proposedTexts(scan);
    const folders = (scan.proposal as { envPath?: EnvFolder[] }).envPath;
    if (!w || w.key !== key) {
      // first sight of this job: a proposal that is already there belongs to an earlier look, unless nothing is saved
      // yet and the job has ended (the page was closed while it ran): then its commands are what the person has
      // the proposal is this job's own only once its "ai" step is done (the server keeps the last one until then)
      const aiDone = job.steps.some((s) => s.key === 'ai' && s.state === 'done');
      const take = !!proposed && aiDone && job.state !== 'running' && readSeen(projectId) !== key;
      watched.current = {
        key,
        proposal: sig,
        env: envSig,
        adopted: take,
        envAdopted: take && !!folders?.length,
        // opened while it works and its answer is already there: take it when the job ends
        late: !!proposed && job.state === 'running' && job.steps.some((s) => s.key === 'ai' && s.state === 'done'),
      };
      if (take) {
        writeSeen(projectId, key);
        setTyped(proposed);
        if (folders?.length) setEnvEdit(folders);
      }
      return;
    }
    if (w.adopted && job.state !== 'running') writeSeen(projectId, key);
    if (!proposed) return;
    if (!w.adopted && (sig !== w.proposal || (w.late && job.state !== 'running'))) {
      w.adopted = true;
      if (job.state !== 'running') writeSeen(projectId, key);
      const mine = new Set(touched.current);
      touched.current.clear();
      setTyped((cur) => {
        // a box the person typed in meanwhile stays; the others take the proposal
        const next = { ...proposed };
        if (cur) for (const n of COMMAND_ORDER) if (mine.has(n) && cur[n].trim()) next[n] = cur[n];
        return next;
      });
    }
    // the folders are saved a moment after the commands: take them when they arrive
    if (!w.envAdopted && folders?.length && (envSig !== w.env || (w.late && job.state !== 'running'))) {
      w.envAdopted = true;
      setEnvEdit(folders);
    }
  }, [scan, job, ops.data, projectId]);

  // a scan is read by code (nothing runs) so the card knows at once whether the AI can start; one try per folder
  const inflight = useRef<Promise<Scan> | null>(null);
  const attempted = useRef<string | null>(null);
  const createScan = () => {
    inflight.current ??= aiScanApi
      .create(projectId, folder)
      .then((s) => {
        writeMade(projectId, { scanId: s.id, folder });
        put(s);
        return s;
      })
      .finally(() => {
        inflight.current = null;
      });
    return inflight.current;
  };
  useEffect(() => {
    if (query.isLoading || query.isError || scan || !folder || attempted.current === folder) return;
    attempted.current = folder;
    createScan().catch((e) => setProblem(extractError(e)));
    // createScan only reads refs and stable values of this render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.isLoading, query.isError, scan, folder, projectId]);

  if (ops.isLoading) return <div className="ai-skel" style={{ height: 120 }} aria-busy="true" aria-label="Loading" />;
  if (ops.error || !ops.data)
    return <LoadError what="the repository settings" error={ops.error} onRetry={() => void ops.refetch()} />;

  const envPaths = env.map((f) => f.path);
  const ensure = async (): Promise<Scan | null> => {
    if (scan) return scan;
    if (!folder) return null;
    return createScan();
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
      // "already being set up": the job runs on the server, so show it
      void query.refetch();
    } finally {
      setBusy(false);
    }
  };
  const startAi = (opts?: { hint?: string; keep?: CommandName[] }) => {
    touched.current.clear();
    return go((s) =>
      aiScanApi.startAi(s.id, {
        hint: opts?.hint ?? hint,
        commands: texts,
        keep: opts?.keep ?? keepList(texts, s.trial),
        envPath: envPaths,
      }),
    );
  };

  const runCommands = (only?: CommandName[]) =>
    go((s) => aiScanApi.startTry(s.id, { commands: texts, envPath: envPaths, only }));
  const stop = () =>
    scan &&
    void aiScanApi
      .cancel(scan.id)
      .then(put)
      .catch((e) => setProblem(extractError(e)));
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
  const hasProof = COMMAND_ORDER.some((n) => !!scan?.trial?.[n]);
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
          <LineIcon name={aiJob && !running ? 'refresh' : 'sparkle'} size={13} />
          {aiJob && !running ? again : 'Let the AI find the commands'}
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
        <div className={`rc-why ${job.state === 'timeout' ? '' : 'rc-why-bad'}`} data-testid="rc-job-error">
          <LineIcon name="warning" size={14} /> {job.error}
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
            onChange={(v) => {
              touched.current.add(n);
              setTyped({ ...texts, [n]: v });
            }}
            onRun={() => void runCommands(n === 'prepare' ? [] : [n])}
            onFix={() => askToFix(n)}
            canFix={!aiOff}
            onAi={() => void startAi()}
            pathNote={pathNote(scan?.trial?.[n], env)}
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
        disabled={patch.isPending || running}
      />

      {(dirty || hasProof) && (
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
