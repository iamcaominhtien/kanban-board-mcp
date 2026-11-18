/**
 * The bars a page shows while it moves to the rich format (design board "States", frames 8-12): converting (blue),
 * conversion failed (amber), and once converted a notice the reader can dismiss.
 */

import { useState } from 'react';
import { useDocsVersions } from '../../api/docs';
import type { DocsPage } from '../../types/docs';
import { Icon } from './Icon';
import { CONVERTED_NOTE, type ConvertLock } from './richPage';

/**
 * The bar above a page whose conversion blocks editing.
 * @param props.lock - `converting` (waiting or working) or `failed`.
 */
export function ConvertBar({ lock }: { lock: ConvertLock }) {
  return lock === 'converting' ? (
    <div className="dk-convert-bar dk-convert-bar-info" role="status" data-testid="convert-bar">
      <span className="mc-spin" aria-hidden="true" />
      Converting this page to the new format…
    </div>
  ) : (
    <div className="dk-convert-bar dk-convert-bar-warn" role="alert" data-testid="convert-bar">
      <Icon name="i14" size={15} strokeWidth={1.9} />
      This page could not be converted. Its original text is kept, read-only.
    </div>
  );
}

const seenKey = (pageId: string) => `docsConvertedSeen:${pageId}`;

function dismissed(pageId: string): boolean {
  try {
    return localStorage.getItem(seenKey(pageId)) === '1';
  } catch {
    return false;
  }
}

/**
 * "This page was converted to the new format", shown above the title the first times a converted page is read (its
 * conversion is done and its latest version is the one the conversion wrote), until "Got it" (kept per page in
 * localStorage).
 * @param props.page - The page.
 * @param props.onViewOriginal - Opens the page's History, where the Markdown original is the version before.
 */
export function ConvertedNotice({ page, onViewOriginal }: { page: DocsPage; onViewOriginal: () => void }) {
  const [hidden, setHidden] = useState(() => dismissed(page.id));
  const candidate = page.convertState === 'done' && !hidden;
  const versions = useDocsVersions(candidate ? page.id : null);
  if (!candidate || !versions.data?.length) return null;
  const latest = versions.data.reduce((a, b) => (b.version > a.version ? b : a));
  if (latest.note !== CONVERTED_NOTE) return null;
  const dismiss = () => {
    try {
      localStorage.setItem(seenKey(page.id), '1');
    } catch {
      /* storage blocked: hidden until the page is opened again */
    }
    setHidden(true);
  };
  return (
    <div className="dk-convert-note" role="status" data-testid="converted-notice">
      <span className="dk-convert-note-text">
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#2F6FB0"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v6M12 7.5v.01" />
        </svg>
        <span>
          <b>Converted to the new format.</b> The original is kept in History.
        </span>
      </span>
      <span className="dk-convert-note-actions">
        <button type="button" className="st-btn" onClick={onViewOriginal}>
          View original
        </button>
        <button type="button" className="st-btn" onClick={dismiss}>
          Got it
        </button>
      </span>
    </div>
  );
}
