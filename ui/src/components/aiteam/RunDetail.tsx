import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { aiKeys } from '../../api/ai';
import { aiOpsApi } from '../../api/aiOps';
import { ContinueNoteDialog } from '../ai/trouble/ContinueNoteDialog';
import { exportRunUrl, usePinRun, useRunRecord, useTranscript } from '../../api/aiHistory';
import { extractError } from '../../api/extractError';
import type { Entry, HistoryRow, MemoryUsed } from '../../types/aiHistory';
import {
  END_LOOK,
  asText,
  buildSteps,
  cutMiddle,
  endWords,
  fmtSecondClock,
  fmtTook,
  fmtWhen,
  givenOf,
  usedSkills,
  whoOf,
  type Step,
} from './historyFormat';
import { fmtTokens, fmtUsd } from './teamFormat';
import './history.css';
import { LineIcon } from '../ui/LineIcon';

interface Props {
  runId: string;
  onBack: () => void;
  onOpenTicket: (ticketId: string) => void;
}

type Pane = 'steps' | 'given' | 'files' | 'report';

function Pre({ text, error }: { text: string; error?: boolean }) {
  const [all, setAll] = useState(false);
  const cut = cutMiddle(text);
  return (
    <>
      <pre className={`hs-pre${error ? ' err' : ''}`}>{all ? text : cut.shown}</pre>
      {cut.hidden > 0 ? (
        <button type="button" className="hs-link" onClick={() => setAll(!all)}>
          {all ? 'Show less' : `${cut.hidden} lines hidden · show all`}
        </button>
      ) : null}
    </>
  );
}

function StepBody({ entry }: { entry: Step['entry'] }) {
  switch (entry.type) {
    case 'tool': {
      const out = asText(entry.output);
      return (
        <>
          <div>
            <div className="hs-label">What it sent · {entry.name}</div>
            <Pre text={asText(entry.input) || '(no arguments)'} />
          </div>
          <div>
            <div className="hs-label">{entry.isError ? 'What came back · error' : 'What came back'}</div>
            {out ? <Pre text={out} error={entry.isError} /> : <div className="hs-note">Nothing came back.</div>}
          </div>
        </>
      );
    }
    case 'say':
    case 'think':
    case 'message':
    case 'note':
    case 'output':
      return <p className="hs-prose">{entry.text}</p>;
    case 'compact':
      return (
        <p className="hs-prose">
          The conversation grew too long and was summarised
          {entry.before != null ? ` from ${entry.before.toLocaleString()} tokens` : ''}
          {entry.after != null ? ` to ${entry.after.toLocaleString()}` : ''}. What it knew before may be only partly
          kept.
        </p>
      );
    case 'result':
      return (
        <>
          {entry.text ? <p className="hs-prose">{entry.text}</p> : null}
          <div className="hs-note">
            {entry.turns != null ? `${entry.turns} turns` : ''}
            {entry.costUsd != null ? ` · estimate ${fmtUsd(entry.costUsd)}` : ''}
          </div>
        </>
      );
    case 'quota':
      return <Pre text={asText(entry.windows) || asText(entry.status)} />;
  }
}

function StepRow({ s, last }: { s: Step; last: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`hs-step ${s.tone}`} data-testid="hs-step">
      <time>{fmtSecondClock(s.at)}</time>
      <div className="hs-rail">
        <i />
        {last ? null : <u />}
      </div>
      <div className="hs-body">
        <button type="button" className="hs-line" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="t">{s.title}</span>
          {s.tookS != null ? <span className="hs-meta">{fmtTook(s.tookS)}</span> : null}
          {s.entry.type === 'tool' && s.entry.isError ? <span className="hs-meta">error</span> : null}
        </button>
        {open ? (
          <div className="hs-open">
            <StepBody entry={s.entry} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Collapsible({ label, text }: { label: string; text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <div className="hs-label">
        {label}{' '}
        <button type="button" className="hs-link" onClick={() => setOpen(!open)}>
          {open ? 'hide' : `show · ${text.length.toLocaleString()} characters`}
        </button>
      </div>
      {open ? <Pre text={text} /> : null}
    </div>
  );
}

/** "Used 3 lessons and 2 notes", and which (issue #274). */
export function memoryUsedLabel(used: MemoryUsed | null | undefined): string {
  if (!used) return 'not recorded (a run from before the board recorded it)';
  const l = used.lessons.length;
  const n = used.notes.length;
  if (!l && !n) return 'none: no kept lessons or notes yet';
  const parts = [l ? `${l} lesson${l === 1 ? '' : 's'}` : '', n ? `${n} note${n === 1 ? '' : 's'}` : ''].filter(
    Boolean,
  );
  return `Used ${parts.join(' and ')}${used.tokens ? `, ${used.tokens.toLocaleString('en-US')} tokens` : ''}`;
}

function MemoryUsedLine({ used }: { used: MemoryUsed | null | undefined }) {
  const [open, setOpen] = useState(false);
  const any = !!used && used.lessons.length + used.notes.length > 0;
  return (
    <div data-testid="hs-memory-used">
      <span>{memoryUsedLabel(used)}</span>
      {any ? (
        <>
          {' '}
          <button type="button" className="ai-link" onClick={() => setOpen(!open)}>
            {open ? 'hide' : 'show which'}
          </button>
          {open ? (
            <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 12.5 }}>
              {used!.lessons.map((x) => (
                <li key={x.id}>
                  <b>Lesson</b> · {x.text}
                </li>
              ))}
              {used!.notes.map((x) => (
                <li key={x.id}>
                  <b>{x.scope === 'ticket' ? 'Ticket note' : 'Role note'}</b> · {x.text}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function Given({ entries, run }: { entries: Entry[]; run: HistoryRow }) {
  const { sent, init, messages } = givenOf(entries);
  const skills = init?.skills?.length ? init.skills : [];
  return (
    <div className="hs-panel" data-testid="hs-given">
      <div className="hs-note">
        This panel is the answer to “why did it do that”. Everything the AI knew when it started is here.
      </div>
      <div className="hs-given">
        <b>Model</b>
        <span>{init?.model ?? run.model ?? 'not recorded'}</span>
        <b>Conversation</b>
        <span>
          {sent
            ? sent.resume
              ? 'Resumed the CLI’s own conversation, with the note as the next message.'
              : 'A fresh conversation.'
            : 'not recorded'}
        </span>
        {sent?.system ? (
          <>
            <b>System prompt</b>
            <Collapsible
              label={`Persona of ${whoOf(run)}, the board’s own rules, and the project instructions — about ${Math.round(sent.system.length / 4).toLocaleString()} tokens`}
              text={sent.system}
            />
          </>
        ) : null}
        <b>Project memory</b>
        <MemoryUsedLine used={run.memoryUsed} />
        {sent?.prompt ? (
          <>
            <b>Prompt</b>
            <Collapsible label="The task the board sent" text={sent.prompt} />
          </>
        ) : null}
        {sent?.note ? (
          <>
            <b>Note</b>
            <span>{sent.note}</span>
          </>
        ) : null}
        {init ? (
          <>
            <b>Tools</b>
            <span>
              {init.tools ?? 0} tools
              {init.mcpServers?.length ? ` · ${init.mcpServers.map((m) => `${m.name} (${m.status})`).join(', ')}` : ''}
            </span>
            <b>Skills</b>
            <span>{skills.length ? skills.join(', ') : 'none'}</span>
            <b>Plugins</b>
            <span>{init.plugins?.length ? init.plugins.join(', ') : 'none'}</span>
          </>
        ) : null}
        {sent?.args?.length ? (
          <>
            <b>CLI arguments</b>
            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11.5, wordBreak: 'break-word' }}>
              {sent.args.join(' ')}
            </span>
          </>
        ) : null}
      </div>
      {messages.map((m, i) => (
        <div key={i} className="hs-note">
          {fmtSecondClock(m.at)} · sent again{m.note ? `: ${m.note}` : ''}
          {m.resume ? ' (resumed)' : ''}
        </div>
      ))}
    </div>
  );
}

/** One run: what it was given and what it did (design/screens/ai-operations.md, G). */
export function RunDetail({ runId, onBack, onOpenTicket }: Props) {
  const t = useTranscript(runId);
  const record = useRunRecord(runId);
  const pin = usePinRun();
  const [pane, setPane] = useState<Pane>('steps');
  const [pinError, setPinError] = useState<string | null>(null);
  const [noting, setNoting] = useState(false);
  const qc = useQueryClient();

  if (t.isError) {
    return (
      <div className="hs-empty" role="alert">
        <button type="button" className="tl-btn" onClick={onBack}>
          Back to Run history
        </button>
        <p>Couldn&apos;t load this run.</p>
      </div>
    );
  }
  if (!t.data) return <div className="hs-empty">Loading the run…</div>;

  const { run, transcript, entries, available } = t.data;
  const look = END_LOOK[run.state];
  const end = endWords(run);
  const steps = buildSteps(entries);
  const used = run.skills.length ? run.skills : usedSkills(entries);
  const pinned = !!transcript?.pinned;
  const removed = transcript?.removedAt ?? null;
  const detailsRemoved = run.detailsRemovedAt ?? null;
  const rec = record.data;
  const startNote = givenOf(entries).sent?.note?.trim() ?? '';
  const tests = rec?.report?.tests;

  const togglePin = () => {
    setPinError(null);
    pin.mutate({ runId, on: !pinned }, { onError: (e) => setPinError(extractError(e)) });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }} data-testid="run-detail">
      <div className="hs-crumb">
        <button type="button" onClick={onBack}>
          Run history
        </button>
        <span>›</span>
        <button type="button" onClick={() => onOpenTicket(run.ticketId)}>
          {run.ticketId}
        </button>
      </div>
      <div className="hs-run-head">
        <h2>Run of {fmtWhen(run.startedAt ?? run.queuedAt)}</h2>
        <span className="at-chip" style={{ background: look.bg, color: look.fg }}>
          {end.label}
        </span>
        {end.why ? (
          <span className="at-chip" style={{ background: '#F1F3F1', color: '#5B6B60' }}>
            {end.why}
          </span>
        ) : null}
        {pinned ? (
          <span className="at-chip" style={{ background: '#FEF3D9', color: '#7A5A06' }}>
            Pinned
          </span>
        ) : null}
        <span style={{ flex: 1 }} />
        <div className="hs-actions">
          {run.state === 'failed' || run.state === 'timed_out' || run.state === 'cancelled' ? (
            <button type="button" className="tl-btn" onClick={() => setNoting(true)}>
              Continue with a note
            </button>
          ) : null}
          <a className="tl-btn" href={exportRunUrl(runId, 'md')} download>
            Export as Markdown
          </a>
          <a className="tl-btn" href={exportRunUrl(runId, 'json')} download>
            Export as JSON
          </a>
          <button
            type="button"
            className="tl-btn"
            onClick={togglePin}
            disabled={!transcript || !!removed || pin.isPending}
            title={
              removed
                ? 'Too late: the transcript was already removed'
                : !transcript
                  ? 'There is no transcript to pin'
                  : ''
            }
          >
            {pinned ? 'Unpin' : 'Pin'}
          </button>
        </div>
      </div>
      <div className="hs-facts">
        <span>
          <b>Who</b>
          {whoOf(run)}
        </span>
        <span>
          <b>Ticket</b>
          {run.ticketId}
          {run.ticketTitle ? ` · ${run.ticketTitle}` : ''}
        </span>
        <span>
          <b>When</b>
          {fmtWhen(run.startedAt ?? run.queuedAt)} → {fmtWhen(run.endedAt)} · {fmtTook(run.durationS)}
        </span>
        <span>
          <b>Model</b>
          {run.model ?? '—'}
        </span>
        <span>
          <b>Tokens</b>
          {run.tokens != null ? fmtTokens(run.tokens) : '—'}
        </span>
        <span>
          <b>Estimate</b>
          {run.costUsd != null ? fmtUsd(run.costUsd) : '—'}
        </span>
        <span>
          <b>Files</b>
          {run.files} changed
        </span>
        {used.length ? (
          <span>
            <b>Used</b>
            {used.join(', ')}
          </span>
        ) : null}
      </div>
      {noting ? (
        <ContinueNoteDialog
          ended
          onSubmit={async (note) => {
            await aiOpsApi.continueWith(runId, note);
            void qc.invalidateQueries({ queryKey: aiKeys.all });
          }}
          onClose={() => setNoting(false)}
        />
      ) : null}
      {pinError ? (
        <div className="hs-warn" role="alert">
          {pinError}
        </div>
      ) : null}
      {pinned ? <div className="hs-note">Pinned runs are never deleted.</div> : null}

      {run.diagnosis ? (
        <div className="hs-diag" data-testid="hs-diagnosis">
          <b>{run.diagnosis.what}</b>
          <div>{run.diagnosis.means}</div>
          {run.diagnosis.tried?.length ? <div>Tried: {run.diagnosis.tried.join('; ')}</div> : null}
        </div>
      ) : null}

      <div className="at-seg" role="tablist" style={{ alignSelf: 'flex-start', marginLeft: 0 }}>
        {(
          [
            ['steps', 'Steps'],
            ['given', 'What it was given'],
            ['files', 'Files'],
            ['report', 'Report'],
          ] as [Pane, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={pane === id}
            className={pane === id ? 'on' : ''}
            onClick={() => setPane(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {!available && (pane === 'steps' || pane === 'given') ? (
        <div className="hs-warn" data-testid="hs-no-transcript">
          {detailsRemoved
            ? `Details removed on ${new Date(detailsRemoved).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })} by the run history setting: the transcript, steps and prompt are gone. Its cost, status, summary and links are kept.`
            : removed
              ? `The full transcript was removed on ${new Date(removed).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}, when it passed the retention. The summary below is kept for good.`
              : 'The board has no transcript of this run: it ended before the board began keeping them. The summary below is what is kept.'}
          {run.summary ? <p className="hs-prose">{run.summary}</p> : null}
        </div>
      ) : pane === 'steps' ? (
        <div className="hs-steps">
          <div className="hs-step">
            <time>{fmtSecondClock(run.startedAt ?? run.queuedAt)}</time>
            <div className="hs-rail">
              <i />
              <u />
            </div>
            <div className="hs-body">
              <button type="button" className="hs-line" onClick={() => setPane('given')}>
                <span className="t">Started.{startNote ? ` The note it was given: “${startNote}”` : ''}</span>
                <span className="hs-meta">what it was given</span>
              </button>
            </div>
          </div>
          {steps.length === 0 ? <div className="hs-note">No steps were recorded.</div> : null}
          {steps.map((s, i) => (
            <StepRow key={s.key} s={s} last={i === steps.length - 1} />
          ))}
        </div>
      ) : pane === 'given' ? (
        <Given entries={entries} run={run} />
      ) : pane === 'files' ? (
        <div className="hs-panel hs-files" data-testid="hs-files">
          {rec?.files?.length ? (
            rec.files.map((f) => (
              <div key={f.path}>
                <span style={{ flex: 1, wordBreak: 'break-all' }}>{f.path}</span>
                {f.new ? <span className="hs-note">new</span> : null}
                <span className="hs-add">+{f.added}</span>
                <span className="hs-del">−{f.removed}</span>
              </div>
            ))
          ) : (
            <div className="hs-note">{record.isLoading ? 'Loading…' : 'This run changed no files.'}</div>
          )}
        </div>
      ) : (
        <div className="hs-panel" data-testid="hs-report">
          <p className="hs-prose">{rec?.report?.summary ?? run.summary ?? 'This run left no report.'}</p>
          {rec?.report?.criteria?.length ? (
            <div>
              <div className="hs-label">Acceptance criteria</div>
              {rec.report.criteria.map((c, i) => (
                <div key={i} className="hs-prose">
                  <LineIcon
                    name={c.met === true ? 'check' : c.met === false ? 'close' : 'minus'}
                    size={13}
                    title={c.met === true ? 'Met' : c.met === false ? 'Not met' : 'Not checked'}
                  />{' '}
                  {c.text}
                  {c.evidence ? ` — ${c.evidence}` : ''}
                </div>
              ))}
            </div>
          ) : null}
          {tests ? (
            <div className="hs-prose">
              Tests: {tests.failed} failed, {tests.passed} passed
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
