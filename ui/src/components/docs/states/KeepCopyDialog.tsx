/**
 * "Keep a copy of this page" (RichDocsStates frames 18 and 20): while the draft only lives in this browser, download
 * it as an .html file or copy its text.
 */

import { useState } from 'react';
import { StIcon } from './stIcons';
import { StateDialog } from './StateDialog';
import './states.css';

/** Characters a file name cannot hold on the common systems. */
const BAD_NAME = /[\\/:*?"<>|\s]+/g;

/**
 * A whole HTML file for a page: its title and the editor's HTML, with relative picture links made absolute so the
 * copy opens from the disk.
 * @param title - The page title.
 * @param bodyHtml - The page as HTML (the editor's `getHTML()`).
 * @param origin - The server the pictures come from.
 */
export function pageHtmlFile(title: string, bodyHtml: string, origin: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body = bodyHtml.replace(/(\s(?:src|href)=")\/(?!\/)/g, `$1${origin}/`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>body{font:16px/1.65 Georgia,serif;max-width:720px;margin:40px auto;padding:0 18px;color:#1e2a22}img{max-width:100%}table{border-collapse:collapse}td,th{border:1px solid #d3dcd6;padding:6px 8px}pre{background:#f4f7f5;padding:12px;overflow:auto}</style>
</head>
<body>
<h1>${esc(title)}</h1>
${body}
</body>
</html>
`;
}

/**
 * Save a text as a file through the browser.
 * @param name - The file name.
 * @param text - Its content.
 * @param type - Its media type.
 */
function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

interface Props {
  pageTitle: string;
  /** The page as HTML, read when Download is pressed. */
  getHtml: () => string;
  /** The page as plain text, read when Copy is pressed. */
  getText: () => string;
  onClose: () => void;
  /** A phone: a sheet with two full-width buttons. */
  sheet?: boolean;
  /** Called after the copy was made, with what was done. */
  onDone?: (what: 'download' | 'copy') => void;
}

/**
 * The "Keep a copy" dialog.
 * @param props.pageTitle - The page title (sub-line and file name).
 * @param props.getHtml - The page as HTML.
 * @param props.getText - The page as plain text.
 * @param props.onClose - Called by Not now, Esc and the close button.
 * @param props.sheet - Draw as the phone sheet.
 * @param props.onDone - Called after a download or a copy.
 */
export function KeepCopyDialog({ pageTitle, getHtml, getText, onClose, sheet, onDone }: Props) {
  const [pick, setPick] = useState<'download' | 'copy'>('download');
  const [copyFailed, setCopyFailed] = useState(false);
  const title = pageTitle || 'Untitled';
  const doDownload = () => {
    download(
      `${title.replace(BAD_NAME, ' ').trim() || 'page'}.html`,
      pageHtmlFile(title, getHtml(), window.location.origin),
      'text/html',
    );
    onDone?.('download');
    onClose();
  };
  const doCopy = async () => {
    try {
      await navigator.clipboard.writeText(`${title}\n\n${getText()}`);
      onDone?.('copy');
      onClose();
    } catch {
      setCopyFailed(true);
    }
  };
  const run = (what: 'download' | 'copy') => (what === 'download' ? doDownload() : void doCopy());

  if (sheet) {
    return (
      <StateDialog width={390} title="Keep a copy" sub={title} onClose={onClose} sheet testId="keep-copy-dialog">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <p className="dst-p-sm">Your latest text is only in this browser until it is saved.</p>
          <button type="button" className="st-btn st-btn-primary" onClick={doDownload} data-testid="keep-download">
            <StIcon name="download" size={16} sw={2} />
            Download a copy (.html)
          </button>
          <button type="button" className="st-btn" onClick={() => void doCopy()} data-testid="keep-copy-text">
            <StIcon name="copy" size={16} sw={2} />
            Copy the text
          </button>
          {copyFailed && <CopyFailed />}
        </div>
      </StateDialog>
    );
  }
  return (
    <StateDialog
      width={520}
      title="Keep a copy of this page"
      sub={title}
      onClose={onClose}
      testId="keep-copy-dialog"
      footer={
        <>
          <button type="button" className="st-btn" onClick={onClose}>
            Not now
          </button>
          <span style={{ flex: 1 }} />
          <button type="button" className="st-btn st-btn-primary" onClick={() => run(pick)} data-testid="keep-go">
            <StIcon name={pick === 'download' ? 'download' : 'copy'} size={14} sw={2} />
            {pick === 'download' ? 'Download a copy' : 'Copy the text'}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <p className="dst-p-sm">
          Your latest text is only in this browser until it is saved. A copy on your computer is the safest way to keep
          it.
        </p>
        <button
          type="button"
          className="dst-choice"
          aria-pressed={pick === 'download'}
          onClick={() => setPick('download')}
          onDoubleClick={doDownload}
          data-testid="keep-download"
        >
          <StIcon name="download" size={18} sw={1.8} />
          <span style={{ flex: 1 }}>
            <span className="dst-choice-title" style={{ display: 'block' }}>
              Download a copy (.html)
            </span>
            <span className="dst-choice-sub" style={{ display: 'block' }}>
              Opens in any browser; keeps formatting and pictures.
            </span>
          </span>
        </button>
        <button
          type="button"
          className="dst-choice"
          aria-pressed={pick === 'copy'}
          onClick={() => setPick('copy')}
          onDoubleClick={() => void doCopy()}
          data-testid="keep-copy-text"
        >
          <StIcon name="copy" size={18} sw={1.8} />
          <span style={{ flex: 1 }}>
            <span className="dst-choice-title" style={{ display: 'block' }}>
              Copy the text
            </span>
            <span className="dst-choice-sub" style={{ display: 'block' }}>
              Plain text to the clipboard, without formatting.
            </span>
          </span>
        </button>
        {copyFailed && <CopyFailed />}
        <div className="st-hint" style={{ fontSize: 12, lineHeight: 1.5 }}>
          Clearing this browser’s site data or using a private window can remove the kept copy.
        </div>
      </div>
    </StateDialog>
  );
}

function CopyFailed() {
  return (
    <div role="alert" className="st-hint" style={{ color: '#C4432A' }}>
      This browser did not allow copying. Download a copy instead.
    </div>
  );
}
