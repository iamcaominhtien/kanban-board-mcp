import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import '../docs.css';
import './pageAi.css';
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

function editedLabel(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function Cite({ n }: { n: number }) {
  return <span className="ask-cite">{n}</span>;
}

function Sources({
  sources,
  onOpen,
  title = 'Sources',
}: {
  sources: (AskSource & { n?: number })[];
  onOpen: (s: AskSource) => void;
  title?: string | null;
}) {
  return (
    <div className="ask-sources" data-testid="ask-sources">
      {title && <div className="ask-sources-h">{title}</div>}
      {sources.map((s, i) => (
        <button key={`${s.pageId}-${s.heading}-${i}`} type="button" className="ask-source" onClick={() => onOpen(s)}>
          <Cite n={s.n ?? i + 1} />
          <span style={{ flex: 1, minWidth: 0 }}>
            <span className="ask-source-title">
              <Icon name="page" size={13} strokeWidth={1.7} style={{ color: MUTED }} />
              {s.path.join(' › ')}
              {s.heading !== s.title && (
                <>
                  <Icon name="chevronRight" size={11} strokeWidth={1.7} style={{ color: '#9AA8A0' }} />
                  <span className="st-code"># {s.heading}</span>
                </>
              )}
            </span>
            <span className="ask-source-quote">
              …{s.quote}… <span style={{ color: MUTED }}>Edited {editedLabel(s.editedAt)}</span>
            </span>
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
  const [scope, setScope] = useState<AskScope>(defaultScope(!!pageId, 'space'));
  const [jobId, setJobId] = useState<string | null>(null);
  const [asked, setAsked] = useState('');
  const [startError, setStartError] = useState<{ code: string; detail: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [rating, setRating] = useState<'up' | 'down' | null>(null);
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
      className={id === 'ask' ? 'on' : ''}
      aria-pressed={id === 'ask'}
      onClick={() => id === 'search' && onSwitchToSearch(q)}
    >
      {text}
    </button>
  );

  let body: ReactNode = null;
  let footer: [string, string] | null = null;
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
    const line = footerLine(r, j?.cost ?? 0, j?.metered ?? true);
    const cut = line.indexOf(' · Index updated');
    const right = (cut >= 0 ? line.slice(cut + 3) : '') + (j?.endedAt ? ` · answered ${relativeTime(j.endedAt)}` : '');
    footer = [cut >= 0 ? line.slice(0, cut) : line, right];
    body = (
      <div
        style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}
        data-testid={`ask-${view.kind}`}
      >
        <div className="ask-lead">
          {view.kind === 'not_covered' && <InfoIcon />}
          {view.kind === 'disagree' && <WarnIcon />}
          <div
            style={{ fontSize: 13.5, lineHeight: view.kind === 'answer' ? 1.6 : 1.55, color: '#1E2A22' }}
            data-testid="ask-answer"
          >
            {view.kind === 'disagree' && !/disagree/i.test(r.answer.slice(0, 40)) && <b>Two pages disagree. </b>}
            {view.kind === 'not_covered' && !/do not say/i.test(r.answer) && <b>The docs do not say. </b>}
            {answerParts(r.answer, r.citations).map((p, i, all) =>
              p.type === 'text' ? (
                <span key={i}>{all[i + 1]?.type === 'cite' ? p.text.replace(/\s+$/, '') : p.text}</span>
              ) : (
                <Cite key={i} n={p.n} />
              ),
            )}
          </div>
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
        {view.kind === 'disagree' && <Sources sources={r.conflicts} onOpen={open} title={null} />}
        {view.kind === 'not_covered' && r.closest.length > 0 && (
          <div className="ask-sources" data-testid="ask-closest">
            <div className="ask-sources-h">Closest pages</div>
            {r.closest.map((c) => (
              <button key={c.pageId} type="button" className="ask-source" onClick={() => onOpenPage(c.pageId)}>
                <span className="ask-cite">·</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="ask-source-title">
                    <Icon name="page" size={13} strokeWidth={1.7} style={{ color: MUTED }} />
                    {c.path.join(' › ')}
                    {c.heading !== c.title && (
                      <>
                        <Icon name="chevronRight" size={11} strokeWidth={1.7} style={{ color: '#9AA8A0' }} />
                        <span className="st-code"># {c.heading}</span>
                      </>
                    )}
                  </span>
                  <span className="ask-source-quote">{c.snippet}</span>
                </span>
              </button>
            ))}
          </div>
        )}
        {view.kind === 'not_covered' && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {onSearchWords && (
              <button type="button" className="st-btn st-btn-sm" onClick={() => onSearchWords(asked)}>
                <Icon name="search" size={14} strokeWidth={1.7} />
                Search these words
              </button>
            )}
            {onWritePage && (
              <button type="button" className="st-btn st-btn-sm ask-ai-btn" onClick={() => onWritePage(asked)}>
                <PenIcon />
                Draft a page from this question
              </button>
            )}
          </div>
        )}
        {view.kind === 'disagree' && target && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button
              type="button"
              className="st-btn st-btn-sm ask-ai-btn"
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
              <FlagIcon />
              {reported.includes(target.pageId)
                ? `${target.title} added to Docs health`
                : `Report ${target.title} as out of date`}
            </button>
            <span style={{ fontSize: 12, color: MUTED }}>Adds it to Docs health. Nothing is edited.</span>
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
            <button type="button" className="st-btn st-btn-sm" onClick={() => void openChat()}>
              <ChatIcon />
              Open as chat
            </button>
            <button type="button" className="st-btn st-btn-sm" onClick={() => void copy()}>
              <CopyIcon />
              {copied ? 'Copied' : 'Copy'}
            </button>
            <span style={{ flex: 1 }} />
            {rating ? (
              <span style={{ fontSize: 12, color: MUTED }}>
                {rating === 'up' ? 'Thanks, noted.' : 'Thanks, we will look at it.'}
              </span>
            ) : (
              <>
                <span style={{ fontSize: 12, color: MUTED }}>Was this right?</span>
                <button type="button" className="dk-icobtn" aria-label="Yes" onClick={() => void rate('up')}>
                  <ThumbIcon />
                </button>
                <button type="button" className="dk-icobtn" aria-label="No" onClick={() => void rate('down')}>
                  <ThumbIcon down />
                </button>
              </>
            )}
          </div>
        ) : null}
        {chatError && <div style={{ fontSize: 12, color: '#B3261E' }}>{chatError}</div>}
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
              padding: '12px 14px',
              borderBottom: '1px solid #EEF3EF',
            }}
          >
            <AiSparkIcon />
            <input
              ref={inputRef}
              className="ask-qinput"
              value={q}
              placeholder={`Ask ${projectName} docs a question…`}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={onKeyDown}
              spellCheck={false}
              autoComplete="off"
              aria-label={`Ask the ${projectName} docs`}
            />
            <span className="ask-seg">
              {tabBtn('search', 'Search')}
              {tabBtn('ask', 'Ask')}
            </span>
            <span className="dk-kbd">Esc</span>
          </div>
          <div className="ask-scopes">
            <span style={{ fontSize: 12, color: MUTED }}>In:</span>
            {chips.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`ask-opt${scope === c.id ? ' ask-opt-on' : ''}`}
                aria-pressed={scope === c.id}
                onClick={() => {
                  setScope(c.id);
                  inputRef.current?.focus();
                }}
              >
                {c.label}
              </button>
            ))}
            <span style={{ marginLeft: 'auto', fontSize: 11.5, color: MUTED }}>Enter to ask</span>
          </div>
          <div className="fx-scroll" style={{ maxHeight: 'min(520px, 66vh)', overflowY: 'auto', minHeight: 0 }}>
            {body}
          </div>
          {footer && (
            <div className="ask-footer" data-testid="ask-footer">
              <span>{footer[0]}</span>
              <span style={{ flex: 1 }} />
              <span>{footer[1]}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const svgProps = {
  'aria-hidden': true,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

function ChatIcon() {
  return (
    <svg width={14} height={14} {...svgProps}>
      <path d="M21 12a8 8 0 0 1-11.5 7.2L4 20.5l1.4-4.6A8 8 0 1 1 21 12z" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width={14} height={14} {...svgProps}>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </svg>
  );
}

function ThumbIcon({ down = false }: { down?: boolean }) {
  return (
    <svg width={15} height={15} {...svgProps} style={down ? { transform: 'rotate(180deg)' } : undefined}>
      <path d="M7 11v9H4v-9zM7 11l4-7c1.5 0 2.5 1 2.5 2.5V10H19a2 2 0 0 1 2 2.3l-1 6A2 2 0 0 1 18 20H7" />
    </svg>
  );
}

function AiSparkIcon() {
  return (
    <svg width={16} height={16} {...svgProps} strokeWidth={2} style={{ color: '#7C5CD6', flexShrink: 0 }}>
      <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg width={18} height={18} {...svgProps} strokeWidth={2} style={{ color: '#7A5A06', flexShrink: 0 }}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </svg>
  );
}

function WarnIcon() {
  return (
    <svg width={18} height={18} {...svgProps} strokeWidth={2} style={{ color: '#B8860B', flexShrink: 0 }}>
      <path d="M12 4l9 16H3L12 4z" />
      <path d="M12 10v4M12 17v.5" />
    </svg>
  );
}

function PenIcon() {
  return (
    <svg width={14} height={14} {...svgProps} strokeWidth={2}>
      <path d="M4 20h4L19 9l-4-4L4 16v4z" />
      <path d="M13.5 6.5l4 4" />
    </svg>
  );
}

function FlagIcon() {
  return (
    <svg width={14} height={14} {...svgProps} strokeWidth={2}>
      <path d="M5 21V4M5 4h11l-2 4 2 4H5" />
    </svg>
  );
}
