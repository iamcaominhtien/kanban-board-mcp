import { useEffect, useRef, useState } from 'react';
import type { DocsPage } from '../../types/docs';
import { Icon } from './Icon';

interface SharePopoverProps {
  page: DocsPage;
  onClose: () => void;
}

/** Return the shareable URL of a page. */
export function pageUrl(pageId: string): string {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('docs', pageId);
  return url.toString();
}

/** A page id from a link (`?docs=<uuid>`), as opposed to a slug path. */
export function isPageId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * The share link of a page by its slug path (`?docs=architecture/api&proj=…`, AC-4), or its page-id link when the
 * page has no path of its own. A slug path is per project, so the link names the project.
 */
export function pageShareUrl(page: Pick<DocsPage, 'id' | 'projectId' | 'slugPath'>): string {
  if (!page.slugPath) return pageUrl(page.id);
  const url = new URL(window.location.href);
  url.hash = '';
  // the path first: it is what the field shows when the link is longer than the field
  url.search = `?docs=${encodeURI(page.slugPath)}&proj=${encodeURIComponent(page.projectId)}`;
  return url.toString();
}

function referenceFor(page: DocsPage): string {
  const titles = (page.path ?? []).map((p) => p.title);
  if (!titles.length || titles[titles.length - 1] !== page.title) titles.push(page.title);
  return `[[${titles.join('/')}]]`;
}

function safeDecode(text: string): string {
  try {
    return decodeURI(text);
  } catch {
    return text;
  }
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Popover to copy a page link.
 * @param props.page - Page whose link is copied.
 * @param props.onClose - Called to dismiss the popover.
 */
export function SharePopover({ page, onClose }: SharePopoverProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState<'link' | 'ref' | 'id' | null>(null);
  const timer = useRef<number>();
  const url = pageShareUrl(page);
  const idUrl = pageUrl(page.id);
  const shown = safeDecode(url.replace(/^https?:\/\//, ''));
  const ref = referenceFor(page);
  const crumbs = (page.path ?? []).map((p) => p.title);
  if (!crumbs.length || crumbs[crumbs.length - 1] !== page.title) crumbs.push(page.title);

  async function copy(kind: 'link' | 'ref' | 'id') {
    if (await writeClipboard(kind === 'link' ? url : kind === 'id' ? idUrl : ref)) {
      setCopied(kind);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(null), 2000);
    }
  }

  useEffect(() => {
    void copy('link');
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
      window.clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={rootRef}
      className="dk-menu docs-root"
      role="dialog"
      aria-label="Share page"
      style={{
        position: 'absolute',
        right: 0,
        top: 'calc(100% + 6px)',
        width: 430,
        zIndex: 60,
        padding: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: '#1E2A22', flex: 1 }}>Share page</span>
        <span style={{ fontSize: 12, color: '#9AA8A0' }}>{crumbs.join(' › ')}</span>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <div
          className="st-input"
          data-testid="share-url"
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 12,
            color: '#3A4A3E',
            background: '#F6FAF7',
            display: 'flex',
            alignItems: 'center',
            overflow: 'hidden',
            whiteSpace: 'nowrap',
          }}
        >
          {shown}
        </div>
        <button
          type="button"
          className="st-btn"
          onClick={() => void copy('link')}
          style={
            copied === 'link'
              ? { flexShrink: 0, color: '#2E6F40', borderColor: '#B7D9C0', background: '#F1F8F3' }
              : { flexShrink: 0 }
          }
        >
          <Icon name={copied === 'link' ? 'i10' : 'i24'} size={14} strokeWidth={copied === 'link' ? 2.4 : 1.9} />
          {copied === 'link' ? 'Copied' : 'Copy link'}
        </button>
      </div>
      {url !== idUrl && (
        // the link by page id, as before: it keeps working whatever the page is renamed to or moved under
        <button
          type="button"
          data-testid="share-id-link"
          onClick={() => void copy('id')}
          style={{
            alignSelf: 'flex-start',
            marginTop: -6,
            padding: 0,
            border: 'none',
            background: 'none',
            cursor: 'pointer',
            fontSize: 12,
            color: '#5B6B60',
            textDecoration: 'underline',
          }}
        >
          {copied === 'id' ? 'Copied the link by page id' : 'Copy the link by page id'}
        </button>
      )}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 10,
          padding: '10px 12px',
          borderRadius: 8,
          background: '#F6FAF7',
          border: '1px solid #E3E8E5',
        }}
      >
        <span style={{ display: 'flex', color: '#2E6F40', marginTop: 1 }}>
          <Icon name="i36" size={16} />
        </span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#1E2A22' }}>Anyone with project access can view</div>
          <div style={{ fontSize: 12, lineHeight: 1.45, color: '#5B6B60' }}>
            Drafts and unpublished changes stay private to their authors.
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            color: '#5B6B60',
          }}
        >
          Reference in another page
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <div
            className="st-input"
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 12.5,
              color: '#2E6F40',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            {ref}
          </div>
          <button
            type="button"
            className="st-btn"
            aria-label="Copy reference"
            onClick={() => void copy('ref')}
            style={{
              flexShrink: 0,
              padding: '8px 10px',
              ...(copied === 'ref' ? { color: '#2E6F40', background: '#F1F8F3' } : {}),
            }}
          >
            <Icon name={copied === 'ref' ? 'i10' : 'i24'} size={14} />
          </button>
        </div>
        <div style={{ fontSize: 12, lineHeight: 1.45, color: '#5B6B60' }}>
          Paste into a page to link here. Add <span className="st-code">#Section</span> to link a heading.
        </div>
      </div>
    </div>
  );
}
