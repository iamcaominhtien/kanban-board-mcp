import { useState } from 'react';
import { docsErrorDetail, useDeletePage } from '../../api/docs';
import { useDeletePreview } from '../../api/docsActions';
import { extractError } from '../../api/extractError';
import { useProjects } from '../../api/projects';
import { Icon } from './Icon';
import { ModalShell, Spacer, plural } from './docsShared';

interface DeleteDialogProps {
  projectId: string;
  page: { id: string; title: string };
  onClose: () => void;
  onDeleted: (count: number, gone: string[]) => void;
}

// the rows of the Tree board's lists (frame 37): 34 high, 2 8 2 6, 6 px gaps, the tag 11.5 #5B6B60
const rowBase: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  minHeight: 34,
  boxSizing: 'border-box',
  padding: '2px 8px 2px 6px',
  fontSize: 13,
  fontWeight: 500,
  color: '#3A4A3E',
};
const roleTag: React.CSSProperties = { marginLeft: 'auto', fontSize: 11.5, fontWeight: 400, color: '#5B6B60' };
const listBox: React.CSSProperties = {
  border: '1px solid #E3EAE5',
  borderRadius: 9,
  background: '#FFFFFF',
  overflow: 'hidden',
};

/**
 * Confirm moving a page and its sub-pages to the Recycle Bin.
 * @param props.projectId - Project the page belongs to.
 * @param props.page - Page to delete (its sub-pages go with it).
 * @param props.onClose - Called to dismiss the dialog.
 * @param props.onDeleted - Called with the number of pages moved to the Recycle Bin and their ids (the page and its
 *   sub-pages).
 */
export function DeleteDialog({ projectId, page, onClose, onDeleted }: DeleteDialogProps) {
  const preview = useDeletePreview(page.id);
  const del = useDeletePage(projectId);
  const [error, setError] = useState<string | null>(null);

  const pages = preview.data?.pages ?? [{ id: page.id, title: page.title, role: 'this' as const }];
  const count = pages.length;
  const children = count - 1;
  const linking = preview.data?.linkingPages ?? 0;
  const linkingRows = preview.data?.linking ?? [];
  const linkingTickets = preview.data?.linkingTickets ?? 0;
  const morePages = Math.max(0, linking - linkingRows.length);
  const projectName = useProjects().data?.find((p) => p.id === projectId)?.name ?? 'Docs';

  async function confirm() {
    setError(null);
    try {
      const res = await del.mutateAsync(page.id);
      onDeleted(res.deletedPages ?? count, res.gone);
    } catch (err) {
      setError(docsErrorDetail(err)?.message ?? extractError(err));
    }
  }

  return (
    <ModalShell
      boardFrame
      width={540}
      ariaLabel="Delete page"
      icon="i12"
      title={<>Delete “{page.title}”?</>}
      subtitle={
        children > 0
          ? `Moves the page and its ${plural(children, 'child page')} to the Recycle Bin`
          : 'Moves the page to the Recycle Bin'
      }
      onClose={onClose}
      bodyStyle={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 12 }}
      footer={
        <>
          <Spacer />
          <button type="button" className="st-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="st-btn st-btn-danger-outline"
            data-testid="confirm-delete"
            disabled={del.isPending || preview.isLoading}
            onClick={() => void confirm()}
          >
            {del.isPending ? 'Deleting…' : count > 1 ? `Delete ${count} pages` : 'Delete page'}
          </button>
        </>
      }
    >
      <div style={listBox}>
        {pages.map((p) => {
          const isThis = p.role === 'this';
          return (
            <div
              key={p.id}
              style={{
                ...rowBase,
                fontWeight: isThis ? 700 : 500,
                color: isThis ? '#1E2A22' : '#3A4A3E',
                paddingLeft: isThis ? 6 : 24,
              }}
            >
              <span style={{ display: 'flex', width: 20, justifyContent: 'center', color: '#5B6B60' }}>
                <Icon name="i00" size={15} strokeWidth={1.8} />
              </span>
              {p.title}
              <span style={roleTag}>{isThis ? 'this page' : 'child page'}</span>
            </div>
          );
        })}
      </div>
      {count > 1 && <div style={{ fontSize: 12.5, fontWeight: 700, color: '#5B6B60' }}>{count} pages in total</div>}
      {linking > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
            padding: '8px 11px',
            borderRadius: 8,
            background: '#FDF3E3',
            border: '1px solid #EBD3A4',
            fontSize: 12.5,
            color: '#8A5A00',
            lineHeight: 1.5,
          }}
        >
          <span style={{ display: 'flex', marginTop: 2 }}>
            <Icon name="i14" size={14} strokeWidth={2} />
          </span>
          <span>
            <b style={{ fontWeight: 700 }}>
              {linking} {linking === 1 ? 'page links' : 'pages link'} here.
            </b>{' '}
            Their links will show as “In Recycle Bin” until the page is restored.
          </span>
        </div>
      )}
      {(linkingRows.length > 0 || linkingTickets > 0) && (
        <div style={listBox} data-testid="delete-linking">
          {linkingRows.map((r) => (
            <div key={r.pageId} style={rowBase}>
              <span style={{ display: 'flex', width: 20, justifyContent: 'center', color: '#5B6B60' }}>
                <Icon name="i00" size={15} strokeWidth={1.8} />
              </span>
              <b style={{ fontWeight: 600, color: '#1E2A22' }}>{r.title}</b>
              <span style={{ fontSize: 12, color: '#5B6B60' }}>{r.parent ?? projectName}</span>
              <span style={roleTag}>{plural(r.count, 'link')}</span>
            </div>
          ))}
          {(morePages > 0 || linkingTickets > 0) && (
            <div
              style={{ padding: '7px 12px', fontSize: 12, fontWeight: 600, color: '#5B6B60', background: '#F6FAF7' }}
            >
              {morePages > 0 && `+ ${plural(morePages, 'more page')}`}
              {morePages > 0 && linkingTickets > 0 && ' · '}
              {linkingTickets > 0 &&
                `${morePages > 0 ? 'also referenced' : 'Referenced'} by ${plural(linkingTickets, 'ticket')}`}
            </div>
          )}
        </div>
      )}
      {(linking > 0 || linkingTickets > 0) && (
        <div style={{ fontSize: 12, lineHeight: 1.5, color: '#5B6B60' }}>
          Nothing is rewritten. Restoring the page from the Recycle Bin makes every link work again.
        </div>
      )}
      <div style={{ fontSize: 12.5, lineHeight: 1.55, color: '#3A4A3E' }}>
        Kept in the Recycle Bin for 30 days, then deleted forever; restoring brings back the whole tree.
      </div>
      {error && (
        <div role="alert" style={{ fontSize: 12.5, color: '#A5321E' }}>
          {error}
        </div>
      )}
    </ModalShell>
  );
}
