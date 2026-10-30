import { useEffect, useRef, useState } from 'react';
import { assistApi, assistError } from '../../../api/assist';
import { useDocsAiState } from '../../../api/docsAi';
import { freshnessUnavailable, useCheckFreshness } from '../../../api/docsAiPage';
import { extractError } from '../../../api/extractError';
import type { DocsPage } from '../../../types/docs';
import {
  LANGUAGES,
  aiGate,
  estimateLabel,
  freshnessHint,
  pageMenu,
  readsChips,
  type MenuRow,
} from '../../../utils/pageAiRules';
import { useAssist } from '../../assist/AssistContext';
import { useToast } from '../../Toast';
import { Icon } from '../Icon';
import { CreateTicketsDialog } from './CreateTicketsDialog';
import type { PageAiView } from './usePageAiView';
import { requestAiOnEdit } from './editIntent';
import './pageAi.css';

/**
 * The AI button in the page header, beside Comments and Share (docs-ai B). Shown only when Docs AI is on for the
 * project (`aiGate`); lists what AI can do with this page and starts nothing until a row is picked. Viewers do not see
 * the writing rows. A hidden page shows a lock and a reason; with no AI member there is one row that opens AI members.
 * @param props.projectId - The project of the page.
 * @param props.page - The page the menu is for.
 * @param props.canEdit - Whether the person can edit the page.
 * @param props.view - Where Summarise and Translate view show their answer.
 * @param props.onEdit - Opens the editor (for Edit with AI… and Suggest links).
 * @param props.onOpenTicket - Opens a ticket the tickets dialog created.
 */
export function PageAiMenu({
  projectId,
  page,
  canEdit,
  view,
  onEdit,
  onOpenTicket,
}: {
  projectId: string;
  page: DocsPage;
  canEdit: boolean;
  /** Opens Settings › Docs (for the "no AI member" row). */
  onOpenSettings?: () => void;
  view: PageAiView;
  onEdit?: () => void;
  onOpenTicket?: (ticketId: string) => void;
}) {
  const state = useDocsAiState(projectId);
  const assist = useAssist();
  const toast = useToast();
  const fresh = useCheckFreshness(page.id);
  const [open, setOpen] = useState(false);
  const [languages, setLanguages] = useState(false);
  const [tickets, setTickets] = useState(false);
  const [other, setOther] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const gate = aiGate(state.data, { hidden: !!page.aiHidden });
  const menu = pageMenu(gate, canEdit);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  useEffect(() => {
    if (!open) setLanguages(false);
  }, [open]);

  if (menu.kind === 'none') return null;
  const published = page.version > 0;
  const markdown = published ? page.markdown : (page.draft?.markdown ?? page.markdown);
  const noFresh = fresh.isError && freshnessUnavailable(fresh.error);

  const run = (id: string) => {
    if (id === 'translate') return setLanguages(true);
    setOpen(false);
    if (id === 'ask') assist?.ask({ scope: 'doc', docId: page.id });
    else if (id === 'summarise') view.summarise();
    else if (id === 'check')
      fresh.mutate(undefined, {
        onSuccess: () => toast.success('Checked', 'Compared with the tickets and pages this page links to.'),
        onError: (e) => {
          if (!freshnessUnavailable(e)) toast.error('Check if up to date', extractError(e));
        },
      });
    else if (id === 'tickets') setTickets(true);
    else if (id === 'links')
      void assistApi
        .startDraft(projectId, { kind: 'doc_links', docId: page.id, data: { markdown: page.markdown } })
        .then(() => {
          requestAiOnEdit(page.id);
          onEdit?.();
        })
        .catch((e: unknown) => toast.error('Suggest links', assistError(e)?.detail ?? extractError(e)));
    else if (id === 'edit') {
      requestAiOnEdit(page.id);
      onEdit?.();
    }
  };
  const disabled = (r: MenuRow): string | null => {
    if (!published && ['summarise', 'translate', 'check'].includes(r.id)) return 'Publish the page first';
    if (r.id === 'check' && noFresh) return 'Not available yet';
    return null;
  };

  return (
    <div ref={box} data-popover style={{ position: 'relative' }}>
      <button
        type="button"
        className="st-btn pai-btn"
        aria-expanded={open}
        aria-haspopup="menu"
        data-testid="page-ai-menu"
        onClick={() => setOpen((v) => !v)}
      >
        {menu.kind === 'hidden' ? <Icon name="lock" size={14} strokeWidth={1.9} /> : <span aria-hidden>✦</span>}
        AI
        <Icon name="chevronDown" size={11} strokeWidth={2.3} />
      </button>
      {open && (
        <div className="dk-menu pai-menu" role="menu" aria-label="AI" data-testid="page-ai-popover">
          {menu.kind === 'hidden' && (
            <div style={{ display: 'flex', gap: 10, padding: '10px 10px 12px', alignItems: 'flex-start' }}>
              <Icon name="lock" size={16} strokeWidth={1.9} style={{ color: '#6b5bd2', marginTop: 2 }} />
              <div>
                <div className="pai-row-title">Hidden from AI</div>
                <div className="pai-row-hint">{menu.text}</div>
              </div>
            </div>
          )}
          {menu.kind === 'no_member' && (
            <button
              type="button"
              role="menuitem"
              className="pai-row"
              onClick={() => {
                setOpen(false);
                assist?.onOpenAiMembers();
              }}
            >
              <Icon name="i32" size={16} strokeWidth={1.9} className="pai-row-ico" />
              <span>
                <div className="pai-row-title">Open AI members</div>
                <div className="pai-row-hint">{menu.text}</div>
              </span>
            </button>
          )}
          {menu.kind === 'rows' &&
            !languages &&
            menu.rows.map((r) => {
              const off = disabled(r);
              return (
                <div key={r.id}>
                  {r.divider && <div className="pai-rule" />}
                  <button
                    type="button"
                    role="menuitem"
                    className="pai-row"
                    disabled={!!off || (r.id === 'check' && fresh.isPending)}
                    data-testid={`ai-row-${r.id}`}
                    onClick={() => run(r.id)}
                  >
                    <Icon name={r.icon} size={16} strokeWidth={1.9} className="pai-row-ico" />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <div className="pai-row-title">{r.title}</div>
                      <div className="pai-row-hint">{off ?? (r.id === 'check' ? freshnessHint(markdown) : r.hint)}</div>
                    </span>
                    {r.shortcut && (
                      <span style={{ display: 'flex', gap: 3 }}>
                        {r.shortcut.split(' ').map((k) => (
                          <span key={k} className="dk-kbd">
                            {k}
                          </span>
                        ))}
                      </span>
                    )}
                  </button>
                </div>
              );
            })}
          {menu.kind === 'rows' && languages && (
            <div data-testid="translate-languages">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px' }}>
                <button type="button" className="pai-link" onClick={() => setLanguages(false)}>
                  ‹ Back
                </button>
                <span className="pai-row-title">Translate into…</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2 }}>
                {LANGUAGES.map((l) => (
                  <button
                    key={l}
                    type="button"
                    role="menuitem"
                    className="pai-row"
                    style={{ padding: '7px 10px' }}
                    onClick={() => {
                      setOpen(false);
                      view.translateTo(l);
                    }}
                  >
                    <span className="pai-row-title" style={{ fontWeight: 500 }}>
                      {l}
                    </span>
                  </button>
                ))}
              </div>
              <form
                style={{ display: 'flex', gap: 6, padding: '6px 10px' }}
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!other.trim()) return;
                  setOpen(false);
                  view.translateTo(other.trim());
                  setOther('');
                }}
              >
                <input
                  className="ai-input"
                  placeholder="Another language"
                  value={other}
                  onChange={(e) => setOther(e.target.value)}
                  aria-label="Another language"
                  style={{ flex: 1, padding: '6px 8px', border: '1px solid #e3e8e5', borderRadius: 8 }}
                />
                <button type="submit" className="st-btn st-btn-sm" disabled={!other.trim()}>
                  Translate
                </button>
              </form>
            </div>
          )}
          {menu.kind === 'rows' && (
            <>
              <div className="pai-rule" />
              <div className="pai-reads" data-testid="ai-reads">
                <span>Reads</span>
                {readsChips(markdown).map((c) => (
                  <span key={c} className="pai-chip">
                    {c}
                  </span>
                ))}
                <span style={{ flexBasis: '100%' }}>{estimateLabel(markdown)}</span>
              </div>
            </>
          )}
        </div>
      )}
      {tickets && (
        <CreateTicketsDialog
          projectId={projectId}
          page={page}
          onClose={() => setTickets(false)}
          onOpenTicket={onOpenTicket}
        />
      )}
    </div>
  );
}
