import { useState } from 'react';
import { docsErrorDetail, useDeletePage } from '../../api/docs';
import { useDeletePreview } from '../../api/docsActions';
import { extractError } from '../../api/extractError';
import { Icon } from './Icon';
import { ModalShell, Spacer, plural } from './docsShared';

interface DeleteDialogProps {
  projectId: string;
  page: { id: string; title: string };
  onClose: () => void;
  onDeleted: (count: number) => void;
}

const rowBase: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 9,
  padding: '8px 12px',
  borderBottom: '1px solid #EEF3EF',
  fontSize: 13,
  color: '#1E2A22',
};
const roleTag: React.CSSProperties = { marginLeft: 'auto', fontSize: 11.5, fontWeight: 500, color: '#9AA8A0' };

/**
 * Confirm moving a page and its sub-pages to the Recycle Bin.
 * @param props.projectId - Project the page belongs to.
 * @param props.page - Page to delete (its sub-pages go with it).
 * @param props.onClose - Called to dismiss the dialog.
 * @param props.onDeleted - Called with the number of pages moved to the Recycle Bin.
 */
export function DeleteDialog({ projectId, page, onClose, onDeleted }: DeleteDialogProps) {
  const preview = useDeletePreview(page.id);
  const del = useDeletePage(projectId);
  const [error, setError] = useState<string | null>(null);

  const pages = preview.data?.pages ?? [{ id: page.id, title: page.title, role: 'this' as const }];
  const count = pages.length;
  const children = count - 1;
  const linking = preview.data?.linkingPages ?? 0;

  async function confirm() {
    setError(null);
    try {
      const res = await del.mutateAsync(page.id);
      onDeleted(res.deletedPages ?? count);
    } catch (err) {
      setError(docsErrorDetail(err)?.message ?? extractError(err));
    }
  }

  return (
    <ModalShell
      width={540}
      ariaLabel="Delete page"
      icon="i12"
      iconTone="red"
      title={<>Delete “{page.title}”?</>}
      subtitle={
        children > 0
          ? `Moves the page and its ${plural(children, 'child page')} to the Recycle Bin`
          : 'Moves the page to the Recycle Bin'
      }
      onClose={onClose}
      bodyStyle={{ padding: '16px 22px', display: 'flex', flexDirection: 'column', gap: 12 }}
      footer={
        <>
          <Spacer />
          <button type="button" className="st-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="st-btn st-btn-danger"
            data-testid="confirm-delete"
            disabled={del.isPending || preview.isLoading}
            onClick={() => void confirm()}
          >
            <Icon name="i12" size={14} />
            {del.isPending ? 'Deleting…' : count > 1 ? `Delete ${count} pages` : 'Delete page'}
          </button>
        </>
      }
    >
      <div style={{ border: '1px solid #E3E8E5', borderRadius: 8, overflow: 'hidden' }}>
        {pages.map((p) => {
          const isThis = p.role === 'this';
          return (
            <div
              key={p.id}
              style={{
                ...rowBase,
                fontWeight: isThis ? 700 : 600,
                paddingLeft: isThis ? 12 : 30,
              }}
            >
              <span style={{ display: 'flex', color: isThis ? '#C4432A' : '#9AA8A0' }}>
                <Icon name="i00" size={15} strokeWidth={1.8} />
              </span>
              {p.title}
              <span style={roleTag}>{isThis ? 'this page' : 'child page'}</span>
            </div>
          );
        })}
        {count > 1 && (
          <div style={{ padding: '7px 12px', fontSize: 12, fontWeight: 600, color: '#5B6B60', background: '#F6FAF7' }}>
            {count} pages in total
          </div>
        )}
      </div>
      {linking > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '10px 12px',
            borderRadius: 8,
            background: '#FBE7E4',
            border: '1px solid #F0C4B8',
            fontSize: 13,
            color: '#1E2A22',
            lineHeight: 1.45,
          }}
        >
          <span style={{ color: '#C4432A', display: 'flex' }}>
            <Icon name="i14" size={16} strokeWidth={2} />
          </span>
          <span>
            <b style={{ fontWeight: 700 }}>
              {linking} {linking === 1 ? 'page links' : 'pages link'} here.
            </b>{' '}
            Their links show “In Recycle Bin” until restored.
          </span>
        </div>
      )}
      <div style={{ fontSize: 12, lineHeight: 1.5, color: '#5B6B60' }}>
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
