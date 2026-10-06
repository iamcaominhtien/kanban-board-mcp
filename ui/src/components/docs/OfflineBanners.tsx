import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import './docs.css';

const bar = { display: 'flex', alignItems: 'center', gap: 12, padding: '11px 16px', boxSizing: 'border-box', flexShrink: 0 } as const;

/** "You are offline" banner of the editor (DocsEditor board F). */
export function OfflineBanner({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="status" data-testid="offline-banner" style={{ ...bar, background: '#F1F3F1', borderBottom: '1px solid #DCE6DF' }}>
      <span style={{ color: '#5B6B60', display: 'flex' }}><Icon name="i37" size={16} /></span>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
        <div style={{ fontSize: 13.5, fontWeight: 700, color: '#1E2A22' }}>You are offline</div>
        <div style={{ fontSize: 12.5, color: '#3A4A3E', lineHeight: 1.45 }}>
          Your edits are kept in this browser and sync when the connection returns. Publishing needs a connection.
        </div>
      </div>
      <button type="button" className="st-btn st-btn-sm" onClick={onRetry}>Retry now</button>
    </div>
  );
}

/** "Back online" banner (auto-dismisses; `onDismiss` also from the close button). */
export function BackOnlineBanner({ onDismiss }: { onDismiss: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 6000);
    return () => clearTimeout(t);
  }, [onDismiss]);
  return (
    <div role="status" data-testid="online-banner" style={{ ...bar, background: '#DCEEE1', borderBottom: '1px solid #BFDDC6' }}>
      <span style={{ color: '#2E6F40', display: 'flex' }}><Icon name="i17" size={16} /></span>
      <div style={{ flex: 1, fontSize: 13.5, fontWeight: 700, color: '#1F5A31' }}>Back online. Your changes were saved.</div>
      <button type="button" className="st-btn st-btn-sm" onClick={onDismiss}>Dismiss</button>
    </div>
  );
}

/** Tracks navigator.onLine; `flaky` lets callers report a failed request. */
export function useOnline() {
  const [online, setOnline] = useState(() => navigator.onLine);
  const [justBack, setJustBack] = useState(false);
  useEffect(() => {
    const on = () => {
      setOnline(true);
      setJustBack(true);
    };
    const off = () => {
      setOnline(false);
      setJustBack(false);
    };
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return { online, setOnline, justBack, clearJustBack: () => setJustBack(false) };
}
