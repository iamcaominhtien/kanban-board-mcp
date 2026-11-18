/**
 * The link handle of a heading in the reading view (RichDocsLinks D 22): a 28 px button in the left margin, shown on
 * hover, with the tooltip "Copy link to this heading". It copies the page address at the
 * heading's block (`#block-b-…`, which opens the page there and marks it) and says so in a dark toast: "Link copied ·
 * Page › Heading".
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { blockLink } from '../editor/blocks/commands';
import './links.css';

const LINK_PATH = (
  <>
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
    <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
  </>
);

/** How long the "Link copied" toast stays, in ms. */
const TOAST_MS = 3200;

/**
 * The handle; place it as the first child of a heading.
 * @param props.blockId - The heading's block id.
 * @param props.text - The heading's words (named in the toast).
 */
export function HeadingLinkHandle({ blockId, text }: { blockId: string; text: string }) {
  const [copied, setCopied] = useState<string | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  // D 22: touch has no hover, so a tap on the heading shows its handle for a few seconds
  useEffect(() => {
    const heading = btn.current?.parentElement;
    if (!heading) return;
    let t = 0;
    const onUp = (e: PointerEvent) => {
      if (e.pointerType !== 'touch' || e.target === btn.current) return;
      heading.setAttribute('data-hl-on', '');
      window.clearTimeout(t);
      t = window.setTimeout(() => heading.removeAttribute('data-hl-on'), 4000);
    };
    heading.addEventListener('pointerup', onUp);
    return () => {
      heading.removeEventListener('pointerup', onUp);
      window.clearTimeout(t);
    };
  }, []);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(null), TOAST_MS);
    return () => window.clearTimeout(t);
  }, [copied]);
  const copy = () => {
    const link = blockLink(window.location.href, blockId);
    const page = document.querySelector('[data-testid="page-title"]')?.textContent?.trim();
    const where = page ? `${page} › ${text}` : text;
    void navigator.clipboard
      ?.writeText(link)
      .then(() => setCopied(where))
      .catch(() => setCopied(null));
    if (!navigator.clipboard) setCopied(where);
  };
  return (
    <>
      {/* out of the heading's name and text (aria-hidden, no text node: the tooltip is drawn by CSS), so the heading
          reads, finds and anchors as before; the block menu's "Copy link to block" is the keyboard way */}
      <button
        type="button"
        ref={btn}
        className="dk-hl-handle"
        data-testid="heading-link-handle"
        aria-hidden="true"
        tabIndex={-1}
        title=""
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          copy();
        }}
      >
        <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          {LINK_PATH}
        </svg>
      </button>
      {copied &&
        createPortal(
          <div className="dk-hl-toast" role="status" data-testid="heading-link-toast">
            <span className="dk-hl-toast-icon">
              <svg
                width={12}
                height={12}
                viewBox="0 0 24 24"
                fill="none"
                stroke="#fff"
                strokeWidth={2.6}
                aria-hidden="true"
              >
                {LINK_PATH}
              </svg>
            </span>
            <div style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, lineHeight: 1.35 }}>
              Link copied
              <div style={{ fontSize: 12, opacity: 0.78, marginTop: 1, fontWeight: 500 }}>{copied}</div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
