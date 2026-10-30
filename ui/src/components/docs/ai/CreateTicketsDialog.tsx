import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { useProjects } from '../../../api/projects';
import { docsAiError } from '../../../api/docsAi';
import { useCreateTickets, useDraftTickets, useUndoTickets, type TicketDraftsResult } from '../../../api/docsAiCare';
import type { DocsPage } from '../../../types/docs';
import {
  canCreate,
  columnLabel,
  createBody,
  createdToast,
  createLabel,
  dueLabel,
  initials,
  toEditable,
  type EditableDraft,
} from '../../../utils/careRules';
import { costLabel } from '../../../utils/docsAiRules';
import { useToast } from '../../Toast';
import { DOCS_SCRIM, useEscape } from '../docsShared';
import { Icon } from '../Icon';
import '../docs.css';

const chip: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: '#2E6F40',
  background: '#E9F3EC',
  borderRadius: 999,
  padding: '3px 10px',
};
const btn: CSSProperties = {
  font: 'inherit',
  fontSize: 13,
  fontWeight: 600,
  padding: '8px 16px',
  borderRadius: 8,
  border: '1px solid #D5DDD8',
  background: '#fff',
  color: '#1E2A22',
  cursor: 'pointer',
};

/**
 * Create tickets from a page (docs-ai-care C): drafts to review with editable fields, nothing is created before the
 * button. People named in the text are suggested as assignee, never set. After creating, an Undo toast.
 */
export function CreateTicketsDialog({
  projectId,
  page,
  selection,
  onClose,
  onOpenTicket,
}: {
  projectId: string;
  page: DocsPage;
  selection?: string;
  onClose: () => void;
  onOpenTicket?: (ticketId: string) => void;
}) {
  useEscape(onClose);
  const toast = useToast();
  const projects = useProjects();
  const draftJob = useDraftTickets(page.id, selection);
  const create = useCreateTickets(page.id);
  const undo = useUndoTickets();
  const [drafts, setDrafts] = useState<EditableDraft[]>([]);
  const info: TicketDraftsResult | null = draftJob.data ?? null;
  const [replaceText, setReplaceText] = useState(true);
  const [link, setLink] = useState(true);
  useEffect(() => {
    if (draftJob.data) setDrafts(toEditable(draftJob.data.drafts));
  }, [draftJob.data]);
  const err = [draftJob.error, create.error]
    .map((e) => (e ? (docsAiError(e)?.detail ?? 'Could not do that.') : null))
    .find(Boolean);
  const set = (n: number, patch: Partial<EditableDraft>) =>
    setDrafts((ds) => ds.map((d) => (d.n === n ? { ...d, ...patch } : d)));
  const picked = drafts.filter((d) => d.include);
  const loading = draftJob.isPending || draftJob.isFetching;
  const projectName = (id: string) => projects.data?.find((p) => p.id === id)?.name ?? '';

  const submit = () =>
    create.mutate(createBody(drafts, replaceText, link), {
      onSuccess: (out) => {
        const column = picked[0]?.column ?? 'backlog';
        toast.success(
          createdToast(out.tickets.length, column),
          out.notReplaced.length ? `Not found in your draft: ${out.notReplaced.join(', ')}` : undefined,
          10000,
          {
            label: 'Undo',
            onClick: () =>
              undo.mutate(out.undoToken, {
                onSuccess: (r) =>
                  toast.info(
                    `${r.deleted} ticket${r.deleted === 1 ? '' : 's'} removed`,
                    r.draftRestored ? undefined : 'Your draft was changed since, so it was left as it is.',
                  ),
                onError: (e) => toast.error("Couldn't undo", docsAiError(e)?.detail),
              }),
          },
        );
        if (out.tickets.length === 1 && onOpenTicket) onOpenTicket(out.tickets[0]!.id);
        onClose();
      },
    });

  return (
    <div
      className="docs-root"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1100,
        background: DOCS_SCRIM,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Create tickets"
        data-testid="create-tickets-dialog"
        style={{
          width: 560,
          maxWidth: '100%',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: 14,
          background: '#fff',
          boxShadow: '0 24px 64px rgba(30,42,34,0.28)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '20px 24px 14px',
            borderBottom: '1px solid #EEF3EF',
            display: 'flex',
            alignItems: 'flex-start',
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 18, fontWeight: 800, color: '#1E2A22' }}>
              {drafts.length ? createLabel(drafts.length) : 'Create tickets'}
            </div>
            <div style={{ fontSize: 13, color: '#5B6B60' }}>From {page.title}</div>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#5B6B60' }}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
        <div style={{ padding: '16px 24px', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {loading && (
            <div role="status" style={{ fontSize: 13.5, color: '#5B6B60' }}>
              Looking for unchecked items…
            </div>
          )}
          {info && !drafts.length && !loading && (
            <div role="status" style={{ fontSize: 14, color: '#1E2A22' }}>
              {info.message ?? 'No unchecked items without a ticket.'}
            </div>
          )}
          {drafts.map((d) => (
            <div
              key={d.n}
              data-testid="ticket-draft"
              style={{ border: '1px solid #E3E8E5', borderRadius: 12, padding: 12, opacity: d.include ? 1 : 0.55 }}
            >
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  aria-label={`Create ticket ${d.n}`}
                  checked={d.include}
                  onChange={(e) => set(d.n, { include: e.target.checked })}
                />
                <input
                  aria-label={`Title of ticket ${d.n}`}
                  value={d.title}
                  onChange={(e) => set(d.n, { title: e.target.value })}
                  style={{
                    flex: 1,
                    font: 'inherit',
                    fontSize: 14,
                    padding: '8px 10px',
                    borderRadius: 8,
                    border: '1px solid #D5DDD8',
                  }}
                />
              </div>
              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  marginTop: 8,
                  paddingLeft: 24,
                }}
              >
                <select
                  aria-label={`Type of ticket ${d.n}`}
                  value={d.type}
                  onChange={(e) => set(d.n, { type: e.target.value })}
                  style={{ ...chip, border: 'none' }}
                >
                  {['task', 'bug', 'feature', 'chore'].map((t) => (
                    <option key={t} value={t}>
                      {t[0]!.toUpperCase() + t.slice(1)}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={`Project of ticket ${d.n}`}
                  value={d.projectId}
                  onChange={(e) => set(d.n, { projectId: e.target.value })}
                  style={{ ...chip, border: 'none' }}
                >
                  {(projects.data ?? [{ id: projectId, name: projectName(projectId) || 'This project' }]).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={`Column of ticket ${d.n}`}
                  value={d.column}
                  onChange={(e) => set(d.n, { column: e.target.value })}
                  style={{ ...chip, border: 'none' }}
                >
                  {['backlog', 'todo', 'in-progress'].map((c) => (
                    <option key={c} value={c}>
                      {columnLabel(c)}
                    </option>
                  ))}
                </select>
                {d.suggestedAssignee ? (
                  <button
                    type="button"
                    aria-pressed={d.assigneeId === d.suggestedAssignee.memberId}
                    title="Suggested from the text. Click to assign; the default is Unassigned."
                    onClick={() => set(d.n, { assigneeId: d.assigneeId ? null : d.suggestedAssignee!.memberId })}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      font: 'inherit',
                      fontSize: 12.5,
                      border: 'none',
                      background: 'none',
                      cursor: 'pointer',
                      padding: 0,
                    }}
                  >
                    <span style={{ ...chip, background: '#E9F3EC', padding: '2px 7px', fontSize: 10.5 }}>
                      {initials(d.suggestedAssignee.name)}
                    </span>
                    {d.suggestedAssignee.name}
                    <span style={{ ...chip, color: '#6B5BD2', background: '#EEEBFB' }}>
                      {d.assigneeId ? 'assigned' : 'suggested'}
                    </span>
                  </button>
                ) : (
                  <span style={{ fontSize: 12.5, color: '#7A877F' }}>Unassigned</span>
                )}
                {dueLabel(d.dueDate) && <span style={chip}>{dueLabel(d.dueDate)}</span>}
              </div>
            </div>
          ))}
          {drafts.length > 0 && (
            <>
              <label style={{ display: 'flex', gap: 10, fontSize: 13.5, alignItems: 'center' }}>
                <input type="checkbox" checked={replaceText} onChange={(e) => setReplaceText(e.target.checked)} />
                Replace the text on the page with the ticket chips
              </label>
              <label style={{ display: 'flex', gap: 10, fontSize: 13.5, alignItems: 'center' }}>
                <input type="checkbox" checked={link} onChange={(e) => setLink(e.target.checked)} />
                {picked.length === 2 ? 'Link both tickets to this page' : 'Link the tickets to this page'}
              </label>
              {replaceText && (
                <div style={{ fontSize: 12, color: '#7A877F' }}>
                  The chips go into your draft of the page. Nothing is published until you press Publish.
                </div>
              )}
            </>
          )}
          {info?.skipped.map((s) => (
            <div key={`${s.reason}-${s.text}`} style={{ fontSize: 12.5, color: '#7A877F' }}>
              {s.note}
            </div>
          ))}
          {err && (
            <div role="alert" style={{ fontSize: 13, color: '#C4432A' }}>
              {err}
            </div>
          )}
        </div>
        <div
          style={{
            padding: '12px 24px',
            borderTop: '1px solid #EEF3EF',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <span style={{ fontSize: 12.5, color: '#7A877F', flex: 1 }}>
            {info && drafts.length ? costLabel(info.cost, info.metered) : ''}
          </span>
          <button type="button" style={btn} onClick={onClose}>
            Cancel
          </button>
          {drafts.length > 0 && (
            <button
              type="button"
              disabled={!canCreate(drafts) || create.isPending}
              onClick={submit}
              data-testid="create-tickets-submit"
              style={{
                ...btn,
                background: '#2E6F40',
                borderColor: '#2E6F40',
                color: '#fff',
                opacity: canCreate(drafts) ? 1 : 0.5,
              }}
            >
              {create.isPending ? 'Creating…' : createLabel(picked.length)}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
