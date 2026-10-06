import { useEffect, useRef, useState, type ReactNode } from 'react';
import { docsErrorDetail } from '../../api/docs';
import { useSimilarPages } from '../../api/docsPage';
import { Icon } from './Icon';

const sage = '#5B6B60';

/* ---------- skeletons (D1) ---------- */

function TreeRowSkel({ pad, w }: { pad: number; w: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 30, padding: `0 8px 0 ${pad}px` }}>
      <div className="skel" style={{ width: 14, height: 14, flexShrink: 0, borderRadius: 3 }} />
      <div className="skel" style={{ width: `${w}%`, height: 10, flexShrink: 0 }} />
    </div>
  );
}

const ROWS: [number, number][] = [[10, 58], [10, 70], [26, 38], [26, 44], [10, 64], [26, 30], [26, 52], [10, 60], [10, 66]];

export function TreeSkeleton({ width = 248 }: { width?: number }) {
  return (
    <aside aria-busy="true" aria-label="Loading pages" style={{ width, flexShrink: 0, background: '#F6FAF7', borderRight: '1px solid #E3E8E5', display: 'flex', flexDirection: 'column', boxSizing: 'border-box' }}>
      <div style={{ padding: '18px 14px 12px', display: 'flex', flexDirection: 'column', gap: 7 }}>
        <div className="skel" style={{ width: 70, height: 9, flexShrink: 0 }} />
        <div className="skel" style={{ width: 140, height: 13, flexShrink: 0 }} />
      </div>
      <div style={{ margin: '0 10px 10px', height: 32, borderRadius: 8, border: '1px solid #E3E8E5', background: '#FFFFFF' }} />
      <div style={{ padding: '2px 8px', display: 'flex', flexDirection: 'column', gap: 1 }}>
        {ROWS.map(([pad, w], i) => (
          <TreeRowSkel key={i} pad={pad} w={w} />
        ))}
      </div>
    </aside>
  );
}

export function PageSkeleton({ title, note, crumbs }: { title?: string; note?: ReactNode; crumbs?: string[] }) {
  return (
    <div aria-busy="true" aria-label="Loading page" style={{ flex: 1, minWidth: 0, padding: '28px 44px', boxSizing: 'border-box', overflow: 'hidden' }}>
      <div style={{ maxWidth: 640, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {note}
        {crumbs ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <Icon name="folder" size={13} strokeWidth={1.8} style={{ color: '#9AA8A0' }} />
            {crumbs.map((c, i) => (
              <span key={i} style={{ display: 'contents' }}>
                {i > 0 && <Icon name="chevronRight" size={10} strokeWidth={2.4} style={{ color: '#C7D2CB' }} />}
                <span style={{ fontSize: 12.5, fontWeight: i === crumbs.length - 1 ? 700 : 500, color: i === crumbs.length - 1 ? '#1E2A22' : sage, whiteSpace: 'nowrap' }}>{c}</span>
              </span>
            ))}
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div className="skel" style={{ width: 14, height: 14, flexShrink: 0 }} />
            <div className="skel" style={{ width: 110, height: 10, flexShrink: 0 }} />
            <div className="skel" style={{ width: 90, height: 10, flexShrink: 0 }} />
          </div>
        )}
        {title ? (
          <h1 style={{ margin: 0, fontSize: 32, fontWeight: 800, lineHeight: 1.15, color: '#1E2A22', letterSpacing: '-0.01em' }}>{title}</h1>
        ) : (
          <div className="skel" style={{ width: 260, height: 30, flexShrink: 0, borderRadius: 6 }} />
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div className="skel" style={{ width: 110, height: 22, flexShrink: 0, borderRadius: 999 }} />
          <div className="skel" style={{ width: 22, height: 22, flexShrink: 0, borderRadius: '50%' }} />
          <div className="skel" style={{ width: 150, height: 10, flexShrink: 0 }} />
        </div>
        <div style={{ height: 1, background: '#E3E8E5', margin: '8px 0 6px' }} />
        <div className="skel" style={{ width: '100%', height: 11, flexShrink: 0 }} />
        <div className="skel" style={{ width: '94%', height: 11, flexShrink: 0 }} />
        <div className="skel" style={{ width: '62%', height: 11, flexShrink: 0 }} />
        <div className="skel" style={{ width: 180, height: 17, flexShrink: 0, marginTop: 12 }} />
        <div className="skel" style={{ width: '100%', height: 112, flexShrink: 0, borderRadius: 8 }} />
        <div className="skel" style={{ width: 160, height: 17, flexShrink: 0, marginTop: 12 }} />
        <div className="skel" style={{ width: '100%', height: 11, flexShrink: 0 }} />
        <div className="skel" style={{ width: '88%', height: 11, flexShrink: 0 }} />
      </div>
    </div>
  );
}

/** D2: shown after 8 s of loading (the skeleton stays). */
export function SlowLoadNote({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="status" data-testid="docs-slow-note" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', borderRadius: 10, background: '#E8F1FB', border: '1px solid #B9D3EE', fontSize: 13, color: '#1E2A22', lineHeight: 1.45 }}>
      <span className="mc-spin" />
      <span style={{ flex: 1 }}><b>Still loading…</b> This is taking longer than usual. Your connection may be slow.</span>
      <button type="button" className="st-btn st-btn-sm" onClick={onRetry}>
        <Icon name="i41" size={13} strokeWidth={2} />
        Retry
      </button>
    </div>
  );
}

/** D3: slim progress bar across the top of the page area while a page loads. */
export function TopProgress() {
  return (
    <div role="progressbar" aria-label="Loading page" style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 3, background: '#DCEEE1', zIndex: 5 }}>
      <div style={{ width: '42%', height: '100%', background: '#2E6F40', borderRadius: '0 2px 2px 0', animation: 'dk-progress 8s ease-out forwards' }} />
    </div>
  );
}

/* ---------- full-state layout ---------- */

function StateShell({ icon, tone = 'neutral', title, children, testid }: { icon: ReactNode; tone?: 'neutral' | 'error'; title: string; children: ReactNode; testid?: string }) {
  return (
    <div data-testid={testid} style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, boxSizing: 'border-box', overflow: 'auto' }}>
      <div style={{ width: 380, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, textAlign: 'center' }}>
        <div style={{ width: 48, height: 48, borderRadius: '50%', background: tone === 'error' ? '#FBE7E4' : '#EEF3EF', color: tone === 'error' ? '#C4432A' : sage, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{icon}</div>
        <div style={{ fontSize: 18, fontWeight: 700, color: '#1E2A22', marginTop: 4 }}>{title}</div>
        {children}
      </div>
    </div>
  );
}

const body = { fontSize: 13, lineHeight: 1.6, color: sage } as const;
const btnRow = { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 8 } as const;

/** What a failed request looked like, for the E1 detail block. */
export function describeRequest(err: unknown, fallbackPath: string): { line: string; requestId: string | null } {
  const e = err as { response?: { status?: number; headers?: Record<string, string> }; config?: { method?: string; url?: string } } | null;
  const method = (e?.config?.method ?? 'get').toUpperCase();
  const url = (e?.config?.url ?? fallbackPath).replace(/^https?:\/\/[^/]+/, '').replace(/^\/api(?=\/)/, '');
  const status = e?.response?.status;
  const detail = docsErrorDetail(err) as (ReturnType<typeof docsErrorDetail> & { requestId?: string }) | null;
  const requestId = detail?.requestId ?? e?.response?.headers?.['x-request-id'] ?? null;
  return { line: `${method} ${url} · ${status ?? 'no response'}`, requestId };
}

/** E1: the page (or space) failed to load; auto-retries in 8 s. */
export function LoadError({ title = "Couldn't load this page", message = "The server didn't answer in time. Nothing was changed on the page.", error, path, failedAt, onRetry, onBack, backLabel = 'Back to Overview', autoRetry = true }: {
  title?: string;
  message?: string;
  error: unknown;
  path: string;
  failedAt: Date;
  onRetry: () => void;
  onBack?: () => void;
  backLabel?: string;
  autoRetry?: boolean;
}) {
  const [secs, setSecs] = useState(8);
  const retryRef = useRef(onRetry);
  retryRef.current = onRetry;
  useEffect(() => {
    if (!autoRetry) return;
    setSecs(8);
    const id = setInterval(() => {
      setSecs((s) => {
        if (s <= 1) {
          retryRef.current();
          return 8;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [failedAt, autoRetry]);
  const info = describeRequest(error, path);
  const time = failedAt.toLocaleTimeString('en-GB', { hour12: false });
  return (
    <StateShell testid="docs-error" tone="error" icon={<Icon name="i22" size={24} strokeWidth={1.8} />} title={title}>
      <div style={body}>{message}</div>
      <div style={{ width: '100%', boxSizing: 'border-box', marginTop: 4, padding: '8px 10px', borderRadius: 8, background: '#F6FAF7', border: '1px solid #E3E8E5', textAlign: 'left', fontFamily: 'var(--font-mono)', fontSize: 11.5, lineHeight: 1.55, color: sage }}>
        {info.line}
        <br />
        {info.requestId ? `request id ${info.requestId} · ${time}` : time}
      </div>
      {autoRetry && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: '#9AA8A0' }}>
          <span className="mc-spin" style={{ width: 11, height: 11, borderWidth: 1.5 }} />
          Retrying automatically in {secs}s
        </div>
      )}
      <div style={btnRow}>
        <button type="button" className="st-btn st-btn-primary" onClick={onRetry} data-testid="docs-retry">
          <Icon name="i41" size={14} strokeWidth={1.9} />
          Retry
        </button>
        {onBack && (
          <button type="button" className="st-btn" onClick={onBack}>
            <Icon name="i27" size={14} strokeWidth={1.9} />
            {backLabel}
          </button>
        )}
      </div>
    </StateShell>
  );
}

/** E2: page not found, with similar pages. */
export function NotFound({ projectId, path, onOpenPage, onHome, onSearch }: { projectId: string; path: string; onOpenPage: (id: string) => void; onHome: () => void; onSearch?: () => void }) {
  const slug = path.split('/').filter(Boolean).pop() ?? path;
  const { data: similar = [] } = useSimilarPages(projectId, slug);
  return (
    <StateShell testid="docs-not-found" icon={<Icon name="search" size={24} strokeWidth={1.8} />} title="Page not found">
      <div style={body}>
        There is no page at <span className="st-code">{path}</span>. It may have been renamed, moved or never existed.
      </div>
      {similar.length > 0 && (
        <div style={{ width: '100%', marginTop: 6, border: '1px solid #E3E8E5', borderRadius: 10, overflow: 'hidden', textAlign: 'left' }}>
          <div style={{ padding: '7px 12px', background: '#F6FAF7', borderBottom: '1px solid #EEF3EF', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: sage }}>Similar pages</div>
          {similar.map((s, i) => (
            <div key={s.pageId} role="button" tabIndex={0} onClick={() => onOpenPage(s.pageId)} onKeyDown={(e) => e.key === 'Enter' && onOpenPage(s.pageId)} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 12px', borderBottom: i < similar.length - 1 ? '1px solid #EEF3EF' : 'none', fontSize: 13, fontWeight: 600, color: '#1E2A22', cursor: 'pointer' }}>
              <span style={{ display: 'flex', color: '#2E6F40' }}><Icon name="page" size={15} strokeWidth={1.8} /></span>
              {s.title}
              {s.path.length > 1 && <span style={{ fontSize: 11.5, fontWeight: 500, color: '#9AA8A0' }}>{s.path.slice(0, -1).join(' › ')}</span>}
            </div>
          ))}
        </div>
      )}
      <div style={btnRow}>
        <button type="button" className="st-btn st-btn-primary" onClick={onHome}>
          <Icon name="i27" size={14} strokeWidth={1.9} />
          Go to Overview
        </button>
        {onSearch && (
          <button type="button" className="st-btn" onClick={onSearch}>
            <Icon name="search" size={14} strokeWidth={1.9} />
            Search pages
          </button>
        )}
      </div>
    </StateShell>
  );
}

/** E3: deleted page, restorable. */
export function DeletedPage({ title, deletedBy, deletedAt, daysLeft, onRestore, onHome, restoring }: { title?: string; deletedBy?: string; deletedAt?: string | null; daysLeft?: number; onRestore: () => void; onHome: () => void; restoring?: boolean }) {
  const days = deletedAt ? Math.max(0, Math.floor((Date.now() - new Date(deletedAt).getTime()) / 86400000)) : null;
  const ago = days == null ? '' : days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'} ago`;
  const left = daysLeft ?? (days == null ? null : Math.max(0, 30 - days));
  return (
    <StateShell testid="docs-deleted" icon={<Icon name="i12" size={24} strokeWidth={1.8} />} title="This page was deleted">
      <div style={body}>
        <b style={{ color: '#1E2A22' }}>{deletedBy ?? 'Someone'}</b> moved <b style={{ color: '#1E2A22' }}>{title ?? 'this page'}</b> to the Recycle Bin{ago ? ` ${ago}` : ''}.
        {left != null && ` It is kept for ${left} more day${left === 1 ? '' : 's'}.`}
      </div>
      <div style={{ fontSize: 12, lineHeight: 1.5, color: '#9AA8A0' }}>Links to it show “In Recycle Bin” until it is restored.</div>
      <div style={btnRow}>
        <button type="button" className="st-btn st-btn-primary" onClick={onRestore} disabled={restoring} data-testid="docs-restore">
          <Icon name="i19" size={14} strokeWidth={1.9} />
          Restore page
        </button>
        <button type="button" className="st-btn" onClick={onHome}>
          <Icon name="i27" size={14} strokeWidth={1.9} />
          Go to Overview
        </button>
      </div>
    </StateShell>
  );
}

/** E6: Docs switched off for the project. */
export function DocsDisabled({ onOpenSettings, onBack }: { onOpenSettings?: () => void; onBack?: () => void }) {
  return (
    <StateShell testid="docs-disabled" icon={<Icon name="i30" size={24} strokeWidth={1.8} />} title="Docs is turned off for this project">
      <div style={body}>Pages are kept but hidden. An admin can turn Docs back on in the project settings.</div>
      <div style={btnRow}>
        {onOpenSettings && (
          <button type="button" className="st-btn st-btn-primary" onClick={onOpenSettings}>
            <Icon name="i30" size={14} strokeWidth={1.9} />
            Open project settings
          </button>
        )}
        {onBack && (
          <button type="button" className="st-btn" onClick={onBack}>
            <Icon name="i57" size={14} strokeWidth={1.9} />
            Back to Board
          </button>
        )}
      </div>
    </StateShell>
  );
}

/** E5: the amber offline banner above a cached page. */
export function OfflineBanner({ pageTitle, savedAt, version, onTryAgain }: { pageTitle: string; savedAt: string; version?: number | null; onTryAgain?: () => void }) {
  const d = new Date(savedAt);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const when = d.toDateString() === new Date().toDateString() ? `today ${time}` : `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${time}`;
  return (
    <div role="status" data-testid="docs-offline-banner" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 24px', background: '#FEF6E7', borderBottom: '1px solid #F0DBA8', fontSize: 12.5, color: '#1E2A22', lineHeight: 1.45, flexShrink: 0 }}>
      <span style={{ color: '#B8860B', display: 'flex' }}><Icon name="i37" size={17} strokeWidth={1.9} /></span>
      <span style={{ flex: 1 }}>
        <b style={{ fontWeight: 700 }}>You're offline.</b> Showing the saved copy of {pageTitle} from {when}{version ? ` (v${version})` : ''}. Editing is off until you reconnect.
      </span>
      {onTryAgain && (
        <button type="button" className="st-btn st-btn-sm" onClick={onTryAgain}>
          <Icon name="i41" size={13} strokeWidth={2} />
          Try again
        </button>
      )}
    </div>
  );
}

/** Empty tree column body (36px circle). */
export function TreeEmpty() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '26px 14px', textAlign: 'center' }}>
      <div style={{ width: 36, height: 36, borderRadius: '50%', background: '#EAF0EC', color: '#9AA8A0', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Icon name="page" size={18} strokeWidth={1.7} />
      </div>
      <div style={{ fontSize: 13, fontWeight: 700, color: '#1E2A22' }}>No pages yet</div>
      <div style={{ fontSize: 12, lineHeight: 1.5, color: sage }}>Pages you create show up here as a tree you can reorder by dragging.</div>
    </div>
  );
}
