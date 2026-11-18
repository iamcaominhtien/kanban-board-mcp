import { useState, type CSSProperties } from 'react';
import { docsAiError, useDocsAiState } from '../../../api/docsAi';
import { useDismissReason, useFreshness, useStillCorrect } from '../../../api/docsAiCare';
import type { DocsPage } from '../../../types/docs';
import {
  checkedLabel,
  DISMISS_LEVELS,
  firstTicketRef,
  showFreshnessBanner,
  type CareReason,
} from '../../../utils/careRules';
import { useDocsRefs } from '../DocsRefsContext';
import '../docs.css';
import { SgIcon, Spark } from '../suggestions/sgIcons';
import '../suggestions/suggestions.css';

// a ticket named in a reason: the board's mono chip with a green dot (RichDocsAi2 frame 46)
const TICKET_CHIP: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11.5,
  fontWeight: 700,
  background: '#F6FAF7',
  border: '1px solid #E3E8E5',
  borderRadius: 5,
  padding: '0 6px',
  height: 20,
  boxSizing: 'border-box',
  verticalAlign: 1,
  color: '#2B3A2F',
  marginRight: 4,
};

function Reason({
  r,
  busy,
  onDismiss,
}: {
  r: CareReason;
  busy: boolean;
  onDismiss: (key: string, level: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li style={{ listStyle: 'none', color: '#1E2A22' }} data-testid="freshness-reason">
      •{' '}
      {r.kind === 'ticket' && (
        <code style={TICKET_CHIP}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#2E6F40' }} />
          {r.ref}
        </code>
      )}
      {r.text}
      <span style={{ color: '#5B6B60', marginLeft: 8 }} title="What was compared">
        Compared: {r.compared}
      </span>
      <span style={{ position: 'relative', marginLeft: 8 }}>
        <button
          type="button"
          aria-label="Dismiss this reason"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          disabled={busy}
          style={{
            font: 'inherit',
            fontSize: 11.5,
            border: 'none',
            background: 'none',
            color: '#7c5cd6',
            cursor: 'pointer',
            padding: 0,
          }}
        >
          Dismiss
        </button>
        {open && (
          <span
            role="menu"
            style={{
              position: 'absolute',
              left: 0,
              top: '100%',
              zIndex: 5,
              background: '#fff',
              border: '1px solid #E3E8E5',
              borderRadius: 8,
              boxShadow: '0 8px 24px rgba(30,42,34,0.16)',
              padding: 4,
              display: 'flex',
              flexDirection: 'column',
              minWidth: 140,
            }}
          >
            {DISMISS_LEVELS.map((l) => (
              <button
                key={l.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onDismiss(r.key, l.id);
                }}
                style={{
                  font: 'inherit',
                  fontSize: 12.5,
                  textAlign: 'left',
                  border: 'none',
                  background: 'none',
                  padding: '6px 10px',
                  cursor: 'pointer',
                  borderRadius: 6,
                }}
              >
                {l.label}
              </button>
            ))}
          </span>
        )}
      </span>
    </li>
  );
}

/**
 * "This page may be out of date" with the reasons, Still correct and Open KAN-12
 * (docs-ai-care A1). Shown only to people who can edit the page, when Docs AI is on and the check flagged the page.
 */
export function FreshnessBanner({
  projectId,
  page,
  canEdit,
  onOpenTicket,
}: {
  projectId: string;
  page: DocsPage;
  canEdit: boolean;
  onOpenTicket?: (ticketId: string) => void;
}) {
  const state = useDocsAiState(projectId);
  const aiOn = state.data?.state === 'ready';
  const q = useFreshness(page.id, canEdit && aiOn && page.version > 0);
  const still = useStillCorrect(page.id);
  const dismiss = useDismissReason(page.id);
  const refs = useDocsRefs();
  const check = q.data;
  if (!showFreshnessBanner({ canEdit, aiOn, stale: !!check?.stale }) || !check) return null;
  const open = onOpenTicket ?? refs?.openTicket;
  const ticket = firstTicketRef(check.reasons);
  const err = [still.error, dismiss.error].map((e) => (e ? docsAiError(e)?.detail : null)).find(Boolean);
  return (
    <section
      aria-label="This page may be out of date"
      data-testid="freshness-banner"
      style={{
        margin: '0 0 16px',
        padding: '12px 14px',
        borderRadius: 10,
        border: '1px solid #EBD3A4',
        background: '#FEF6E3',
        display: 'flex',
        flexDirection: 'column',
        gap: 7,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <SgIcon name="warning" size={15} sw={2.2} color="#8A5A00" />
        <b style={{ fontSize: 13.5, color: '#1E2A22', flex: 1 }}>This page may be out of date</b>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            height: 20,
            boxSizing: 'border-box',
            fontSize: 11,
            fontWeight: 700,
            color: '#5B3AA6',
            background: '#EFE8FB',
            border: '1px solid #D9CCF7',
            borderRadius: 999,
            padding: '0 8px',
            whiteSpace: 'nowrap',
            flex: 'none',
          }}
        >
          <Spark size={11} color="#5B3AA6" /> {checkedLabel(check.checkedAt)}
        </span>
      </div>
      <ul
        style={{
          margin: 0,
          padding: 0,
          fontSize: 12.5,
          lineHeight: 1.6,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        {check.reasons.map((r) => (
          <Reason
            key={r.key}
            r={r}
            busy={dismiss.isPending}
            onDismiss={(key, level) => dismiss.mutate({ key, level: level as 'once' | '30d' | 'never' })}
          />
        ))}
      </ul>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button
          type="button"
          disabled={still.isPending}
          onClick={() => still.mutate()}
          className="sg-btn"
          data-testid="freshness-still-correct"
        >
          Still correct
        </button>
        {ticket && open && (
          <button type="button" onClick={() => open(ticket)} className="sg-btn">
            <SgIcon name="external" size={13} sw={2.4} /> Open {ticket}
          </button>
        )}
        <span style={{ fontSize: 12, color: '#5B6B60' }}>“Still correct” hides this for 30 days</span>
      </div>
      {err && (
        <div role="alert" style={{ fontSize: 12.5, color: '#C4432A', marginTop: 8 }}>
          {err}
        </div>
      )}
    </section>
  );
}
