import { useEffect, useState } from 'react';
import { LIVE_STATES, usePageWork, type PageWorkTicket } from '../../api/docsWork';

const STATE_WORD: Record<string, string> = {
  queued: 'Queued',
  starting: 'Starting',
  running: 'Running',
  needs_input: 'Needs you',
};

function elapsed(from: string | null, now: number): string {
  if (!from) return '';
  const s = Math.max(0, Math.round((now - new Date(from).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * "AI at work on this page" (#268): one line per AI run that is working now on a ticket tied to the page (a review the
 * page was given for, a spec a BA is writing), with what it is doing, so a reader sees it without opening the ticket.
 * Renders nothing when no AI is working.
 */
export function PageWork({ pageId, onOpenTicket }: { pageId: string; onOpenTicket: (ticketId: string) => void }) {
  const work = usePageWork(pageId).data;
  const live = (work?.tickets ?? []).filter((t): t is PageWorkTicket & { run: NonNullable<PageWorkTicket['run']> } =>
    Boolean(t.run && LIVE_STATES.includes(t.run.state)),
  );
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live.length) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [live.length]);
  if (!live.length) return null;
  return (
    <section
      aria-label="AI at work on this page"
      data-testid="docs-page-work"
      style={{
        margin: '0 0 20px',
        border: '1px solid #E2DAF6',
        background: '#F7F4FE',
        borderRadius: 10,
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      {live.map((t) => {
        const needs = t.run.state === 'needs_input';
        return (
          <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <span
              aria-hidden="true"
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                flexShrink: 0,
                background: needs ? '#C2410C' : '#7C5CD6',
                boxShadow: needs ? 'none' : '0 0 0 3px rgba(124,92,214,0.18)',
              }}
            />
            <span
              style={{
                fontSize: 13,
                color: '#1E2A22',
                minWidth: 0,
                flex: 1,
                overflow: 'hidden',
                whiteSpace: 'nowrap',
                textOverflow: 'ellipsis',
              }}
            >
              <strong style={{ fontWeight: 700 }}>{t.run.member}</strong>{' '}
              <span style={{ color: needs ? '#9A3412' : '#5B4A9E', fontWeight: 600 }}>
                {STATE_WORD[t.run.state] ?? t.run.state}
                {t.run.state === 'running' && t.run.startedAt ? ` · ${elapsed(t.run.startedAt, now)}` : ''}
              </span>
              {t.run.doing && (
                <span style={{ color: '#5B6B60', marginLeft: 8 }} title={t.run.doing}>
                  {t.run.doing}
                </span>
              )}
            </span>
            <button
              type="button"
              onClick={() => onOpenTicket(t.id)}
              title={t.title}
              style={{
                flexShrink: 0,
                border: '1px solid #DDD3F5',
                background: '#FFFFFF',
                borderRadius: 6,
                padding: '2px 8px',
                fontSize: 12,
                fontWeight: 700,
                fontFamily: "'JetBrains Mono', monospace",
                color: '#1E2A22',
                cursor: 'pointer',
              }}
            >
              {t.id}
            </button>
          </div>
        );
      })}
    </section>
  );
}
