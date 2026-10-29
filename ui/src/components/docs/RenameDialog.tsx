import { useEffect, useMemo, useRef, useState } from 'react';
import { docsErrorDetail, useDocsPage } from '../../api/docs';
import { useRenamePreview, useRenameWithLinks } from '../../api/docsActions';
import { extractError } from '../../api/extractError';
import type { DocsPage } from '../../types/docs';
import { useToast } from '../Toast';
import { Icon } from './Icon';
import { FooterNote, ModalShell, Spacer, plural } from './docsShared';

interface RenameDialogProps {
  projectId: string;
  page: { id: string; title: string };
  newTitle: string;
  onClose: () => void;
  onRenamed: (page: DocsPage) => void;
}

const mono: React.CSSProperties = { fontFamily: "'JetBrains Mono', monospace" };

/**
 * Confirm a rename and choose whether to rewrite links.
 * @param props.page - Page being renamed.
 * @param props.newTitle - Proposed new title.
 * @param props.onClose - Called to dismiss the dialog.
 * @param props.onRenamed - Called with the renamed page.
 */
export function RenameDialog({ projectId, page, newTitle, onClose, onRenamed }: RenameDialogProps) {
  const toast = useToast();
  const full = useDocsPage(page.id);
  const rename = useRenameWithLinks(projectId);
  const [title, setTitle] = useState(newTitle);
  const [debounced, setDebounced] = useState(newTitle);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const trimmed = title.trim();
  const unchanged = trimmed === page.title;

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(title), 200);
    return () => window.clearTimeout(t);
  }, [title]);

  const preview = useRenamePreview(page.id, debounced, !!debounced.trim() && debounced.trim() !== page.title);
  const affected = useMemo(
    () => (preview.data && debounced.trim() === trimmed ? preview.data.affectedPages : []),
    [preview.data, debounced, trimmed],
  );
  const links = affected.reduce((n, a) => n + a.count, 0) || preview.data?.total || 0;
  const crumbs = (full.data?.path ?? []).map((p) => p.title);
  if (!crumbs.length || crumbs[crumbs.length - 1] !== page.title) crumbs.push(page.title);
  const hasLinks = affected.length > 0 && links > 0;

  async function run(rewriteLinks: boolean) {
    if (!trimmed || unchanged) return;
    setError(null);
    const oldTitle = page.title;
    try {
      const res = await rename.mutateAsync({ pageId: page.id, title: trimmed, rewriteLinks });
      const updated = rewriteLinks ? (res.rewritten ?? links) : 0;
      toast.showToast({
        variant: 'success',
        title: `Renamed to “${res.title}”`,
        message:
          rewriteLinks && updated
            ? `${plural(updated, 'link')} on ${plural(affected.length, 'page')} updated.`
            : undefined,
        duration: 8000,
        action: {
          label: 'Undo',
          onClick: () => {
            rename
              .mutateAsync({ pageId: page.id, title: oldTitle, rewriteLinks })
              .then(() => toast.success(`Renamed back to “${oldTitle}”`))
              .catch((err) =>
                toast.error("Couldn't undo the rename", docsErrorDetail(err)?.message ?? extractError(err)),
              );
          },
        },
      });
      onRenamed(res);
      onClose();
    } catch (err) {
      setError(docsErrorDetail(err)?.message ?? extractError(err));
    }
  }

  return (
    <ModalShell
      width={560}
      ariaLabel="Rename page"
      title={<>Rename '{page.title}'</>}
      subtitle={crumbs.join(' › ')}
      onClose={onClose}
      bodyStyle={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 14 }}
      footer={
        <>
          {hasLinks ? (
            <FooterNote>
              Creates a version on each of the {affected.length} {affected.length === 1 ? 'page' : 'pages'}
            </FooterNote>
          ) : (
            <FooterNote>Links to this page keep working.</FooterNote>
          )}
          <Spacer />
          <button type="button" className="st-btn" onClick={onClose}>
            Cancel
          </button>
          {hasLinks && (
            <button
              type="button"
              className="st-btn"
              disabled={!trimmed || unchanged || rename.isPending}
              onClick={() => void run(false)}
            >
              Rename only
            </button>
          )}
          <button
            type="button"
            className="st-btn st-btn-primary"
            data-testid="confirm-rename"
            disabled={!trimmed || unchanged || rename.isPending}
            onClick={() => void run(hasLinks)}
          >
            <Icon name="i10" size={14} />
            {rename.isPending ? 'Renaming…' : hasLinks ? 'Rename and update links' : 'Rename'}
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(hasLinks);
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
      >
        <label className="st-field-label" htmlFor="rename-title">
          New title
        </label>
        <input
          id="rename-title"
          ref={inputRef}
          className="st-input"
          style={{ borderColor: '#2E6F40', boxShadow: '0 0 0 3px rgba(46,111,64,0.18)' }}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </form>
      {hasLinks && (
        <>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '10px 12px',
              borderRadius: 8,
              background: '#FCEFD9',
              border: '1px solid #EBD3A6',
              fontSize: 13,
              color: '#1E2A22',
              lineHeight: 1.45,
            }}
          >
            <span style={{ color: '#B4791E', display: 'flex' }}>
              <Icon name="i11" size={16} strokeWidth={2} />
            </span>
            <span>
              <b>
                {plural(links, 'link')} on {plural(affected.length, 'page')}
              </b>{' '}
              will be updated so they keep pointing here.
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div
              style={{
                paddingBottom: 6,
                fontSize: 11,
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                color: '#5B6B60',
              }}
            >
              Affected pages
            </div>
            <div style={{ border: '1px solid #E3E8E5', borderRadius: 8, overflow: 'hidden' }}>
              {affected.map((a, i) => (
                <div
                  key={a.pageId}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 10,
                    padding: '9px 12px',
                    borderBottom: i < affected.length - 1 ? '1px solid #EEF3EF' : undefined,
                  }}
                >
                  <span
                    style={{
                      width: 16,
                      height: 16,
                      borderRadius: 4,
                      background: '#2E6F40',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                      marginTop: 3,
                      color: '#fff',
                    }}
                  >
                    <Icon name="i10" size={11} strokeWidth={3} />
                  </span>
                  <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        fontSize: 13,
                        fontWeight: 600,
                        color: '#1E2A22',
                      }}
                    >
                      {a.title}
                      {a.space && <span style={{ fontSize: 11.5, fontWeight: 500, color: '#9AA8A0' }}>{a.space}</span>}
                      <span style={{ marginLeft: 'auto', fontSize: 11.5, fontWeight: 600, color: '#5B6B60' }}>
                        {plural(a.count, 'link')}
                      </span>
                    </div>
                    <div
                      style={{ ...mono, fontSize: 11.5, lineHeight: 1.55, color: '#5B6B60', overflowWrap: 'anywhere' }}
                    >
                      [[
                      <span
                        style={{
                          background: 'rgba(196,67,42,0.14)',
                          color: '#A5321E',
                          borderRadius: 2,
                          textDecoration: 'line-through',
                        }}
                      >
                        {page.title}
                      </span>
                      ]] <span style={{ color: '#2E6F40' }}>→</span> [[
                      <span style={{ background: 'rgba(46,111,64,0.16)', color: '#1F5A31', borderRadius: 2 }}>
                        {trimmed}
                      </span>
                      ]]
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div style={{ fontSize: 12, color: '#5B6B60', lineHeight: 1.5, paddingTop: 8 }}>
              Links with your own display text keep that text. Tickets mentioning the page are not rewritten: they link
              by page id and show the new title.
            </div>
          </div>
        </>
      )}
      {error && (
        <div role="alert" style={{ fontSize: 12.5, color: '#A5321E' }}>
          {error}
        </div>
      )}
    </ModalShell>
  );
}

/**
 * Inline note shown after a heading edit is committed: old anchors keep working through an alias.
 * @param props.oldSlug - Anchor before the edit.
 * @param props.newSlug - Anchor after the edit.
 * @param props.count - Number of links to the section that keep working.
 * @param props.from - Where the links come from, shown in the note.
 */
export function HeadingRenameNote({
  oldSlug,
  newSlug,
  count,
  from,
}: {
  oldSlug: string;
  newSlug: string;
  count: number;
  from?: string;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '11px 13px',
        borderRadius: 8,
        background: '#E8F1FB',
        border: '1px solid #B9D3EE',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700, color: '#1E2A22' }}>
        <span style={{ color: '#2F6FB0', display: 'flex' }}>
          <Icon name="i28" size={16} />
        </span>
        {plural(count, 'link')} to this section will keep working (redirect)
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#3A4A3E', flexWrap: 'wrap' }}>
        <span style={{ ...mono, color: '#A5321E' }}>#{oldSlug}</span>
        <Icon name="i29" size={13} strokeWidth={2} />
        <span style={{ ...mono, color: '#1F5A31' }}>#{newSlug}</span>
        <span style={{ color: '#5B6B60' }}>{from ? `from ${from}; ` : ''}the old anchor is kept as an alias</span>
      </div>
    </div>
  );
}
