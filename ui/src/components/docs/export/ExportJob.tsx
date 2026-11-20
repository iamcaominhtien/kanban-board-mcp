/**
 * An export once it has started (frames 14 to 22, 52 to 55): the progress list with steps that count up, then one
 * of the endings: ready (the download starts by itself), did not finish (where it stopped, two ways out), cancelled.
 * Also "too big" (the size, the limit and four ways to make it smaller) and the background card (23 to 25, 28).
 */

import { useEffect, useState } from 'react';
import type { DocsLayout } from '../../../hooks/useDocsLayout';
import type { ExportRow } from './exportApi';
import { ExportFrame, FormatBadge, ICONS, Svg } from './ExportFrame';
import {
  FORMAT_LABEL,
  fmtSize,
  isPaged,
  progressAt,
  progressSteps,
  type ExportBody,
  type ReduceChoice,
} from './exportModel';

/** An export this window follows. */
export interface ExportJob {
  row: ExportRow;
  /** What was asked for (Export again sends it again). */
  body: ExportBody;
  /** How many pages it covers. */
  pages: number;
  /** What it is of, for the card and the dialog ("Architecture", "Kanban Board docs"). */
  title: string;
  /** When it started here (ms). */
  startedAt: number;
  /** It runs without the dialog: the card shows it. */
  background: boolean;
  /** How many embeds become pictures (the one-line note); 0 for none. */
  embeds: number;
}

/** What the ending buttons do. */
export interface JobActions {
  onCancel: () => void;
  onKeepWorking: () => void;
  onDownload: () => void;
  onOpen: () => void;
  onCopyLink: () => void;
  onExportAgain: () => void;
  onOtherOptions: () => void;
  onClose: () => void;
}

function scopeLine(job: ExportJob): string {
  const f = FORMAT_LABEL[job.body.format];
  switch (job.body.scope) {
    case 'children':
      return `${f} · This page and ${job.pages - 1} child ${job.pages - 1 === 1 ? 'page' : 'pages'}`;
    case 'space':
      return `${f} · The whole space, ${job.pages} pages`;
    case 'book':
      return `${f} · A book of ${job.pages} pages`;
    default:
      return `${f} · This page`;
  }
}

/** Re-renders every `ms` while `on` (the steps count up). */
function useTick(on: boolean, ms = 400): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return undefined;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [on, ms]);
  return now;
}

/**
 * The progress list.
 * @param props.job - The export.
 */
export function ProgressSteps({ job }: { job: ExportJob }) {
  const now = useTick(job.row.state === 'running');
  const steps = progressSteps(job.body.format, job.pages);
  const { step, percent } = progressAt(steps.length, now - job.startedAt);
  return (
    <>
      <div className="dx-bar-line">
        <span>Exporting…</span>
        <span className="dx-bar-pct">{percent} %</span>
      </div>
      <div
        className="dx-bar"
        role="progressbar"
        aria-label="Export progress"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <i style={{ width: `${percent}%` }} />
      </div>
      <ol className="dx-steps" aria-live="polite">
        {steps.map((s, i) => (
          <li key={s} data-state={i < step ? 'done' : i === step ? 'now' : 'later'}>
            <span className="dx-dot">{i < step && <Svg d={ICONS.check} size={12} width={3.2} />}</span>
            {i === step && job.row.step && i === 0 ? job.row.step : s}
          </li>
        ))}
      </ol>
    </>
  );
}

function FileBox({ job, sub }: { job: ExportJob; sub: string }) {
  return (
    <div className="dx-file">
      <FormatBadge format={job.body.format} size={40} />
      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
        <b data-testid="export-job-file">{job.row.fileName}</b>
        <span>{sub}</span>
      </div>
    </div>
  );
}

/**
 * The dialog while an export runs, and its endings.
 * @param props.job - The export.
 * @param props.layout - The Docs layout.
 * @param props.actions - What the buttons do.
 */
export function JobDialog({ job, layout, actions }: { job: ExportJob; layout: DocsLayout; actions: JobActions }) {
  const state = job.row.state;
  const f = FORMAT_LABEL[job.body.format];
  const phone = layout === 'phone';
  if (state === 'running') {
    return (
      <ExportFrame
        layout={layout}
        label="Export"
        title="Export"
        subtitle={job.title}
        job="plain"
        onClose={actions.onKeepWorking}
        footer={
          <>
            {!phone && (
              <button type="button" className="st-btn" onClick={actions.onCancel} data-testid="export-cancel">
                Cancel export
              </button>
            )}
            <span className="dx-spacer" />
            <button
              type="button"
              className="st-btn st-btn-primary"
              onClick={actions.onKeepWorking}
              data-testid="export-keep-working"
            >
              Keep working
            </button>
          </>
        }
      >
        <div data-testid="export-progress" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <FileBox job={job} sub={scopeLine(job)} />
          <ProgressSteps job={job} />
          <p className="dx-line">You can keep working. This window can stay open or be closed.</p>
          {phone && (
            <button type="button" className="dx-link" onClick={actions.onCancel} data-testid="export-cancel">
              Cancel export
            </button>
          )}
        </div>
      </ExportFrame>
    );
  }
  if (state === 'ready') {
    const canOpen = job.body.format === 'pdf' || job.body.format === 'html';
    return (
      <ExportFrame
        layout={layout}
        label="Export"
        title="Export"
        subtitle={job.title}
        icon={ICONS.check}
        job="hero"
        onClose={actions.onClose}
        footer={
          <>
            <button type="button" className="st-btn" onClick={actions.onOtherOptions} data-testid="export-again">
              Export again
            </button>
            <span className="dx-spacer" />
            <button type="button" className="st-btn st-btn-primary" onClick={actions.onClose} data-testid="export-done">
              Done
            </button>
          </>
        }
      >
        <div data-testid="export-ready" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="dx-hero-text">
            <div className="dx-hero-title">Your {job.row.fileName?.endsWith('.zip') ? 'zip' : f} is ready</div>
            <p className="dx-hero-sub">The download started. If it did not, press Download.</p>
          </div>
          <FileBox
            job={job}
            sub={`${job.pages} ${job.pages === 1 ? 'page' : 'pages'} · ${fmtSize(job.row.size)} · just now`}
          />
          <div className="dx-actions">
            <button
              type="button"
              className="st-btn st-btn-primary"
              onClick={actions.onDownload}
              data-testid="export-download"
            >
              <Svg d={ICONS.download} size={14} /> Download
            </button>
            {canOpen && (
              <button type="button" className="st-btn" onClick={actions.onOpen} data-testid="export-open">
                Open
              </button>
            )}
            <button type="button" className="st-btn" onClick={actions.onCopyLink} data-testid="export-copy-link">
              Copy link
            </button>
          </div>
          {isPaged(job.body.format) && job.embeds > 0 && (
            <p className="dx-line dx-line-note">
              {job.embeds === 1 ? '1 embed is' : `${job.embeds} embeds are`} exported as pictures.
            </p>
          )}
          <p className="dx-line">The file is kept for 7 days. History lists it until then.</p>
        </div>
      </ExportFrame>
    );
  }
  if (state === 'cancelled') {
    return (
      <ExportFrame
        layout={layout}
        label="Export"
        title="Export"
        subtitle={job.title}
        tone="amber"
        icon={ICONS.stop}
        job="hero"
        onClose={actions.onClose}
        footer={
          <>
            <button type="button" className="st-btn st-btn-primary" onClick={actions.onExportAgain}>
              Export again
            </button>
            <button type="button" className="st-btn" onClick={actions.onOtherOptions}>
              Choose other options
            </button>
            <span className="dx-spacer" />
            <button type="button" className="st-btn" onClick={actions.onClose}>
              Close
            </button>
          </>
        }
      >
        <div data-testid="export-cancelled" className="dx-hero-text">
          <div className="dx-hero-title">Export cancelled</div>
          <p className="dx-hero-msg">
            Nothing was downloaded and your pages are not changed. It is listed in History as cancelled.
          </p>
        </div>
      </ExportFrame>
    );
  }
  // failed, or expired before it was seen
  const where = job.row.step
    ? `while ${job.row.step.charAt(0).toLowerCase()}${job.row.step.slice(1)}`
    : 'before the file was ready';
  return (
    <ExportFrame
      layout={layout}
      label="Export"
      title="Export"
      subtitle={job.title}
      tone="red"
      icon={ICONS.alert}
      job="hero"
      onClose={actions.onClose}
      footer={
        <>
          <button
            type="button"
            className="st-btn st-btn-primary"
            onClick={actions.onExportAgain}
            data-testid="export-retry"
          >
            Export again
          </button>
          <button type="button" className="st-btn" onClick={actions.onOtherOptions}>
            Choose other options
          </button>
          <span className="dx-spacer" />
          <button type="button" className="st-btn" onClick={actions.onClose}>
            Close
          </button>
        </>
      }
    >
      <div data-testid="export-failed" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div className="dx-hero-text">
          <div className="dx-hero-title">The export did not finish</div>
          <p className="dx-hero-msg">It stopped {where}. Nothing was downloaded and your pages are not changed.</p>
        </div>
        {job.row.error && (
          <details className="dx-details">
            <summary>Details</summary>
            <p style={{ margin: '6px 0 0' }}>{job.row.error}</p>
          </details>
        )}
      </div>
    </ExportFrame>
  );
}

/**
 * "This is too big to export in one go" (frame 17): the size, the limit, four ways to make it smaller.
 * @param props.size - The export's size in bytes.
 * @param props.limit - The limit in bytes.
 * @param props.choices - The ways to make it smaller.
 * @param props.onPick - Called with the chosen way ("Export smaller").
 */
export function TooBigDialog({
  layout,
  title,
  size,
  limit,
  choices,
  onPick,
  onCancel,
}: {
  layout: DocsLayout;
  title: string;
  size: number;
  limit: number;
  choices: ReduceChoice[];
  onPick: (c: ReduceChoice) => void;
  onCancel: () => void;
}) {
  const first = choices.find((c) => !c.disabled) ?? null;
  const [picked, setPicked] = useState<ReduceChoice['id'] | null>(first?.id ?? null);
  const choice = choices.find((c) => c.id === picked && !c.disabled) ?? null;
  return (
    <ExportFrame
      layout={layout}
      label="Export"
      title="Export"
      subtitle={title}
      tone="amber"
      icon={ICONS.alert}
      job="hero"
      onClose={onCancel}
      footer={
        <>
          {layout !== 'phone' && (
            <button type="button" className="st-btn" onClick={onCancel}>
              Cancel
            </button>
          )}
          <span className="dx-spacer" />
          <button
            type="button"
            className="st-btn st-btn-primary"
            disabled={!choice}
            onClick={() => choice && onPick(choice)}
            data-testid="export-smaller"
          >
            Export smaller
          </button>
        </>
      }
    >
      <div data-testid="export-too-big" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="dx-hero-text">
          <div className="dx-hero-title">This is too big to export in one go</div>
          <p className="dx-hero-msg">
            With pictures and videos it comes to about {fmtSize(size)}. The limit is {fmtSize(limit)}. Pick a way to
            make it smaller.
          </p>
        </div>
        <div className="dx-sizes">
          <div className="dx-over">
            <b data-testid="export-size">{fmtSize(size)}</b>
            this export
          </div>
          <div>
            <b data-testid="export-limit">{fmtSize(limit)}</b>
            the limit
          </div>
        </div>
        <div className="dx-choice-list" role="radiogroup" aria-label="Make it smaller">
          {choices.map((c) => (
            <button
              key={c.id}
              type="button"
              role="radio"
              className="dx-reduce"
              aria-checked={picked === c.id}
              disabled={c.disabled}
              onClick={() => setPicked(c.id)}
              data-testid={`export-reduce-${c.id}`}
            >
              <span className="dx-radio" />
              <span className="dx-scope-main">
                {c.title}
                <span>{c.hint}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </ExportFrame>
  );
}

/**
 * The cards at the bottom left of the Docs area for exports that run without the dialog (frames 23 to 25, 28).
 * @param props.jobs - The exports to show.
 * @param props.phone - Above the phone's bottom bar, full width.
 */
export function ExportCards({
  jobs,
  phone,
  onStop,
  onDownload,
  onExportAgain,
  onDismiss,
}: {
  jobs: ExportJob[];
  phone: boolean;
  onStop: (j: ExportJob) => void;
  onDownload: (j: ExportJob) => void;
  onExportAgain: (j: ExportJob) => void;
  onDismiss: (j: ExportJob) => void;
}) {
  if (!jobs.length) return null;
  return (
    <div className={`dx-cards docs-root${phone ? ' dx-cards-phone' : ''}`} data-testid="export-cards">
      {jobs.map((j) => (
        <div key={j.row.id} className="dx-card" role="status" data-testid="export-card" data-state={j.row.state}>
          {j.row.state === 'running' ? (
            <FormatBadge format={j.body.format} size={36} />
          ) : (
            <span className={`dx-card-ico${j.row.state === 'ready' ? '' : ' dx-card-ico-red'}`}>
              <Svg
                d={j.row.state === 'ready' ? ICONS.check : ICONS.alert}
                size={18}
                width={j.row.state === 'ready' ? 2.6 : 2.2}
              />
            </span>
          )}
          <div className="dx-card-main">
            {j.row.state === 'running' ? (
              <>
                <b>Exporting {j.title}</b>
                <span className="dx-card-sub">
                  {j.pages} {j.pages === 1 ? 'page' : 'pages'}. You can keep working.
                </span>
                <CardBar job={j} />
              </>
            ) : j.row.state === 'ready' ? (
              <>
                <b>Your export is ready</b>
                <span className="dx-card-sub">
                  {phone && j.row.fileName?.endsWith('.zip') ? 'The zip' : j.row.fileName} · {fmtSize(j.row.size)}
                </span>
              </>
            ) : (
              <>
                <b>The export did not finish</b>
                <span className="dx-card-sub">
                  {j.row.step
                    ? `It stopped while ${j.row.step.toLowerCase()}.`
                    : 'It stopped before the file was ready.'}
                </span>
              </>
            )}
          </div>
          {j.row.state === 'running' ? (
            <button type="button" className="dx-card-stop" onClick={() => onStop(j)} data-testid="export-card-stop">
              Stop
            </button>
          ) : j.row.state === 'ready' ? (
            <button
              type="button"
              className="st-btn st-btn-primary dx-card-btn"
              onClick={() => onDownload(j)}
              data-testid="export-card-download"
            >
              <Svg d={ICONS.download} size={14} /> Download
            </button>
          ) : (
            <button
              type="button"
              className="st-btn dx-card-btn"
              onClick={() => onExportAgain(j)}
              data-testid="export-card-again"
            >
              Export again
            </button>
          )}
          {j.row.state !== 'running' && (
            <button type="button" className="dk-icobtn dx-card-x" aria-label="Dismiss" onClick={() => onDismiss(j)}>
              <Svg d={ICONS.close} size={14} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function CardBar({ job }: { job: ExportJob }) {
  const now = useTick(true, 600);
  const steps = progressSteps(job.body.format, job.pages);
  const { percent } = progressAt(steps.length, now - job.startedAt);
  return (
    <div className="dx-bar" aria-hidden="true">
      <i style={{ width: `${percent}%` }} />
    </div>
  );
}
