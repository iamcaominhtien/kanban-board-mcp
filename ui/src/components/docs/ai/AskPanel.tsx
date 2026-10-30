import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import '../docs.css';
import { Icon } from '../Icon';
import { docsAiError, useCancelDocsAiJob, useDocsAiJob, useDocsAiState } from '../../../api/docsAi';
import {
  askDocsApi,
  askResult,
  useAskDocs,
  useReportStale,
  type AskScope,
  type AskSource,
} from '../../../api/docsAiAsk';
import { useDocsPage } from '../../../api/docs';
import { useAssist } from '../../assist/AssistContext';
import {
  answerParts,
  askScopes,
  askView,
  copyText,
  defaultScope,
  footerLine,
  justEdited,
  openTarget,
  reportTarget,
  sourcesOf,
  tooLongLine,
} from '../../../utils/askRules';
import { relativeTime } from '../../../utils/relativeTime';

const MUTED = '#5B6B60';
const LINE = '#E3E8E5';

const smallBtn: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  padding: '5px 11px',
  borderRadius: 8,
  border: `1px solid ${LINE}`,
  background: '#FFFFFF',
  color: '#1E2A22',
  fontSize: 12.5,
  fontWeight: 600,
  fontFamily: 'inherit',
  cursor: 'pointer',
};
const primaryBtn: CSSProperties = { ...smallBtn, background: '#2E6F40', borderColor: '#2E6F40', color: '#FFFFFF' };
const label: CSSProperties = { fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', color: '#6B7A70' };

function editedLabel(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function Sources({ sources, onOpen }: { sources: (AskSource & { n?: number })[]; onOpen: (s: AskSource) => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="ask-sources">
      <div style={label}>SOURCES</div>
      {sources.map((s, i) => (
        <button
          key={`${s.pageId}-${s.heading}-${i}`}
          type="button"
          onClick={() => onOpen(s)}
          style={{
            display: 'flex',
            gap: 10,
            textAlign: 'left',
            padding: '8px 10px',
            border: `1px solid ${LINE}`,
            borderRadius: 8,
            background: '#FBFCFB',
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          <span
            style={{
              width: 18,
              height: 18,
              borderRadius: 9,
              background: '#E8F1EA',
              color: '#2E6F40',
              fontSize: 11,
              fontWeight: 700,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            {s.n ?? i + 1}
          </span>
          <span style={{ minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 12.5, fontWeight: 700, color: '#1E2A22' }}>
              {s.path.join(' › ')}
              {s.heading !== s.title && <span style={{ color: MUTED, fontWeight: 600 }}> {`› # ${s.heading}`}</span>}
              <span style={{ color: '#9AA8A0', fontWeight: 500 }}> · Edited {editedLabel(s.editedAt)}</span>
            </span>
            <span style={{ display: 'block', fontSize: 12, color: MUTED, marginTop: 2 }}>…{s.quote}…</span>
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * The Ask tab of the search palette (docs-ai C): ask a question, get an answer with its sources, "the docs do not
 * say" with the closest pages, or both sides when pages disagree. Nothing runs until Enter; it never edits a page.
 */
export function AskPanel({
  projectId,
  projectName,
  pageId,
  initialQuestion = '',
  onSwitchToSearch,
  onClose,
  onOpenPage,
  onSearchWords,
  onWritePage,
}: {
  projectId: string;
  projectName: string;
  /** The open page; enables the "This page" scope. */
  pageId?: string;
  initialQuestion?: string;
  /** Tab: back to Search, keeping the typed words. */
  onSwitchToSearch: (q: string) => void;
  onClose: () => void;
  onOpenPage: (id: string, anchor?: string) => void;
  /** "Search these words" (opens Search with the question). */
  onSearchWords?: (q: string) => void;
  /** "Draft a page from this question" (Write with AI). Hidden when not wired. */
  onWritePage?: (question: string) => void;
}) {
  const assist = useAssist();
  const state = useDocsAiState(projectId);
  const [q, setQ] = useState(initialQuestion);
  const [scope, setScope] = useState<AskScope>(defaultScope(!!pageId, pageId ? 'page' : 'space'));
  const [jobId, setJobId] = useState<string | null>(null);
  const [asked, setAsked] = useState('');
  const [startError, setStartError] = useState<{ code: string; detail: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [rating, setRating] = useState<'up' | 'down' | null>(null);
  const [rateOpen, setRateOpen] = useState(false);
  const [reported, setReported] = useState<string[]>([]);
  const [chatError, setChatError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const start = useAskDocs(projectId);
  const report = useReportStale();
  const cancel = useCancelDocsAiJob();
  const job = useDocsAiJob(jobId);
  const page = useDocsPage(scope === 'page' && pageId ? pageId : null);

  useEffect(() => inputRef.current?.focus(), []);

  const j = job.data;
  const running = start.isPending || (!!jobId && (!j || j.state === 'queued' || j.state === 'running'));
  const result = askResult(j);
  const failed = j && (j.state === 'failed' || j.state === 'cancelled') ? j.error : null;
  const error = startError ?? (failed ? { code: failed.code ?? 'error', detail: failed.message ?? 'Failed.' } : null);
  const view = askView(running, result, error);
  const noMember = state.data?.state === 'no_member';
  const chips = askScopes(!!pageId);

  const ask = async (question = q, wantScope = scope) => {
    const text = question.trim();
    if (!text || running) return;
    setStartError(null);
    setRating(null);
    setRateOpen(false);
    setReported([]);
    setChatError(null);
    setAsked(text);
    setJobId(null);
    try {
      const created = await start.mutateAsync({
        question: text,
        scope: wantScope,
        pageId: wantScope === 'page' ? pageId : null,
      });
      setJobId(created.id);
    } catch (e) {
      setStartError(docsAiError(e) ?? { code: 'error', detail: 'Couldn’t reach the server.' });
    }
  };

  const open = (s: AskSource) => {
    const t = openTarget(s);
    onOpenPage(t.pageId, t.anchor);
  };

  const openChat = async () => {
    if (!jobId) return;
    try {
      const { chatId } = await askDocsApi.openAsChat(jobId);
      assist?.openChat(
        chatId,
        result?.scope === 'page' ? { scope: 'doc', docId: result.pageId } : { scope: 'project' },
      );
      onClose();
    } catch (e) {
      setChatError(docsAiError(e)?.detail ?? 'Couldn’t open the chat.');
    }
  };

  const copy = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(copyText(result));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  const rate = async (r: 'up' | 'down') => {
    if (!jobId) return;
    setRating(r);
    setRateOpen(false);
    try {
      await askDocsApi.feedback(jobId, r);
    } catch {
      setRating(null);
    }
  };

  const sections = useMemo(() => {
    if (!result?.tooLong || !page.data) return [];
    return page.data.headings.slice(result.tooLong.readSections).slice(0, 12);
  }, [result, page.data]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      onSwitchToSearch(q);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      void ask();
    }
  };

  const tabBtn = (id: 'search' | 'ask', text: string) => (
    <button
      type="button"
      className={`dk-tabs-btn${id === 'ask' ? ' dk-tabs-btn-on' : ''}`}
      style={{ padding: '4px 11px' }}
      aria-pressed={id === 'ask'}
      onClick={() => id === 'search' && onSwitchToSearch(q)}
    >
      {text}
    </button>
  );

  let body: ReactNode = null;
  if (noMember) {
    body = (
      <div style={{ padding: 18 }} data-testid="ask-no-member">
        <div style={{ fontWeight: 700, fontSize: 14 }}>No AI is set up for Docs</div>
        <div style={{ color: MUTED, fontSize: 12.5, margin: '4px 0 10px' }}>
          Pick an AI member that can read this project.
        </div>
        <button type="button" style={primaryBtn} onClick={() => assist?.onOpenAiMembers()}>
          Open AI members
        </button>
      </div>
    );
  } else if (view.kind === 'idle') {
    body = (
      <div style={{ padding: '18px 20px', color: MUTED, fontSize: 12.5, lineHeight: 1.6 }} data-testid="ask-idle">
        Ask a question and press <b>Enter</b>. It answers only from pages you can see, quotes the section it used and
        says “the docs do not say” instead of guessing. <b>Tab</b> goes back to Search.
      </div>
    );
  } else if (view.kind === 'thinking') {
    body = (
      <div style={{ padding: '18px 20px', display: 'flex', alignItems: 'center', gap: 10 }} data-testid="ask-thinking">
        <span className="mc-spin" />
        <span style={{ fontSize: 13, color: MUTED }}>
          {j?.steps.length ? j.steps[j.steps.length - 1].text : 'Looking through the docs…'}
        </span>
        {jobId && (
          <button type="button" style={{ ...smallBtn, marginLeft: 'auto' }} onClick={() => cancel.mutate(jobId)}>
            Stop
          </button>
        )}
      </div>
    );
  } else if (view.kind === 'error') {
    body = (
      <div style={{ padding: 18 }} data-testid="ask-error" data-code={view.code}>
        <div style={{ fontWeight: 700, fontSize: 14 }}>{view.title}</div>
        <div style={{ color: MUTED, fontSize: 12.5, margin: '4px 0 10px' }}>{view.detail}</div>
        {view.action === 'usage' && (
          <button type="button" style={smallBtn} onClick={() => assist?.onOpenSettings()}>
            See usage
          </button>
        )}
        {view.action === 'members' && (
          <button type="button" style={smallBtn} onClick={() => assist?.onOpenAiMembers()}>
            Open AI members
          </button>
        )}
        {view.action === 'retry' && (
          <button type="button" style={smallBtn} onClick={() => void ask(asked)}>
            Try again
          </button>
        )}
      </div>
    );
  } else {
    const r = view.result;
    const sources = sourcesOf(r);
    const target = reportTarget(r);
    const longLine = tooLongLine(r);
    body = (
      <div
        style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}
        data-testid={`ask-${view.kind}`}
      >
        {view.kind === 'disagree' && <div style={{ fontWeight: 700, fontSize: 13 }}>Two pages disagree</div>}
        {view.kind === 'not_covered' && !/do not say/i.test(r.answer) && (
          <div style={{ fontWeight: 700, fontSize: 13 }}>The docs do not say</div>
        )}
        <div style={{ fontSize: 14, lineHeight: 1.6, color: '#1E2A22' }} data-testid="ask-answer">
          {answerParts(r.answer, r.citations).map((p, i) =>
            p.type === 'text' ? (
              <span key={i}>{p.text}</span>
            ) : (
              <sup key={i} style={{ color: '#2E6F40', fontWeight: 700, margin: '0 1px' }}>
                {p.n}
              </sup>
            ),
          )}
        </div>
        {longLine && (
          <div
            style={{ border: `1px solid ${LINE}`, borderRadius: 8, padding: '9px 12px', background: '#FFFBF0' }}
            data-testid="ask-too-long"
          >
            <div style={{ fontWeight: 700, fontSize: 12.5 }}>{longLine}</div>
            <div style={{ color: MUTED, fontSize: 12, margin: '2px 0 6px' }}>
              The page is longer than one request can hold. Pick a section to ask about it.
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {sections.length === 0 && <span style={{ fontSize: 12, color: MUTED }}>Choose a section</span>}
              {sections.map((h) => (
                <button
                  key={h.slug}
                  type="button"
                  style={smallBtn}
                  onClick={() => {
                    const next = `In the section “${h.text}”: ${asked}`;
                    setQ(next);
                    void ask(next);
                  }}
                >
                  # {h.text}
                </button>
              ))}
            </div>
          </div>
        )}
        {view.kind === 'answer' && sources.length > 0 && <Sources sources={sources} onOpen={open} />}
        {view.kind === 'disagree' && <Sources sources={r.conflicts} onOpen={open} />}
        {view.kind === 'not_covered' && r.closest.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="ask-closest">
            <div style={label}>CLOSEST PAGES</div>
            {r.closest.map((c) => (
              <button
                key={c.pageId}
                type="button"
                onClick={() => onOpenPage(c.pageId)}
                style={{
                  textAlign: 'left',
                  padding: '8px 10px',
                  border: `1px solid ${LINE}`,
                  borderRadius: 8,
                  background: '#FBFCFB',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                <span style={{ display: 'block', fontSize: 12.5, fontWeight: 700 }}>
                  {c.path.join(' › ')}
                  {c.heading !== c.title && (
                    <span style={{ color: MUTED, fontWeight: 600 }}>{` › # ${c.heading}`}</span>
                  )}
                </span>
                <span style={{ display: 'block', fontSize: 12, color: MUTED }}>{c.snippet}</span>
              </button>
            ))}
          </div>
        )}
        {view.kind === 'not_covered' && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {onSearchWords && (
              <button type="button" style={smallBtn} onClick={() => onSearchWords(asked)}>
                Search these words
              </button>
            )}
            {onWritePage && (
              <button type="button" style={smallBtn} onClick={() => onWritePage(asked)}>
                Draft a page from this question
              </button>
            )}
          </div>
        )}
        {view.kind === 'disagree' && target && (
          <div>
            <button
              type="button"
              style={smallBtn}
              disabled={reported.includes(target.pageId) || report.isPending}
              onClick={() => {
                const other = r.conflicts.find((c) => c.pageId !== target.pageId);
                report.mutate(
                  {
                    pageId: target.pageId,
                    jobId: jobId ?? undefined,
                    reason: `Ask the docs: “${asked}” — this page disagrees with ${other?.title ?? 'another page'}.`,
                  },
                  { onSuccess: () => setReported((x) => [...x, target.pageId]) },
                );
              }}
            >
              {reported.includes(target.pageId)
                ? `${target.title} added to Docs health`
                : `Report ${target.title} as out of date`}
            </button>
            <div style={{ fontSize: 11.5, color: '#6B7A70', marginTop: 3 }}>
              Adds it to Docs health. Nothing is edited.
            </div>
          </div>
        )}
        {justEdited(r) && (
          <div style={{ fontSize: 12, color: '#8A5A00' }} data-testid="ask-just-edited">
            Answers may miss a page you just saved. Pages show up in Ask about a minute after they are published. Drafts
            are never searched.
          </div>
        )}
        {!!r.injections?.length && (
          <div style={{ fontSize: 12, color: '#8A5A00' }}>
            Some page text read like instructions to an AI. It was treated as text, not followed.
          </div>
        )}
        {view.kind !== 'not_covered' || r.askedModel ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button type="button" style={smallBtn} onClick={() => void openChat()}>
              Open as chat
            </button>
            <button type="button" style={smallBtn} onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy'}
            </button>
            {rating ? (
              <span style={{ fontSize: 12, color: MUTED }}>
                {rating === 'up' ? 'Thanks, noted.' : 'Thanks, we will look at it.'}
              </span>
            ) : rateOpen ? (
              <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                <button type="button" style={smallBtn} onClick={() => void rate('up')}>
                  Yes
                </button>
                <button type="button" style={smallBtn} onClick={() => void rate('down')}>
                  No
                </button>
              </span>
            ) : (
              <button type="button" style={smallBtn} onClick={() => setRateOpen(true)}>
                Was this right?
              </button>
            )}
          </div>
        ) : null}
        {chatError && <div style={{ fontSize: 12, color: '#B3261E' }}>{chatError}</div>}
        <div style={{ fontSize: 11.5, color: '#6B7A70' }} data-testid="ask-footer">
          {footerLine(r, j?.cost ?? 0, j?.metered ?? true)}
          {j?.endedAt && ` · answered ${relativeTime(j.endedAt)}`}
        </div>
      </div>
    );
  }

  return (
    <div
      className="docs-root"
      role="dialog"
      aria-modal="true"
      aria-label="Ask the docs"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(37,61,44,0.5)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '10vh',
        boxSizing: 'border-box',
      }}
    >
      <div style={{ width: 620, maxWidth: 'calc(100vw - 32px)' }}>
        <div
          style={{
            borderRadius: 14,
            border: `1px solid ${LINE}`,
            boxShadow: '0 24px 64px rgba(30,42,34,0.22)',
            background: '#FFFFFF',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '13px 18px',
              borderBottom: `1px solid ${LINE}`,
            }}
          >
            <Icon name="i09" size={18} strokeWidth={2} style={{ color: '#2E6F40' }} />
            <input
              ref={inputRef}
              className="fx-qinput"
              style={{ flex: 1 }}
              value={q}
              placeholder={`Ask ${projectName} docs a question…`}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={onKeyDown}
              spellCheck={false}
              autoComplete="off"
              aria-label={`Ask the ${projectName} docs`}
            />
            <div style={{ display: 'flex', gap: 4 }}>
              {tabBtn('search', 'Search')}
              {tabBtn('ask', 'Ask')}
            </div>
            <span style={{ fontSize: 11.5, color: MUTED }}>Esc</span>
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '9px 18px',
              borderBottom: '1px solid #EEF3EF',
              background: '#FBFCFB',
              flexWrap: 'wrap',
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 700, color: MUTED }}>In:</span>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {chips.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={`dk-tabs-btn${scope === c.id ? ' dk-tabs-btn-on' : ''}`}
                  style={{ padding: '4px 10px', whiteSpace: 'nowrap' }}
                  aria-pressed={scope === c.id}
                  onClick={() => {
                    setScope(c.id);
                    inputRef.current?.focus();
                  }}
                >
                  {c.label}
                </button>
              ))}
            </div>
            <span style={{ marginLeft: 'auto', fontSize: 11.5, color: '#6B7A70' }}>Enter to ask</span>
          </div>
          <div className="fx-scroll" style={{ maxHeight: 'min(520px, 66vh)', overflowY: 'auto', minHeight: 0 }}>
            {body}
          </div>
        </div>
      </div>
    </div>
  );
}
