import { useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { useDocsTree } from '../../../api/docs';
import { docsAiError } from '../../../api/docsAi';
import {
  healthItemId,
  useDismissHealth,
  useDocsHealth,
  useLinkTicketToPage,
  useRunHealth,
  type DocsHealth,
} from '../../../api/docsAiCare';
import {
  checkedLabel,
  defaultHealthTab,
  DISMISS_LEVELS,
  healthTabs,
  missingHeading,
  type DismissLevel,
  type HealthTab,
} from '../../../utils/careRules';
import { relativeTime } from '../../../utils/relativeTime';
import { Icon } from '../Icon';
import '../docs.css';

type Kind = 'out_of_date' | 'missing' | 'broken' | 'overlaps';

const th: CSSProperties = {
  textAlign: 'left',
  fontSize: 11,
  letterSpacing: 0.5,
  color: '#7A877F',
  fontWeight: 700,
  padding: '10px 14px',
};
const td: CSSProperties = {
  padding: '12px 14px',
  fontSize: 13.5,
  color: '#1E2A22',
  verticalAlign: 'top',
  borderTop: '1px solid #EEF3EF',
};
const btn: CSSProperties = {
  font: 'inherit',
  fontSize: 12.5,
  fontWeight: 600,
  padding: '5px 12px',
  borderRadius: 7,
  border: '1px solid #D5DDD8',
  background: '#fff',
  color: '#1E2A22',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};
const accent: CSSProperties = { ...btn, color: '#6B5BD2', borderColor: '#CFC8F2', background: '#F7F5FE' };

function DismissMenu({
  onPick,
  disabled,
  label = 'Dismiss',
}: {
  onPick: (l: DismissLevel) => void;
  disabled: boolean;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span style={{ position: 'relative', display: 'inline-block' }}>
      <button type="button" style={btn} disabled={disabled} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {label}
      </button>
      {open && (
        <span
          role="menu"
          style={{
            position: 'absolute',
            right: 0,
            top: '100%',
            marginTop: 4,
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
                onPick(l.id);
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
  );
}

function TicketKey({ id, onOpen }: { id: string; onOpen: (id: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(id)}
      style={{
        font: 'ui-monospace, monospace',
        fontSize: 12,
        background: '#fff',
        border: '1px solid #E3E8E5',
        borderRadius: 5,
        padding: '1px 6px',
        cursor: 'pointer',
        marginRight: 8,
      }}
    >
      {id}
    </button>
  );
}

function Table({ head, children }: { head: ReactNode; children: ReactNode }) {
  return (
    <div style={{ border: '1px solid #E3E8E5', borderRadius: 12, background: '#fff', overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>{head}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function AddToPage({ ticketId, projectId }: { ticketId: string; projectId: string }) {
  const tree = useDocsTree(projectId);
  const link = useLinkTicketToPage(projectId);
  const [open, setOpen] = useState(false);
  const [pageId, setPageId] = useState('');
  if (!open) {
    return (
      <button type="button" style={btn} onClick={() => setOpen(true)}>
        Add to a page
      </button>
    );
  }
  return (
    <span style={{ display: 'inline-flex', gap: 6 }}>
      <select
        aria-label={`Page to link ${ticketId} to`}
        value={pageId}
        onChange={(e) => setPageId(e.target.value)}
        style={{
          font: 'inherit',
          fontSize: 12.5,
          borderRadius: 7,
          border: '1px solid #D5DDD8',
          padding: '4px 6px',
          maxWidth: 160,
        }}
      >
        <option value="">Pick a page…</option>
        {(tree.data ?? [])
          .filter((n) => n.version > 0)
          .map((n) => (
            <option key={n.id} value={n.id}>
              {n.title}
            </option>
          ))}
      </select>
      <button
        type="button"
        style={accent}
        disabled={!pageId || link.isPending}
        onClick={() => link.mutate({ ticketId, pageId }, { onSuccess: () => setOpen(false) })}
      >
        Link
      </button>
    </span>
  );
}

const BROKEN_WHY: Record<string, string> = {
  missing: 'No page with this title',
  in_bin: 'The page is in the Recycle Bin',
  section_missing: 'The section no longer exists',
};

function Lists({
  data,
  tab,
  projectId,
  onOpenPage,
  onOpenTicket,
  onWritePage,
  dismiss,
}: {
  data: DocsHealth;
  tab: HealthTab;
  projectId: string;
  onOpenPage: (id: string) => void;
  onOpenTicket: (id: string) => void;
  onWritePage?: (ticketId: string) => void;
  dismiss: (kind: Kind, item: unknown, level: DismissLevel) => void;
}) {
  const busy = false;
  if (tab === 'outOfDate') {
    if (!data.outOfDate.length) return <Empty text="No page looks out of date." />;
    return (
      <Table
        head={
          <>
            <th style={th}>PAGE</th>
            <th style={th}>WHY IT MAY BE OUT OF DATE</th>
            <th style={th}>LAST EDITED</th>
            <th style={th} />
          </>
        }
      >
        {data.outOfDate.map((r) => (
          <tr key={r.pageId} data-testid="health-out-of-date">
            <td style={{ ...td, width: '22%' }}>
              <b>{r.title}</b>
              {r.parent && <div style={{ fontSize: 12, color: '#7A877F' }}>{r.parent}</div>}
            </td>
            <td style={td}>
              {r.reasons.map((x) => (
                <div key={x.key} style={{ marginBottom: 4 }}>
                  {x.text}
                  <div style={{ fontSize: 11.5, color: '#8A978F' }}>Compared: {x.compared}</div>
                </div>
              ))}
            </td>
            <td style={{ ...td, color: '#5B6B60', whiteSpace: 'nowrap' }}>
              {r.editedAt ? relativeTime(r.editedAt) : ''}
            </td>
            <td style={{ ...td, whiteSpace: 'nowrap', textAlign: 'right' }}>
              <span style={{ display: 'inline-flex', gap: 6 }}>
                <button type="button" style={accent} onClick={() => onOpenPage(r.pageId)}>
                  Review
                </button>
                <DismissMenu disabled={busy} onPick={(l) => dismiss('out_of_date', r, l)} />
              </span>
            </td>
          </tr>
        ))}
      </Table>
    );
  }
  if (tab === 'missing') {
    if (!data.missing.length) return <Empty text="Every Done ticket from the last 30 days has a page." />;
    return (
      <div>
        <div style={{ fontSize: 11, letterSpacing: 0.5, fontWeight: 700, color: '#7A877F', margin: '0 0 8px' }}>
          MISSING DOCS · {missingHeading(data.missing.length)}
        </div>
        <Table head={<th style={th} colSpan={3} />}>
          {data.missing.map((r) => (
            <tr key={r.ticketId} data-testid="health-missing">
              <td style={{ ...td, width: '34%' }}>
                <TicketKey id={r.ticketId} onOpen={onOpenTicket} />
                <b>{r.title}</b>
              </td>
              <td style={{ ...td, color: '#5B6B60' }}>{r.note}</td>
              <td style={{ ...td, textAlign: 'right' }}>
                <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  {onWritePage && (
                    <button type="button" style={accent} onClick={() => onWritePage(r.ticketId)}>
                      ✦ Write a page
                    </button>
                  )}
                  <AddToPage ticketId={r.ticketId} projectId={projectId} />
                  <button type="button" style={btn} onClick={() => dismiss('missing', r, 'never')}>
                    Not needed
                  </button>
                </span>
              </td>
            </tr>
          ))}
        </Table>
      </div>
    );
  }
  if (tab === 'broken') {
    if (!data.broken.length) return <Empty text="Every link and section resolves." />;
    return (
      <Table
        head={
          <>
            <th style={th}>PAGE</th>
            <th style={th}>LINK</th>
            <th style={th} />
          </>
        }
      >
        {data.broken.map((r) => (
          <tr key={`${r.pageId}|${r.ref}`} data-testid="health-broken">
            <td style={{ ...td, width: '28%' }}>
              <b>{r.title}</b>
            </td>
            <td style={td}>
              <code>{r.ref}</code> <span style={{ color: '#5B6B60' }}>· {BROKEN_WHY[r.status] ?? r.status}</span>
            </td>
            <td style={{ ...td, textAlign: 'right' }}>
              <span style={{ display: 'inline-flex', gap: 6 }}>
                <button type="button" style={accent} onClick={() => onOpenPage(r.pageId)}>
                  Review
                </button>
                <DismissMenu disabled={busy} onPick={(l) => dismiss('broken', r, l)} />
              </span>
            </td>
          </tr>
        ))}
      </Table>
    );
  }
  if (!data.overlaps.length) return <Empty text="No pages overlap." />;
  return (
    <Table
      head={
        <>
          <th style={th}>PAGES</th>
          <th style={th}>WHY</th>
          <th style={th} />
        </>
      }
    >
      {data.overlaps.map((r) => (
        <tr key={healthItemId('overlaps', r)} data-testid="health-overlap">
          <td style={{ ...td, width: '34%' }}>
            {r.pages.map((p) => (
              <div key={p.pageId}>
                <button
                  type="button"
                  onClick={() => onOpenPage(p.pageId)}
                  style={{
                    font: 'inherit',
                    fontWeight: 700,
                    border: 'none',
                    background: 'none',
                    padding: 0,
                    cursor: 'pointer',
                    color: '#1E2A22',
                  }}
                >
                  {p.title}
                </button>
              </div>
            ))}
          </td>
          <td style={{ ...td, color: '#5B6B60' }}>{r.why}</td>
          <td style={{ ...td, textAlign: 'right' }}>
            <DismissMenu disabled={busy} onPick={(l) => dismiss('overlaps', r, l)} />
          </td>
        </tr>
      ))}
    </Table>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div
      style={{
        border: '1px dashed #D5DDD8',
        borderRadius: 12,
        padding: '28px 16px',
        textAlign: 'center',
        color: '#5B6B60',
        fontSize: 13.5,
      }}
    >
      {text}
    </div>
  );
}

const noteBox: CSSProperties = {
  flex: 1,
  minWidth: 220,
  border: '1px solid #E3E8E5',
  borderRadius: 12,
  background: '#fff',
  padding: '14px 16px',
};

/**
 * Docs health (docs-ai-care A3): pages that may no longer match the board, missing docs, broken links and overlaps for
 * the whole space. Nothing here changes a page.
 */
export function DocsHealthView({
  projectId,
  onOpenPage,
  onOpenTicket,
  onClose,
  onWritePage,
}: {
  projectId: string;
  onOpenPage: (id: string) => void;
  onOpenTicket: (id: string) => void;
  onClose: () => void;
  /** "Write a page" on a Done ticket that no page mentions (opens the new-page dialog from that ticket). */
  onWritePage?: (ticketId: string) => void;
}) {
  const q = useDocsHealth(projectId);
  const run = useRunHealth(projectId);
  const dismiss = useDismissHealth(projectId);
  const [tab, setTab] = useState<HealthTab | null>(null);
  const data = q.data;
  const active = tab ?? (data ? defaultHealthTab(data.counts) : 'outOfDate');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const err = [q.error, run.error, dismiss.error]
    .map((e) => (e ? (docsAiError(e)?.detail ?? 'Something went wrong.') : null))
    .find(Boolean);
  return (
    <div
      data-testid="docs-health"
      className="docs-root"
      style={{ padding: '28px 36px', overflow: 'auto', height: '100%', boxSizing: 'border-box' }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <h1 style={{ margin: 0, fontSize: 28, fontWeight: 800, color: '#1E2A22' }}>Docs health</h1>
          <p style={{ margin: '6px 0 0', fontSize: 14, color: '#5B6B60' }}>
            Pages that may no longer match the board. Nothing here changes a page.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 12.5, color: '#5B6B60' }}>
            {data ? checkedLabel(data.checkedAt).replace('Checked', 'Last checked') : ''}
            {data?.digest.on ? ` · Digest every ${data.digest.schedule}` : ' · Digest off'}
          </span>
          <button
            type="button"
            style={btn}
            disabled={run.isPending}
            onClick={() => run.mutate()}
            data-testid="health-run"
          >
            <Icon name="refresh" size={13} /> {run.isPending ? 'Checking…' : 'Run now'}
          </button>
        </div>
      </div>
      {err && (
        <div role="alert" style={{ marginTop: 12, fontSize: 13, color: '#C4432A' }}>
          {err}
        </div>
      )}
      {!data && !err && <p style={{ color: '#5B6B60', marginTop: 20 }}>Loading…</p>}
      {data && (
        <>
          <div
            role="tablist"
            style={{ display: 'flex', gap: 22, margin: '22px 0 16px', borderBottom: '1px solid #E3E8E5' }}
          >
            {healthTabs(data.counts).map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={active === t.id}
                onClick={() => setTab(t.id)}
                style={{
                  font: 'inherit',
                  fontSize: 14,
                  fontWeight: active === t.id ? 700 : 500,
                  color: active === t.id ? '#1E2A22' : '#5B6B60',
                  background: 'none',
                  border: 'none',
                  borderBottom: `2px solid ${active === t.id ? '#2E6F40' : 'transparent'}`,
                  padding: '8px 0',
                  cursor: 'pointer',
                  marginBottom: -1,
                }}
              >
                {t.label} {t.count}
              </button>
            ))}
          </div>
          <Lists
            data={data}
            tab={active}
            projectId={projectId}
            onOpenPage={onOpenPage}
            onOpenTicket={onOpenTicket}
            onWritePage={onWritePage}
            dismiss={(kind, item, level) => dismiss.mutate({ kind, id: healthItemId(kind, item), level })}
          />
        </>
      )}
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 28 }}>
        <div style={noteBox}>
          <b>How it decides</b>
          <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 13, color: '#3D4B42', lineHeight: 1.55 }}>
            <li>
              It compares a page with the tickets it links to (status, title, recent comments) and with the pages it
              links to. It does not guess from the page alone.
            </li>
            <li>Every reason names what it compared, so you can check it in a few seconds.</li>
            <li>
              It runs daily and when you ask. A page is only flagged again when something it depends on changes after
              you chose “Still correct”.
            </li>
          </ul>
        </div>
        <div style={noteBox}>
          <b>What it never does</b>
          <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 13, color: '#3D4B42', lineHeight: 1.55 }}>
            <li>It never edits a page. Suggested edits are drafts you accept one by one.</li>
            <li>It never flags a page for being old. A page nobody needs to change is not out of date.</li>
            <li>
              It never marks a page as wrong in front of readers. The banner shows to people who can edit the page.
            </li>
          </ul>
        </div>
        <div style={noteBox}>
          <b>Digest and noise</b>
          <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 13, color: '#3D4B42', lineHeight: 1.55 }}>
            <li>The Monday digest uses the same Board health digest as tickets, one line per page.</li>
            <li>Dismiss has three levels: this time, 30 days, or never. Ignored items are remembered per page.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
