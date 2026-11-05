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
import { Icon } from '../Icon';
import '../docs.css';
import { LineIcon } from '../../ui/LineIcon';

const btn: CSSProperties = {
  font: 'inherit',
  fontSize: 12,
  fontWeight: 600,
  padding: '5px 10px',
  borderRadius: 8,
  border: '1px solid #E3E8E5',
  background: '#fff',
  color: '#1E2A22',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
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
    <li style={{ margin: '2px 0', fontSize: 12.5, lineHeight: 1.55, color: '#1E2A22' }} data-testid="freshness-reason">
      {r.kind === 'ticket' && (
        <code
          style={{
            fontFamily: 'ui-monospace, monospace',
            fontSize: 12,
            background: '#fff',
            border: '1px solid #E3E8E5',
            borderRadius: 5,
            padding: '0 5px',
            marginRight: 6,
          }}
        >
          {r.ref}
        </code>
      )}
      {r.text}
      <span style={{ color: '#9AA8A0', fontSize: 11.5, marginLeft: 8 }} title="What was compared">
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
  const hiddenFromAi = !!page.aiHidden;
  const q = useFreshness(page.id, canEdit && aiOn && !hiddenFromAi && page.version > 0);
  const still = useStillCorrect(page.id);
  const dismiss = useDismissReason(page.id);
  const refs = useDocsRefs();
  const check = q.data;
  if (!showFreshnessBanner({ canEdit, aiOn, stale: !!check?.stale, hiddenFromAi }) || !check) return null;
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
        border: '1px solid #F0DBA8',
        background: '#FFFBEF',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon name="i14" size={16} strokeWidth={2} style={{ color: '#B8860B' }} />
        <b style={{ fontSize: 13.5, color: '#1E2A22' }}>This page may be out of date</b>
        <span
          style={{
            marginLeft: 'auto',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            height: 21,
            boxSizing: 'border-box',
            fontSize: 11,
            fontWeight: 700,
            color: '#5b3aa6',
            background: '#efe8fb',
            borderRadius: 999,
            padding: '0 8px',
          }}
        >
          <LineIcon name="sparkle" size={12} /> {checkedLabel(check.checkedAt)}
        </span>
      </div>
      <ul style={{ margin: '0 0 0 4px', paddingLeft: 16 }}>
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
          style={btn}
          data-testid="freshness-still-correct"
        >
          Still correct
        </button>
        {ticket && open && (
          <button type="button" onClick={() => open(ticket)} style={btn}>
            <Icon name="i38" size={13} /> Open {ticket}
          </button>
        )}
        <span style={{ fontSize: 11.5, color: '#5B6B60' }}>“Still correct” hides this for 30 days</span>
      </div>
      {err && (
        <div role="alert" style={{ fontSize: 12.5, color: '#C4432A', marginTop: 8 }}>
          {err}
        </div>
      )}
    </section>
  );
}
