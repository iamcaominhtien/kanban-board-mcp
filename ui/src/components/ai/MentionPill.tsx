import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { AiMember } from '../../types/ai';
import { aiAvailability, TONE_COLOR } from './aiAvailability';
import { ASSIGN_AI_EVENT, fireAiEvent, useAiTicket } from './AiTicketContext';
import {
  AiAvatar,
  CeilingChip,
  ConnectionChip,
  GlyphIcon,
  SparkleIcon,
  fmtElapsed,
  secondsSince,
  useAiBoardState,
  whenWords,
} from './aiUi';
import './ticketWork.css';

/** “@Name” of a mention link without its @ (an AI pill is a name, not a handle). */
function plainName(children: ReactNode): ReactNode {
  if (typeof children === 'string') return children.replace(/^@/, '');
  if (Array.isArray(children) && typeof children[0] === 'string')
    return [(children[0] as string).replace(/^@/, ''), ...children.slice(1)];
  return children;
}

/**
 * A mention in rendered text. A person stays a round blue pill; an AI member gets a pill in its own colour with
 * its glyph and a sparkle, and a hover card (what it is doing, its last run, its ceiling, Ask, Assign here, Profile).
 * An AI that cannot take work now is greyed out and struck through.
 */
export function MentionPill({ memberId, children }: { memberId: string; children: ReactNode }) {
  const { members } = useAiBoardState();
  const ai = members.get(memberId);
  if (!ai || ai.kind !== 'ai') {
    return (
      <span
        data-testid="mention-chip"
        data-member={memberId}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          height: 22,
          padding: '0 8px',
          borderRadius: 999,
          background: '#E8F1FB',
          border: '1px solid #B9D3EE',
          color: '#2F6FB0',
          fontSize: 13,
          fontWeight: 600,
          verticalAlign: 1,
          whiteSpace: 'nowrap',
        }}
      >
        {children}
      </span>
    );
  }
  return <AiMentionPill ai={ai}>{children}</AiMentionPill>;
}

const HOVER_SHOW = 'kanban:ai-hover-show';
const HOVER_HIDE = 'kanban:ai-hover-hide';

/**
 * Hover card of AI mentions. The pill itself only announces enter and leave: rendered text is rebuilt often (the
 * markdown renderer remounts its pills), so the card lives in one host that outlives them.
 */
export function AiHoverHost() {
  const { members } = useAiBoardState();
  const [state, setState] = useState<{ id: string; left: number; top: number } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    const show = (e: Event) => {
      const d = (e as CustomEvent<{ id: string; rect: DOMRect }>).detail;
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        const r = d.rect;
        const below = r.bottom + 8 + 300 < window.innerHeight;
        setState({
          id: d.id,
          left: Math.max(8, Math.min(r.left, window.innerWidth - 348)),
          top: below ? r.bottom + 8 : Math.max(8, r.top - 8 - 300),
        });
      }, 180);
    };
    const hide = () => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setState(null), 220);
    };
    window.addEventListener(HOVER_SHOW, show);
    window.addEventListener(HOVER_HIDE, hide);
    return () => {
      window.removeEventListener(HOVER_SHOW, show);
      window.removeEventListener(HOVER_HIDE, hide);
      window.clearTimeout(timer.current);
    };
  }, []);
  const ai = state ? members.get(state.id) : undefined;
  if (!state || !ai) return null;
  const keep = () => {
    window.clearTimeout(timer.current);
  };
  return createPortal(
    <div
      className="tw-hover ai-root"
      style={{ left: state.left, top: state.top }}
      onMouseEnter={keep}
      onMouseLeave={() => window.dispatchEvent(new Event(HOVER_HIDE))}
      data-testid="ai-hover-card"
    >
      <AiHoverCard ai={ai} onClose={() => setState(null)} />
    </div>,
    document.body,
  );
}

function AiMentionPill({ ai, children }: { ai: AiMember; children: ReactNode }) {
  const av = aiAvailability(ai);
  const announce = (el: HTMLElement) =>
    window.dispatchEvent(new CustomEvent(HOVER_SHOW, { detail: { id: ai.id, rect: el.getBoundingClientRect() } }));
  const off = !av.usable;
  const tint = off ? '#9AA8A0' : ai.color || '#2E6F40';
  return (
    <span
      tabIndex={0}
      role="button"
      data-testid="mention-chip"
      data-ai-mention="true"
      data-member={ai.id}
      data-state={av.tone}
      aria-label={`${ai.name}, ${av.label}`}
      onMouseEnter={(e) => announce(e.currentTarget)}
      onMouseLeave={() => window.dispatchEvent(new Event(HOVER_HIDE))}
      onFocus={(e) => announce(e.currentTarget)}
      onBlur={() => window.dispatchEvent(new Event(HOVER_HIDE))}
      className="tw-pill"
      style={{
        background: off ? '#F1F3F2' : `${tint}1A`,
        borderColor: off ? '#DCE3DF' : `${tint}66`,
        borderStyle: av.tone === 'warn' ? 'dashed' : 'solid',
        color: tint,
        textDecoration: off ? 'line-through' : undefined,
      }}
    >
      <GlyphIcon glyph={ai.glyph} size={12} />
      {plainName(children)}
      <SparkleIcon size={9} />
    </span>
  );
}

/** Hover card of an AI mention: Now, Last run, ceiling, Ask, Assign here, Profile. */
export function AiHoverCard({ ai, onClose }: { ai: AiMember; onClose: () => void }) {
  const av = aiAvailability(ai);
  const { ticketId, ask } = useAiTicket();
  const { openAiPage } = useAiBoardState();
  const run = ai.running.find((r) => r.state === 'running' || r.state === 'starting') ?? ai.running[0];
  const last = ai.lastRun;
  const metered = ai.connection === 'api_key' ? 'Metered' : 'Not metered';
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <AiAvatar provider={ai.provider} color={ai.color} glyph={ai.glyph} size={34} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{ai.name}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <span
              style={{ width: 7, height: 7, borderRadius: '50%', background: TONE_COLOR[av.tone], flexShrink: 0 }}
              aria-hidden="true"
            />
            <span style={{ color: av.tone === 'off' ? '#5B6B60' : TONE_COLOR[av.tone], fontWeight: 600 }}>
              {av.label}
            </span>
            <ConnectionChip connection={ai.connection} />
          </div>
        </div>
      </div>
      <div className="tw-kv">
        <span className="ai-label">Now</span>
        <span>
          {run ? (
            <>
              <b className="ai-mono" style={{ color: '#2E6F40' }}>
                {fmtElapsed(secondsSince(run.startedAt))}
              </b>{' '}
              <span className="ai-mono">{run.ticketId}</span>
              {run.ticketTitle ? <span className="ai-muted"> {run.ticketTitle}</span> : null}
            </>
          ) : (
            <span className="ai-muted" style={{ fontSize: 12.5 }}>
              Nothing right now
            </span>
          )}
        </span>
        <span className="ai-label">Last run</span>
        <span>
          {last ? (
            <>
              {whenWords(last.endedAt)} · <span className="ai-mono">{last.ticketId}</span>
              <div className="ai-muted">
                {last.state === 'finished' ? 'Finished' : last.state.replace('_', ' ')} · {metered}
              </div>
            </>
          ) : (
            <span className="ai-muted" style={{ fontSize: 12.5 }}>
              No runs yet
            </span>
          )}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
        <CeilingChip ceiling={ai.ceiling} />
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="ai-btn ai-btn-sm"
          disabled={!av.usable || !ticketId}
          title={!ticketId ? 'Open a ticket to ask' : !av.usable ? 'Not available now' : undefined}
          data-testid="hover-ask"
          onClick={() => {
            ask(ai.id);
            onClose();
          }}
        >
          Ask
        </button>
        <button
          type="button"
          className="ai-btn ai-btn-sm ai-btn-primary"
          disabled={!av.usable || !ticketId}
          title={!ticketId ? 'Open a ticket to assign' : !av.usable ? 'Not available now' : undefined}
          data-testid="hover-assign"
          onClick={() => {
            if (ticketId) fireAiEvent(ASSIGN_AI_EVENT, ticketId, ai.id);
            onClose();
          }}
        >
          Assign here
        </button>
        <button
          type="button"
          className="ai-link"
          data-testid="hover-profile"
          onClick={() => {
            openAiPage?.(ai.id);
            onClose();
          }}
        >
          Profile
        </button>
      </div>
    </div>
  );
}
