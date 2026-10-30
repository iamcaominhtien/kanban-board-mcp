import { useEffect, useRef, useState } from 'react';
import {
  pageAiProblem,
  usePageAiStart,
  usePageJob,
  type CheckFinding,
  type CheckResult,
  type FixResult,
} from '../../../api/docsAiPage';
import { cleanEditorMarkdown } from '../../../utils/docsMarkdown';
import { costLabel } from '../../../utils/docsAiRules';
import { FINDING_LABEL, applyFix, findingsTitle, fixDiff, problemLine } from '../../../utils/pageAiRules';
import { Icon } from '../Icon';
import './pageAi.css';

const PENDING = 'data-fix-pending';

/** One finding: what is wrong, then Fix as draft (a diff the person accepts with Tab or discards with Esc) or Ignore. */
function FindingCard({
  f,
  pageId,
  checkJobId,
  getMarkdown,
  setMarkdown,
  onGone,
}: {
  f: CheckFinding;
  pageId: string;
  checkJobId: string;
  getMarkdown: () => string;
  setMarkdown: (md: string) => void;
  onGone: (id: string) => void;
}) {
  const start = usePageAiStart(pageId);
  const [fixJob, setFixJob] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [discarded, setDiscarded] = useState(false);
  const { running, result, error } = usePageJob<FixResult>(fixJob);
  const asking = start.fix.isPending || (!!fixJob && running);
  const pending = result && !discarded ? result : null;

  const accept = () => {
    if (!result) return;
    const md = applyFix(cleanEditorMarkdown(getMarkdown()), result.old, result.new);
    if (md === null) {
      setProblem('That part of the page changed. Check the page again.');
      setDiscarded(true);
      return;
    }
    setMarkdown(md);
    onGone(f.id);
  };
  const discard = () => {
    setDiscarded(true);
    setFixJob(null);
  };
  const acceptRef = useRef(accept);
  acceptRef.current = accept;
  const discardRef = useRef(discard);
  discardRef.current = discard;
  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        acceptRef.current();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        discardRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending]);

  const fix = () => {
    setProblem(null);
    setDiscarded(false);
    start.fix.mutate(
      { findingId: f.id, markdown: cleanEditorMarkdown(getMarkdown()), jobId: checkJobId },
      {
        onSuccess: (job) => setFixJob(job.id),
        onError: (e) => {
          const p = pageAiProblem(e);
          setProblem(problemLine(p.code, p.detail));
        },
      },
    );
  };
  const diff = pending ? fixDiff(pending.old, pending.new) : null;
  const failure = problem ?? (error ? problemLine(error.code, error.detail) : null);
  return (
    <div className="pai-finding" data-testid="check-finding" data-kind={f.kind} {...(pending ? { [PENDING]: '' } : {})}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="pai-kind" data-kind={f.kind}>
          {FINDING_LABEL[f.kind]}
        </span>
        <span style={{ flex: 1 }} />
        <span className="pai-foot">{f.section}</span>
      </div>
      <div className="pai-quote">“{f.quote}”</div>
      <div>{f.message}</div>
      {pending && diff && (
        <div className="pai-diff" data-testid="fix-diff" style={{ display: 'grid', gap: 6 }}>
          <div>
            {diff.before}
            {diff.removed && <del>{diff.removed}</del>}
            {diff.added && <ins>{diff.added}</ins>}
            {diff.after}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button type="button" className="st-btn st-btn-sm st-btn-primary" onClick={accept} data-testid="fix-accept">
              Accept <kbd>Tab</kbd>
            </button>
            <button type="button" className="st-btn st-btn-sm" onClick={discard} data-testid="fix-discard">
              Discard <kbd>Esc</kbd>
            </button>
            <span className="pai-foot">A normal change to your draft. Nothing is published.</span>
          </div>
        </div>
      )}
      {failure && (
        <div className="pai-err" role="alert">
          {failure}
        </div>
      )}
      {!pending && (
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            className="st-btn st-btn-sm pai-btn"
            disabled={asking}
            onClick={fix}
            data-testid="fix-as-draft"
          >
            {asking ? 'Writing the fix…' : 'Fix as draft'}
          </button>
          <button
            type="button"
            className="st-btn st-btn-sm"
            disabled={asking}
            data-testid="ignore-finding"
            onClick={() => start.ignore.mutate(f.id, { onSuccess: () => onGone(f.id) })}
          >
            Ignore
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * "Check this page" in the editor (docs-ai F2): reads the page (the draft being edited) and the project's style guide
 * page, and lists unclear text, gaps, unknown links and style problems. It changes nothing; Fix as draft makes a
 * change the person accepts, Ignore hides the finding for this page. Esc closes it.
 * @param props.pageId - The page being edited.
 * @param props.getMarkdown - The editor's current Markdown.
 * @param props.setMarkdown - Replaces the editor's content (used by an accepted fix).
 * @param props.onClose - Closes the panel.
 */
export function CheckThisPage({
  pageId,
  getMarkdown,
  setMarkdown,
  onClose,
}: {
  pageId: string;
  getMarkdown: () => string;
  setMarkdown: (md: string) => void;
  onClose: () => void;
}) {
  const start = usePageAiStart(pageId);
  const [jobId, setJobId] = useState<string | null>(null);
  const [startProblem, setStartProblem] = useState<{ code: string; detail: string } | null>(null);
  const [gone, setGone] = useState<Set<string>>(new Set());
  const { running, result, error } = usePageJob<CheckResult>(jobId);

  useEffect(() => {
    start.check.mutate(cleanEditorMarkdown(getMarkdown()), {
      onSuccess: (job) => setJobId(job.id),
      onError: (e) => setStartProblem(pageAiProblem(e)),
    });
    // one check each time the panel opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector(`[${PENDING}]`)) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const fail = startProblem ?? error;
  const waiting = !fail && (!jobId || running);
  const findings = (result?.findings ?? []).filter((f) => !gone.has(f.id));
  return (
    <div className="pai-check" role="region" aria-label="Check this page" data-testid="check-this-page">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon name="i17" size={18} strokeWidth={1.9} style={{ color: '#6b5bd2' }} />
        <b style={{ fontSize: 15 }}>Check this page</b>
        <span style={{ flex: 1 }} />
        {result && <span className="pai-tag">{findingsTitle(findings.length)}</span>}
        <button
          type="button"
          className="dk-icobtn"
          aria-label="Close"
          onClick={onClose}
          style={{ width: 26, height: 26 }}
        >
          <Icon name="close" size={13} strokeWidth={2} />
        </button>
      </div>
      <div className="pai-foot" style={{ fontSize: 12.5 }}>
        {result?.stylePage ? (
          <>
            Read this page and the style guide page <b>{result.stylePage.title}</b>. Nothing is changed.
          </>
        ) : (
          'Read this page. Nothing is changed.'
        )}
      </div>
      {waiting && (
        <div aria-live="polite" style={{ display: 'grid', gap: 8 }} data-testid="check-loading">
          <div className="pai-skel" style={{ width: '90%' }} />
          <div className="pai-skel" style={{ width: '65%' }} />
        </div>
      )}
      {fail && (
        <div className="pai-err" role="alert">
          {problemLine(fail.code, fail.detail)}
        </div>
      )}
      {result && findings.length === 0 && (
        <div style={{ fontSize: 13.5, color: '#3a4a3e' }}>
          Nothing to fix. {result.ignored > 0 ? `${result.ignored} ignored on this page.` : ''}
        </div>
      )}
      {jobId &&
        findings.map((f) => (
          <FindingCard
            key={f.id}
            f={f}
            pageId={pageId}
            checkJobId={jobId}
            getMarkdown={getMarkdown}
            setMarkdown={setMarkdown}
            onGone={(id) => setGone((g) => new Set(g).add(id))}
          />
        ))}
      <div style={{ display: 'flex', alignItems: 'center', fontSize: 12.5, color: '#5b6b60' }}>
        <span>{result ? costLabel(result.cost, result.metered) : ''}</span>
        <span style={{ flex: 1 }} />
        <span>
          <kbd>Esc</kbd> close
        </span>
      </div>
    </div>
  );
}
