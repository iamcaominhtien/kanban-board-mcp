import { useEffect, useRef, useState } from 'react';
import { useAiOverview, useTicketRuns } from '../../api/ai';
import { extractError } from '../../api/extractError';
import { scheduleApi, useScheduleDetail, useScheduleMutation } from '../../api/schedules';
import type { AiMember } from '../../types/ai';
import type { CheckResult, ScheduleDetail as Detail, ScheduleRun } from '../../types/schedules';
import { AiAvatar, SparkleIcon, money } from '../ai/aiUi';
import { useToast } from '../Toast';
import { TicketLine } from './MemberSelect';
import {
  CatchUpChip,
  ChevronIcon,
  CheckCircleIcon,
  CloseIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  Pill,
  ScheduleStateChip,
  SkipIcon,
  SlotChip,
  TargetIcon,
  WarnIcon,
  InfoIcon,
  canStart,
  fmtDuration,
  fmtMinutes,
  fmtNext,
  fmtSlot,
  scheduleLine,
} from './schedulesUi';

const FILTERS = [
  { id: 'all', label: 'All results' },
  { id: 'passed', label: 'Passed' },
  { id: 'partly', label: 'Partly done' },
  { id: 'failed', label: 'Failed' },
  { id: 'skipped', label: 'Skipped' },
] as const;

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="sc-tile">
      <div className="ai-label">{label}</div>
      <div className="sc-tile-v">{value}</div>
      <div className="ai-hint">{sub}</div>
    </div>
  );
}

/** One "done when" line of a slot: machine facts and the reviewer's judgement look different. */
function ResultLine({ r, reviewer }: { r: CheckResult; reviewer?: string | null }) {
  const ai = r.kind === 'ai';
  return (
    <div className={`sc-result ${r.ok ? 'sc-result-ok' : 'sc-result-bad'}`} data-testid={`result-${r.key}`}>
      <span className="sc-result-ico">{r.ok ? <CheckCircleIcon size={16} /> : <WarnIcon size={16} />}</span>
      <div>
        <div>{r.label}</div>
        <div className={`ai-muted ${ai ? 'sc-judged' : ''}`}>
          {ai ? (
            <>
              <TargetIcon size={11} />{' '}
              {r.detail.startsWith('Judged by')
                ? r.detail
                : `Judged by ${reviewer ?? 'the reviewer'}: ${r.ok ? 'pass' : 'not met'}`}
            </>
          ) : (
            r.detail
          )}
        </div>
      </div>
    </div>
  );
}

/** A slot that waits for the runner or for a person: run it on another AI, skip it, or run it now (F). */
function SlotActions({ run, ais, onDone }: { run: ScheduleRun; ais: AiMember[]; onDone: () => void }) {
  const toast = useToast();
  const [pick, setPick] = useState(false);
  const [member, setMember] = useState('');
  const act = useScheduleMutation((v: { action: 'start' | 'skip' | 'use_member'; memberId?: string }) =>
    scheduleApi.slotAction(run.id, v.action, v.memberId),
  );
  const go = async (action: 'start' | 'skip' | 'use_member', memberId?: string) => {
    try {
      await act.mutateAsync({ action, memberId });
      onDone();
    } catch (err) {
      toast.error("Couldn't update this run", extractError(err));
    }
  };
  const others = ais.filter((m) => m.id !== run.memberId);
  return (
    <div className="sc-slot-actions" data-testid="slot-actions">
      <button
        type="button"
        className="ai-btn ai-btn-sm"
        onClick={() => void go('start')}
        disabled={act.isPending}
        data-testid="slot-start"
      >
        <PlayIcon size={12} /> Run now
      </button>
      {pick ? (
        <>
          <select
            className="ai-select"
            style={{ width: 200 }}
            value={member}
            onChange={(e) => setMember(e.target.value)}
            aria-label="Another AI"
            data-testid="slot-member"
          >
            <option value="">Pick an AI…</option>
            {others.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="ai-btn ai-btn-sm ai-btn-primary"
            disabled={!member || act.isPending}
            onClick={() => void go('use_member', member)}
            data-testid="slot-use-member"
          >
            Run on it
          </button>
        </>
      ) : (
        <button type="button" className="ai-btn ai-btn-sm" onClick={() => setPick(true)} data-testid="slot-other">
          Run on another AI
        </button>
      )}
      <button
        type="button"
        className="ai-btn ai-btn-sm"
        onClick={() => void go('skip')}
        disabled={act.isPending}
        data-testid="slot-skip"
      >
        <SkipIcon size={12} /> Skip this time
      </button>
    </div>
  );
}

function SlotRow({
  run,
  detail,
  open,
  onToggle,
  ais,
  runNumber,
  onOpenTicket,
}: {
  run: ScheduleRun;
  detail: Detail;
  open: boolean;
  onToggle: () => void;
  ais: AiMember[];
  runNumber: (id: string) => number | undefined;
  onOpenTicket: (ticketId: string) => void;
}) {
  const waiting = run.state === 'waiting' || run.state === 'ask';
  const reviewer = run.review.reviewerName ?? detail.review.reviewerName ?? null;
  const reviewerAi = ais.find((m) => m.id === run.review.reviewerId);
  const lastRunId = run.runIds[run.runIds.length - 1];
  const num = lastRunId ? runNumber(lastRunId) : undefined;
  const hasReview = !!run.review.verdict;
  return (
    <div className={`sc-slot ${open ? 'sc-slot-open' : ''}`} data-testid="slot" data-state={run.state}>
      <button type="button" className="sc-slot-head" onClick={onToggle} aria-expanded={open}>
        <ChevronIcon size={14} dir={open ? 'down' : 'right'} />
        <b className="sc-slot-time">{fmtSlot(run.slotAt)}</b>
        <SlotChip state={run.state} verbose />
        {run.catchUp && run.state !== 'running' && <CatchUpChip />}
        <span className="sc-slot-note">{run.note ?? ''}</span>
        <span className="ai-muted sc-slot-dur">{fmtDuration(run.durationS)}</span>
      </button>
      {open && (
        <div className="sc-slot-body">
          {waiting && <SlotActions run={run} ais={ais} onDone={() => undefined} />}
          <div className="sc-slot-cols">
            <div>
              <div className="ai-label ai-label-dark">DONE WHEN</div>
              {run.results.length ? (
                run.results.map((r) => <ResultLine key={r.key} r={r} reviewer={reviewer} />)
              ) : (
                <div className="ai-muted" style={{ marginTop: 6 }}>
                  {run.state === 'skipped' || waiting
                    ? 'Nothing ran, so nothing was checked.'
                    : 'No checks were evaluated.'}
                </div>
              )}
            </div>
            <div>
              <div className="ai-label ai-label-dark">AI REVIEW</div>
              {hasReview ? (
                <>
                  <div className="sc-reviewer">
                    {reviewerAi ? <AiAvatar provider={reviewerAi.provider} size={26} /> : <SparkleIcon size={16} />}
                    <b>{reviewer ?? 'Reviewer'}</b>
                    {run.review.verdict === 'pass' ? (
                      <Pill tone="green" icon={<CheckCircleIcon size={11} />}>
                        Passed
                      </Pill>
                    ) : (
                      <Pill tone="amber" icon={<WarnIcon size={11} />}>
                        Needs changes
                      </Pill>
                    )}
                  </div>
                  {run.review.notes && <div className="sc-review-notes">{run.review.notes}</div>}
                  {run.review.fixes && run.review.fixes.length > 0 && (
                    <ul className="sc-fixes">
                      {run.review.fixes.map((f) => (
                        <li key={f}>{f}</li>
                      ))}
                    </ul>
                  )}
                </>
              ) : (
                <div className="ai-muted" style={{ marginTop: 6 }}>
                  {detail.review.on ? 'No review for this run.' : 'AI review is off for this schedule.'}
                </div>
              )}
              <div className="ai-hint" style={{ marginTop: 8 }}>
                {run.memberName ? `Run by ${run.memberName}. ` : ''}
                {hasReview
                  ? `${run.review.rounds ?? 1} review round${(run.review.rounds ?? 1) === 1 ? '' : 's'}. `
                  : ''}
                {run.costUsd ? `${money(run.costUsd)}. ` : ''}
                {lastRunId && (
                  <button
                    type="button"
                    className="ai-link"
                    onClick={() => onOpenTicket(run.ticketId)}
                    data-testid="open-run"
                  >
                    Open run{num ? ` #${num}` : ''}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * One schedule and its history (D): stats, problems and every slot with how each "done when" check turned out
 * and what the reviewer said. Waiting slots offer the actions of F.
 */
export function ScheduleDetailLayer({
  scheduleId,
  projectId,
  onClose,
  onEdit,
  onOpenTicket,
}: {
  scheduleId: string;
  projectId: string;
  onClose: () => void;
  onEdit: (id: string) => void;
  onOpenTicket: (ticketId: string) => void;
}) {
  const toast = useToast();
  const q = useScheduleDetail(scheduleId);
  const d = q.data;
  const overview = useAiOverview(projectId);
  const ais = (overview.data?.members ?? []).filter(canStart);
  const ticketRuns = useTicketRuns(d?.ticketId);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['id']>('all');
  const [openIds, setOpenIds] = useState<Set<string> | null>(null);
  const [menu, setMenu] = useState(false);
  const firstRef = useRef<HTMLDivElement>(null);
  const pause = useScheduleMutation(() => scheduleApi.pause(scheduleId));
  const resume = useScheduleMutation(() => scheduleApi.resume(scheduleId));
  const runNow = useScheduleMutation(() => scheduleApi.runNow(scheduleId));
  const remove = useScheduleMutation(() => scheduleApi.remove(scheduleId));

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      // The editor opened above this layer takes the key first
      if (e.key === 'Escape' && !document.querySelector('[data-testid="schedule-editor"]')) onClose();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);

  if (!d) {
    return (
      <div className="ai-overlay" style={{ zIndex: 1000 }} onMouseDown={onClose}>
        <div className="ai-modal ai-root" style={{ width: 300, alignItems: 'center', padding: 40 }}>
          {q.isError ? <span className="ai-muted">This schedule no longer exists.</span> : <span className="ai-spin" />}
        </div>
      </div>
    );
  }

  // Waiting slots start open; the rest start closed except the newest
  const defaultOpen = new Set(
    d.runs.filter((r, i) => r.state === 'waiting' || r.state === 'ask' || i === 0).map((r) => r.id),
  );
  const opened = openIds ?? defaultOpen;
  const toggle = (id: string) => {
    const next = new Set(opened);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOpenIds(next);
  };
  const runs = d.runs.filter((r) => filter === 'all' || r.state === filter);
  const numberOf = (id: string) => ticketRuns.data?.find((r) => r.id === id)?.number;
  const autoPaused = d.state === 'paused' && d.failuresInRow >= 3;
  const last = d.runs[0];
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) toast.success(ok);
    } catch (err) {
      toast.error("That didn't work", extractError(err));
    }
  };

  return (
    <div className="ai-overlay" style={{ zIndex: 1000 }} onMouseDown={onClose} data-testid="schedule-detail">
      <div
        className="sc-detail ai-modal ai-root"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Schedule"
      >
        <div className="sc-detail-body">
          <div className="sc-detail-head">
            <div className="sc-grow">
              <div className="sc-inline">
                <TicketLine id={d.ticketId} status={d.ticketStatus} />
                <ScheduleStateChip state={d.state} />
              </div>
              <h2 className="sc-detail-title">{d.ticketTitle ?? d.ticketId}</h2>
              <div className="ai-hint" data-testid="schedule-line">
                {scheduleLine(d, { tz: true })}
              </div>
            </div>
            <div className="sc-inline" style={{ alignSelf: 'flex-start' }}>
              <button
                type="button"
                className="ai-btn"
                onClick={() => void act(() => runNow.mutateAsync(undefined), 'Run started')}
                disabled={runNow.isPending || d.state === 'ended'}
                data-testid="run-now"
              >
                <PlayIcon size={13} /> Run now
              </button>
              {d.state === 'paused' ? (
                <button
                  type="button"
                  className="ai-btn"
                  onClick={() => void act(() => resume.mutateAsync(undefined), 'Schedule resumed')}
                  disabled={resume.isPending}
                  data-testid="resume"
                >
                  <PlayIcon size={13} /> Resume
                </button>
              ) : (
                <button
                  type="button"
                  className="ai-btn"
                  onClick={() => void act(() => pause.mutateAsync(undefined), 'Schedule paused')}
                  disabled={pause.isPending || d.state === 'ended'}
                  data-testid="pause"
                >
                  <PauseIcon size={13} /> Pause
                </button>
              )}
              <button type="button" className="ai-btn" onClick={() => onEdit(d.id)} data-testid="edit">
                <PencilIcon size={13} /> Edit
              </button>
              <div className="sc-pop-wrap">
                <button
                  type="button"
                  className="ai-icobtn"
                  aria-label="More"
                  onClick={() => setMenu((v) => !v)}
                  data-testid="more"
                >
                  <span style={{ fontWeight: 800, letterSpacing: 1 }}>···</span>
                </button>
                {menu && (
                  <div className="sc-pop" style={{ right: 0, left: 'auto', minWidth: 190 }}>
                    <button
                      type="button"
                      className="ai-mi"
                      onClick={() => {
                        setMenu(false);
                        onOpenTicket(d.ticketId);
                      }}
                    >
                      Open {d.ticketId}
                    </button>
                    <button
                      type="button"
                      className="ai-mi ai-mi-danger"
                      data-testid="delete"
                      onClick={() => {
                        setMenu(false);
                        if (!window.confirm(`Delete the schedule for ${d.ticketId} and its run history?`)) return;
                        void act(async () => {
                          await remove.mutateAsync(undefined);
                          onClose();
                        }, 'Schedule deleted');
                      }}
                    >
                      Delete schedule
                    </button>
                  </div>
                )}
              </div>
              <button type="button" className="ai-icobtn" onClick={onClose} aria-label="Close">
                <CloseIcon size={16} />
              </button>
            </div>
          </div>

          {autoPaused && (
            <div className="ai-notice ai-notice-error sc-notice" data-testid="auto-paused">
              <PauseIcon size={16} />
              <div className="sc-grow">
                <b>Schedule paused for {d.ticketId}</b>
                <div>
                  Failed {d.failuresInRow} runs in a row{last?.note ? `: ${last.note.replace(/\.$/, '')}` : ''}.{' '}
                  {d.createdBy} was told. Fix the cause, then resume.
                </div>
                <div className="sc-inline" style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    className="ai-btn ai-btn-sm"
                    onClick={() => {
                      if (last) setOpenIds(new Set([...opened, last.id]));
                      firstRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }}
                  >
                    See last run
                  </button>
                  <button
                    type="button"
                    className="ai-btn ai-btn-sm ai-btn-primary"
                    onClick={() => void act(() => resume.mutateAsync(undefined), 'Schedule resumed')}
                  >
                    Resume
                  </button>
                </div>
              </div>
            </div>
          )}
          {d.state === 'paused' && !autoPaused && d.pausedReason && (
            <div className="ai-notice ai-notice-slate sc-notice">
              <PauseIcon size={16} />
              <div>{d.pausedReason}. No new runs start until it is resumed.</div>
            </div>
          )}
          {d.ticketChanged && (
            <div className="ai-notice ai-notice-slate sc-notice" data-testid="ticket-changed">
              <InfoIcon size={16} />
              <div>
                <b>{d.ticketId} was edited since you scheduled it</b>
                <div>
                  The AI reads the latest ticket at run time. If the ticket is Done or deleted, the run is skipped.
                </div>
              </div>
            </div>
          )}
          {d.problems
            .filter((p) => p.level === 'error')
            .map((p) => (
              <div key={`${p.key}-${p.text}`} className="ai-notice ai-notice-error sc-notice" data-testid="problem">
                <WarnIcon size={16} />
                <div>{p.text}</div>
              </div>
            ))}
          {d.problems.some((p) => p.level === 'warn') && (
            <div className="ai-notice ai-notice-warn sc-notice" data-testid="problem-warnings">
              <WarnIcon size={16} />
              <div>
                {d.problems
                  .filter((p) => p.level === 'warn')
                  .map((p) => (
                    <div key={`${p.key}-${p.text}`}>{p.text}</div>
                  ))}
              </div>
            </div>
          )}

          <div className="sc-tiles">
            <Tile
              label="NEXT RUN"
              value={
                d.state === 'active' && d.nextRunAt ? fmtNext(d.nextRunAt) : d.state === 'paused' ? 'Paused' : 'None'
              }
              sub={
                d.state === 'active'
                  ? (d.nextIn ?? '')
                  : d.state === 'paused'
                    ? 'Resume to continue'
                    : 'The schedule ended'
              }
            />
            <Tile
              label="PASSED"
              value={`${d.stats.passed} of ${d.stats.of}`}
              sub={`last ${d.stats.of} run${d.stats.of === 1 ? '' : 's'}`}
            />
            <Tile
              label="AVERAGE TIME"
              value={fmtMinutes(d.stats.avgS)}
              sub={d.stats.metered ? money(d.stats.cost) : 'Not metered'}
            />
            <Tile
              label="REVIEW ROUNDS"
              value={d.stats.reviewRounds == null ? '–' : String(d.stats.reviewRounds)}
              sub="per run"
            />
          </div>

          <div className="sc-hist-head" ref={firstRef}>
            <b style={{ fontSize: 15 }}>Run history</b>
            <span className="ai-tab-count" style={{ background: '#DCEEE1', color: '#2E6F40' }}>
              {d.runs.length}
            </span>
            <span className="sc-grow" />
            <select
              className="ai-select"
              style={{ width: 160 }}
              value={filter}
              onChange={(e) => setFilter(e.target.value as typeof filter)}
              aria-label="Filter runs"
              data-testid="run-filter"
            >
              {FILTERS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>
          {runs.length === 0 ? (
            <div className="ai-card" style={{ padding: 20, textAlign: 'center' }} data-testid="no-runs">
              <b>{d.runs.length ? 'No runs match this filter' : 'Never run yet'}</b>
              <div className="ai-hint">
                {d.runs.length
                  ? 'Pick “All results” to see every run.'
                  : d.nextRunAt
                    ? `The first run is planned for ${fmtNext(d.nextRunAt)}.`
                    : 'Use Run now to start one.'}
              </div>
            </div>
          ) : (
            runs.map((r) => (
              <SlotRow
                key={r.id}
                run={r}
                detail={d}
                open={opened.has(r.id)}
                onToggle={() => toggle(r.id)}
                ais={ais}
                runNumber={numberOf}
                onOpenTicket={onOpenTicket}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
