/**
 * The HTML embed while editing (design "Embeds", frames 1-2, 6, 9-11, 70, 73): Code and Preview are two tabs of one
 * block (Preview by default). On a wide screen the Code tab shows the code and a live preview side by side; on a
 * phone editing the code opens full screen with a bar of symbols. The preview updates when typing stops. The block's
 * footer sets the height (Auto follows the content while scripts run, Fixed in px) and whether its scripts run, and
 * counts the lines and the size against the size limit. After a save that cleaned the HTML it says what was removed
 * and crosses out the lines that held it. A page too big for inline code goes in as a site: "Upload folder…" or
 * "Upload .zip / .html…" sends the files and the embed shows them by their address (`src`, no Code tab); "Back to
 * inline code" lets go of the site and shows the embed's own code again.
 */

import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { clearRemoved, useRemoved } from '../../embeds/cleanedHtml';
import { highlight } from '../../docsHighlight';
import { HtmlChip, HtmlKind, SiteSourceView, SourceView, siteEntry } from '../../embeds/HtmlEmbedBlock';
import { EmbIcon } from '../../embeds/embIcons';
import { HtmlEmbedFrame } from '../../embeds/HtmlEmbedFrame';
import { HTML_EMBED_LIMIT, byteSize, kbOrMb, linesWith, listWords, siteUrl } from '../../embeds/htmlSandbox';
import { useEditorEnv } from '../context';
import { startDocUpload } from './docUpload';
import {
  cancelSiteUpload,
  dropSiteUpload,
  retrySiteUpload,
  siteUploadFor,
  siteUploadsVersion,
  startSiteUpload,
  subscribeSiteUploads,
} from './siteUpload';
import { Panel, Seg, Toggle, useBlockLayout } from './ui';
import '../../embeds/embeds.css';

/** How long typing must stop before the preview (and the page) take the code (ms). */
const SETTLE_MS = 400;

/** The symbols of the phone's bar above the keyboard. */
const SYMBOLS = ['<', '>', '/', '=', '"', '{', '}', ';'];

/** Props of {@link CodeArea}. */
interface CodeAreaProps {
  value: string;
  onChange: (v: string) => void;
  /** Line numbers (1-based) shown crossed out. */
  crossed: number[];
  label: string;
  autoFocus?: boolean;
  areaRef?: React.RefObject<HTMLTextAreaElement>;
}

/** A plain code editor: line numbers, crossed-out lines, Tab indents. */
export function CodeArea({ value, onChange, crossed, label, autoFocus, areaRef }: CodeAreaProps) {
  const own = useRef<HTMLTextAreaElement>(null);
  const ref = areaRef ?? own;
  const [scroll, setScroll] = useState({ top: 0, left: 0 });
  // the line the caret is on is tinted (Embeds 11)
  const [caretLine, setCaretLine] = useState<number | null>(null);
  const lines = value.split('\n');
  const trackCaret = (t: HTMLTextAreaElement) => setCaretLine(value.slice(0, t.selectionStart).split('\n').length);
  const marks = new Set(crossed);
  const onKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Tab' || e.shiftKey) return;
    e.preventDefault();
    const t = e.currentTarget;
    const { selectionStart: a, selectionEnd: b } = t;
    onChange(`${value.slice(0, a)}  ${value.slice(b)}`);
    requestAnimationFrame(() => t.setSelectionRange(a + 2, a + 2));
  };
  return (
    <div className="dk-ca">
      <div className="dk-ca-gutter" aria-hidden="true">
        <div style={{ transform: `translateY(${-scroll.top}px)` }}>
          {lines.map((_l, i) => (
            <div key={i} className={marks.has(i + 1) ? 'dk-ca-x' : undefined}>
              {i + 1}
            </div>
          ))}
        </div>
      </div>
      <div className="dk-ca-main">
        <div className="dk-ca-back" aria-hidden="true">
          <div style={{ transform: `translate(${-scroll.left}px, ${-scroll.top}px)` }}>
            {lines.map((l, i) => (
              <div key={i} className={marks.has(i + 1) ? 'dk-ca-x' : caretLine === i + 1 ? 'dk-ca-cur' : undefined}>
                {l ? highlight(l, 'html') : ' '}
              </div>
            ))}
          </div>
        </div>
        <textarea
          ref={ref}
          className="dk-ca-input"
          aria-label={label}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          wrap="off"
          autoFocus={autoFocus}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKey}
          onSelect={(e) => trackCaret(e.currentTarget)}
          onBlur={() => setCaretLine(null)}
          onScroll={(e) => setScroll({ top: e.currentTarget.scrollTop, left: e.currentTarget.scrollLeft })}
        />
      </div>
    </div>
  );
}

/** The "Upload folder…" and "Upload .zip / .html…" pickers of an embed (hidden; the menu opens them). */
function SitePickers({
  folderRef,
  fileRef,
  onFiles,
}: {
  folderRef: React.RefObject<HTMLInputElement>;
  fileRef: React.RefObject<HTMLInputElement>;
  onFiles: (files: File[]) => void;
}) {
  const take = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length) onFiles(files);
  };
  // React does not know webkitdirectory; it is set on the element
  useEffect(() => {
    folderRef.current?.setAttribute('webkitdirectory', '');
    folderRef.current?.setAttribute('directory', '');
  }, [folderRef]);
  return (
    <>
      <input
        ref={folderRef}
        type="file"
        multiple
        hidden
        aria-label="Upload folder"
        data-testid="html-embed-folder-input"
        onChange={take}
      />
      <input
        ref={fileRef}
        type="file"
        accept=".zip,.html,.htm,application/zip,text/html"
        hidden
        aria-label="Upload .zip or .html"
        data-testid="html-embed-file-input"
        onChange={take}
      />
    </>
  );
}

/**
 * The node view.
 */
export function HtmlEmbedView({ node, selected, editor, getPos, updateAttributes, deleteNode }: NodeViewProps) {
  const attrs = node.attrs as Record<string, unknown>;
  const html = typeof attrs.html === 'string' ? attrs.html : '';
  const rawSrc = typeof attrs.src === 'string' && attrs.src ? attrs.src : null;
  const uploadingSrc = rawSrc?.startsWith('uploading:') ? rawSrc : null;
  // the embed shows a site (not its own code) once its files are on the board
  const src = uploadingSrc ? null : rawSrc;
  const title = typeof attrs.title === 'string' ? attrs.title : '';
  const height = typeof attrs.height === 'number' && attrs.height > 0 ? attrs.height : null;
  const blockId = typeof attrs.blockId === 'string' ? attrs.blockId : null;
  const editable = editor.isEditable;
  useSyncExternalStore(subscribeSiteUploads, siteUploadsVersion);
  const upload = uploadingSrc ? siteUploadFor(uploadingSrc) : undefined;
  const folderRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const env = useEditorEnv();
  const layout = useBlockLayout();
  const phone = layout === 'phone';
  const [tab, setTab] = useState<'preview' | 'code'>(html || !editable || phone ? 'preview' : 'code');
  const [draft, setDraft] = useState(html);
  const [shown, setShown] = useState(html);
  const [fullScreen, setFullScreen] = useState(false);
  const [fullMenu, setFullMenu] = useState(false);
  const [source, setSource] = useState(false);
  const [sizeAt, setSizeAt] = useState<DOMRect | null>(null);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const sent = useRef(html);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const removed = useRemoved(blockId);
  const update = useRef(updateAttributes);
  update.current = updateAttributes;

  // a change from elsewhere (undo, a reload, another tab) replaces what is being typed
  useEffect(() => {
    if (html === sent.current) return;
    sent.current = html;
    setDraft(html);
    setShown(html);
  }, [html]);

  // the More menu closes on Esc or a click outside it
  useEffect(() => {
    if (!menu) return undefined;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (menuRef.current?.contains(t) || t?.closest?.('[aria-haspopup="menu"]')) return;
      setMenu(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(false);
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [menu]);

  // the preview and the page take the code once typing stops
  useEffect(() => {
    if (draft === sent.current) {
      setShown(draft);
      return undefined;
    }
    const t = window.setTimeout(() => {
      sent.current = draft;
      setShown(draft);
      update.current({ html: draft });
    }, SETTLE_MS);
    return () => window.clearTimeout(t);
  }, [draft]);

  const crossed = removed ? linesWith(draft, removed.keys) : [];
  const bytes = byteSize(draft);
  const lineCount = draft ? draft.split('\n').length : 0;
  const insert = (sym: string) => {
    const t = areaRef.current;
    const a = t?.selectionStart ?? draft.length;
    const b = t?.selectionEnd ?? draft.length;
    setDraft(`${draft.slice(0, a)}${sym}${draft.slice(b)}`);
    requestAnimationFrame(() => {
      t?.focus();
      t?.setSelectionRange(a + sym.length, a + sym.length);
    });
  };
  const uploadSite = (files: File[]) => {
    const pos = typeof getPos === 'function' ? getPos() : undefined;
    if (pos == null) return;
    startSiteUpload(editor, files, { replacePos: pos });
  };
  const backToInline = () => {
    updateAttributes({ src: null });
    setTab(phone ? 'preview' : 'code');
  };
  const attachAsFile = () => {
    const pos = typeof getPos === 'function' ? getPos() : undefined;
    if (pos == null) return;
    const file = new File([draft], `${(title || 'embed').replace(/[^\w.-]+/g, '-')}.html`, { type: 'text/html' });
    deleteNode();
    startDocUpload(editor, file, { kind: 'file', at: pos });
  };

  const frame = uploadingSrc ? (
    <div className="dk-emb-fail" role="status" data-testid="html-embed-upload">
      <EmbIcon name={upload?.status === 'failed' ? 'warn' : 'upload'} size={24} />
      {upload?.status === 'failed' ? (
        <>
          <strong>Not added</strong>
          <span>{upload.problem?.text}</span>
        </>
      ) : upload ? (
        <>
          <strong>
            Uploading {upload.files.length === 1 ? upload.files[0].name : `${upload.files.length} files`}…
          </strong>
          <span>
            {kbOrMb(upload.loaded)} of {kbOrMb(upload.total)}
          </span>
        </>
      ) : (
        <>
          <strong>This embed is still uploading</strong>
          <span>It shows here once its files reach the board.</span>
        </>
      )}
      {editable && (
        <div className="dk-emb-actions">
          {upload?.status === 'failed' && (
            <button
              type="button"
              className="st-btn st-btn-primary st-btn-sm"
              onClick={() => retrySiteUpload(editor, upload.id)}
            >
              Try again
            </button>
          )}
          <button
            type="button"
            className="st-btn st-btn-sm"
            onClick={() => {
              if (upload) cancelSiteUpload(editor, upload.id);
              else updateAttributes({ src: null });
            }}
          >
            {upload?.status === 'failed' ? (upload.previous ? 'Cancel' : 'Remove') : 'Cancel'}
          </button>
        </div>
      )}
    </div>
  ) : (
    <HtmlEmbedFrame
      html={shown}
      src={src}
      title={title}
      height={height}
      runScripts={!!attrs.runScripts}
      projectId={env?.projectId}
      onViewSource={() => (editable ? setTab('code') : setSource(true))}
      tooLargeActions={
        editable ? (
          <>
            <button
              type="button"
              className="st-btn st-btn-sm"
              onClick={() => (phone ? setFullScreen(true) : setTab('code'))}
            >
              Edit code
            </button>
            <button type="button" className="st-btn st-btn-sm" onClick={attachAsFile}>
              Attach as a file
            </button>
          </>
        ) : undefined
      }
    />
  );

  const removedNote = removed && editable && (
    <div className="dk-emb-bar dk-emb-bar-warn" role="status" data-testid="html-embed-removed">
      <EmbIcon name="warn" size={15} sw={2.2} />
      <span>
        <strong>
          Saved. {removed.things.length === 1 ? '1 thing was' : `${removed.things.length} things were`} removed from the
          page to keep it safe:
        </strong>{' '}
        {listWords(removed.things)}. They are still in your code, crossed out.
      </span>
      {crossed.length > 0 && (
        <button
          type="button"
          className="dk-emb-link"
          onClick={() => {
            const gone = new Set(crossed);
            setDraft(
              draft
                .split('\n')
                .filter((_l, i) => !gone.has(i + 1))
                .join('\n'),
            );
            if (blockId) clearRemoved(blockId);
          }}
        >
          Delete crossed-out lines
        </button>
      )}
      <button
        type="button"
        className="dk-emb-link"
        aria-label="Close the note"
        onClick={() => blockId && clearRemoved(blockId)}
      >
        <EmbIcon name="x" size={14} />
      </button>
    </div>
  );

  const sizeLabel = height == null ? 'Height: Auto' : `Height: ${height} px`;
  const footer = editable && (
    <div className="dk-emb-foot">
      {src || uploadingSrc ? (
        <>
          <EmbIcon name="size" size={12} />
          <span>{sizeLabel}</span>
          <span aria-hidden="true">·</span>
          <span>Scripts on</span>
          {src && (
            <span className="dk-emb-size" data-testid="html-embed-site">
              Site · {siteEntry(src)}
            </span>
          )}
        </>
      ) : tab === 'code' && !phone ? (
        <>
          {draft === shown && (
            <>
              <EmbIcon name="check" size={12} sw={2.6} />
              <span className="dk-emb-foot-ok">Saved</span>
              <span aria-hidden="true">·</span>
            </>
          )}
          <span>Preview updates when you stop typing</span>
        </>
      ) : (
        <>
          <EmbIcon name="size" size={12} />
          <span>{sizeLabel}</span>
          {!!attrs.runScripts && (
            <>
              <span aria-hidden="true">·</span>
              <span>Scripts on</span>
            </>
          )}
        </>
      )}
      {!src && !uploadingSrc && (
        <span className={`dk-emb-size${bytes > HTML_EMBED_LIMIT ? ' over' : ''}`}>
          {lineCount} lines · {kbOrMb(bytes)} of {kbOrMb(HTML_EMBED_LIMIT)}
        </span>
      )}
    </div>
  );

  const sizePanel = sizeAt && (
    <Panel title="Embed size" anchor={sizeAt} onClose={() => setSizeAt(null)} width={320} testId="html-embed-size">
      <div className="dk-emb-sz">
        <div className="dk-emb-sz-row">
          <div className="dk-bp-label">Height</div>
          <Seg
            label="Height"
            value={height == null ? 'auto' : 'fixed'}
            onChange={(v) => updateAttributes({ height: v === 'auto' ? null : (height ?? 320) })}
            options={[
              { value: 'auto', label: 'Auto' },
              { value: 'fixed', label: 'Fixed' },
            ]}
          />
          {height != null && (
            <div className="dk-emb-sz-px">
              <label className="dk-emb-px">
                <input
                  type="number"
                  min={60}
                  max={4000}
                  aria-label="Height in px"
                  value={height}
                  onChange={(e) => {
                    const n = Math.round(Number(e.target.value));
                    if (Number.isFinite(n) && n >= 60) updateAttributes({ height: Math.min(4000, n) });
                  }}
                />
                <small>px</small>
              </label>
              <span>Scrolls inside when taller</span>
            </div>
          )}
        </div>
        {!rawSrc && (
          <Toggle
            label="Run scripts"
            checked={!!attrs.runScripts}
            onChange={(v) => updateAttributes({ runScripts: v })}
          />
        )}
      </div>
      <div className="dk-emb-sz-done">
        <button type="button" className="st-btn st-btn-primary st-btn-sm" onClick={() => setSizeAt(null)}>
          Done
        </button>
      </div>
    </Panel>
  );

  const body =
    tab === 'code' && editable && !phone && !rawSrc ? (
      <div className="dk-emb-split">
        <CodeArea value={draft} onChange={setDraft} crossed={crossed} label="HTML code" areaRef={areaRef} />
        <div className="dk-emb-live">
          <div className="dk-emb-live-head">Live preview</div>
          {frame}
        </div>
      </div>
    ) : (
      <div className="dk-emb-body">{frame}</div>
    );

  const cardClass = `dk-emb dk-html-embed dk-emb-edit${phone ? ' dk-emb-phone' : ''}${selected ? ' dk-emb-selected' : ''}`;
  const card = (
    <>
      <div className="dk-emb-head" data-drag-handle="">
        {editable ? (
          <>
            <HtmlKind />
            <input
              className="dk-emb-title-input"
              aria-label="Embed title"
              placeholder="Untitled embed"
              value={title}
              onChange={(e) => updateAttributes({ title: e.target.value || null })}
            />
          </>
        ) : (
          <HtmlChip title={title} />
        )}
        {editable && !phone && !rawSrc && (
          <div className="dk-emb-tabs" role="tablist" aria-label="HTML embed">
            {(
              [
                ['code', 'Code'],
                ['preview', 'Preview'],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={tab === v}
                className={tab === v ? 'on' : undefined}
                onClick={() => setTab(v)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {!editable && (
          <button type="button" className="st-btn st-btn-sm" onClick={() => setSource((v) => !v)}>
            <EmbIcon name="code" size={12} sw={2.2} />
            {source ? 'Hide source' : 'View source'}
          </button>
        )}
        {editable && (
          <div className="dk-emb-icons">
            {!phone && (
              <button
                type="button"
                className="dk-emb-ib"
                aria-label="Embed size"
                title="Embed size"
                aria-expanded={!!sizeAt}
                data-block-ui=""
                onClick={(e) => setSizeAt(sizeAt ? null : e.currentTarget.getBoundingClientRect())}
              >
                <EmbIcon name="size" />
              </button>
            )}
            <button
              type="button"
              className="dk-emb-ib"
              aria-label="More"
              title="More"
              aria-haspopup="menu"
              aria-expanded={menu}
              onClick={() => setMenu((v) => !v)}
            >
              <EmbIcon name="more" size={phone ? 18 : 14} />
            </button>
          </div>
        )}
        {menu && (
          <div ref={menuRef} className="dk-emb-menu" role="menu" aria-label="HTML embed">
            {phone && (
              <button
                type="button"
                role="menuitem"
                onClick={(e) => {
                  setMenu(false);
                  setSizeAt(e.currentTarget.getBoundingClientRect());
                }}
              >
                Embed size
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(false);
                folderRef.current?.click();
              }}
            >
              Upload folder…
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(false);
                fileRef.current?.click();
              }}
            >
              Upload .zip / .html…
            </button>
            {src && (
              <a role="menuitem" href={siteUrl(src)} target="_blank" rel="noreferrer" onClick={() => setMenu(false)}>
                Open in a new tab
              </a>
            )}
            {rawSrc ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenu(false);
                  if (upload) dropSiteUpload(upload.id);
                  backToInline();
                }}
              >
                Back to inline code
              </button>
            ) : (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenu(false);
                  attachAsFile();
                }}
              >
                Attach as a file
              </button>
            )}
            <button type="button" role="menuitem" className="dk-emb-del" onClick={deleteNode}>
              <EmbIcon name="trash" /> Delete the embed
            </button>
          </div>
        )}
      </div>
      {!rawSrc && removedNote}
      {body}
      {footer}
      {sizePanel}
      {source && (src ? <SiteSourceView src={src} /> : <SourceView html={html} />)}
      {editable && <SitePickers folderRef={folderRef} fileRef={fileRef} onFiles={uploadSite} />}
    </>
  );
  // editing code on a phone (Embeds 11): full screen, a 46 px bar (back, the name, Saved, More), the code with its
  // colours and the caret's line tinted, and the symbol keys over the keyboard
  const fullEditor =
    fullScreen &&
    createPortal(
      <div className="dk-emb-full" role="dialog" aria-label="Edit HTML" data-block-ui="">
        <div className="dk-emb-full-head">
          <button
            type="button"
            className="dk-emb-ib dk-emb-full-ib"
            aria-label="Done"
            title="Back to the page"
            onClick={() => setFullScreen(false)}
          >
            <EmbIcon name="back" size={18} />
          </button>
          <strong>Edit HTML</strong>
          {draft === shown && (
            <span className="dk-emb-full-saved" data-testid="html-full-saved">
              <EmbIcon name="check" size={12} sw={2.6} />
              Saved
            </span>
          )}
          <span style={{ position: 'relative' }}>
            <button
              type="button"
              className="dk-emb-ib dk-emb-full-ib"
              aria-label="More"
              aria-haspopup="menu"
              aria-expanded={fullMenu}
              onClick={() => setFullMenu((v) => !v)}
            >
              <EmbIcon name="more" size={18} />
            </button>
            {fullMenu && (
              <div className="dk-emb-menu dk-emb-full-menu" role="menu" aria-label="HTML embed">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setFullMenu(false);
                    setFullScreen(false);
                    attachAsFile();
                  }}
                >
                  Attach as a file
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="dk-emb-del"
                  onClick={() => {
                    setFullScreen(false);
                    deleteNode();
                  }}
                >
                  <EmbIcon name="trash" /> Delete the embed
                </button>
              </div>
            )}
          </span>
        </div>
        <div className="dk-emb-full-body">
          <CodeArea value={draft} onChange={setDraft} crossed={crossed} label="HTML code" areaRef={areaRef} autoFocus />
        </div>
        <div className="dk-emb-symbols" role="toolbar" aria-label="Symbols">
          {SYMBOLS.map((sym) => (
            <button key={sym} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => insert(sym)}>
              {sym}
            </button>
          ))}
        </div>
      </div>,
      document.body,
    );

  // on a phone the Edit code and View source buttons sit under the card, outside its frame (Embeds board, frame 10)
  return phone ? (
    <NodeViewWrapper className="dk-emb-phone-wrap" data-testid="html-embed" contentEditable={false}>
      <div className={cardClass}>{card}</div>
      {editable && phone && !rawSrc && (
        <div className="dk-emb-under">
          <button type="button" className="st-btn" onClick={() => setFullScreen(true)}>
            <EmbIcon name="code" size={15} sw={2.2} />
            Edit code
          </button>
          <button type="button" className="st-btn" aria-pressed={source} onClick={() => setSource((v) => !v)}>
            View source
          </button>
        </div>
      )}
      {fullEditor}
    </NodeViewWrapper>
  ) : (
    <NodeViewWrapper className={cardClass} data-testid="html-embed" contentEditable={false}>
      {card}
      {fullEditor}
    </NodeViewWrapper>
  );
}
