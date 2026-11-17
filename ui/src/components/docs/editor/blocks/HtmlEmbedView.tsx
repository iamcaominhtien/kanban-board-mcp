/**
 * The HTML embed while editing (design "Embeds", frames 1-2, 6, 9-11, 70, 73): Code and Preview are two tabs of one
 * block (Preview by default). On a wide screen the Code tab shows the code and a live preview side by side; on a
 * phone editing the code opens full screen with a bar of symbols. The preview updates when typing stops. The block's
 * footer sets the height (Auto follows the content while scripts run, Fixed in px) and whether its scripts run, and
 * counts the lines and the size against the 512 KB limit. After a save that cleaned the HTML it says what was removed
 * and crosses out the lines that held it.
 */

import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { clearRemoved, useRemoved } from '../../embeds/cleanedHtml';
import { HtmlChip, SourceView } from '../../embeds/HtmlEmbedBlock';
import { HtmlEmbedFrame, SandboxNote } from '../../embeds/HtmlEmbedFrame';
import { HTML_EMBED_LIMIT, byteSize, kbOrMb, linesWith, listWords } from '../../embeds/htmlSandbox';
import { useEditorEnv } from '../context';
import { startDocUpload } from './docUpload';
import { Seg, Toggle, useBlockLayout } from './ui';
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
  const lines = value.split('\n');
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
              <div key={i} className={marks.has(i + 1) ? 'dk-ca-x' : undefined}>
                {l || ' '}
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
          onScroll={(e) => setScroll({ top: e.currentTarget.scrollTop, left: e.currentTarget.scrollLeft })}
        />
      </div>
    </div>
  );
}

/**
 * The node view.
 */
export function HtmlEmbedView({ node, selected, editor, getPos, updateAttributes, deleteNode }: NodeViewProps) {
  const attrs = node.attrs as Record<string, unknown>;
  const html = typeof attrs.html === 'string' ? attrs.html : '';
  const title = typeof attrs.title === 'string' ? attrs.title : '';
  const height = typeof attrs.height === 'number' && attrs.height > 0 ? attrs.height : null;
  const blockId = typeof attrs.blockId === 'string' ? attrs.blockId : null;
  const editable = editor.isEditable;
  const env = useEditorEnv();
  const layout = useBlockLayout();
  const phone = layout === 'phone';
  const [tab, setTab] = useState<'preview' | 'code'>(html || !editable || phone ? 'preview' : 'code');
  const [draft, setDraft] = useState(html);
  const [shown, setShown] = useState(html);
  const [fullScreen, setFullScreen] = useState(false);
  const [source, setSource] = useState(false);
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
  const attachAsFile = () => {
    const pos = typeof getPos === 'function' ? getPos() : undefined;
    if (pos == null) return;
    const file = new File([draft], `${(title || 'embed').replace(/[^\w.-]+/g, '-')}.html`, { type: 'text/html' });
    deleteNode();
    startDocUpload(editor, file, { kind: 'file', at: pos });
  };

  const frame = (
    <HtmlEmbedFrame
      html={shown}
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
              className="dk-btn-ghost"
              onClick={() => (phone ? setFullScreen(true) : setTab('code'))}
            >
              Edit code
            </button>
            <button type="button" className="dk-btn-ghost" onClick={attachAsFile}>
              Attach as a file
            </button>
          </>
        ) : undefined
      }
    />
  );

  const removedNote = removed && editable && (
    <div className="dk-emb-bar dk-emb-bar-warn" role="status" data-testid="html-embed-removed">
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
        ×
      </button>
    </div>
  );

  const footer = editable && (
    <div className="dk-emb-foot">
      <span className="dk-emb-foot-group">
        Height
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
          <input
            className="dk-bp-input dk-emb-px"
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
        )}
      </span>
      <Toggle label="Run scripts" checked={!!attrs.runScripts} onChange={(v) => updateAttributes({ runScripts: v })} />
      <span className={`dk-emb-size${bytes > HTML_EMBED_LIMIT ? ' over' : ''}`}>
        {lineCount} lines · {kbOrMb(bytes)} of 512 KB
      </span>
    </div>
  );

  return (
    <NodeViewWrapper
      className={`dk-emb dk-html-embed dk-emb-edit${selected ? ' dk-emb-selected' : ''}`}
      data-testid="html-embed"
      contentEditable={false}
    >
      <div className="dk-emb-head" data-drag-handle="">
        {editable ? (
          <span className="dk-emb-head-label">
            <span className="dk-emb-kind">HTML</span>
            <input
              className="dk-emb-title-input"
              aria-label="Embed title"
              placeholder="Untitled embed"
              value={title}
              onChange={(e) => updateAttributes({ title: e.target.value || null })}
            />
          </span>
        ) : (
          <HtmlChip title={title} />
        )}
        {editable && !phone && (
          <div className="dk-bp-tabs dk-emb-tabs" role="tablist" aria-label="HTML embed">
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
        {editable && phone && (
          <button type="button" className="dk-emb-link" onClick={() => setFullScreen(true)}>
            Edit code
          </button>
        )}
        {!editable && (
          <button type="button" className="dk-emb-link" onClick={() => setSource((v) => !v)}>
            {source ? 'Hide source' : 'View source'}
          </button>
        )}
        {editable && (
          <button type="button" className="dk-emb-link dk-emb-del" aria-label="Delete the embed" onClick={deleteNode}>
            Delete
          </button>
        )}
      </div>
      <SandboxNote />
      {removedNote}
      {tab === 'code' && editable && !phone ? (
        <div className="dk-emb-split">
          <CodeArea value={draft} onChange={setDraft} crossed={crossed} label="HTML code" areaRef={areaRef} />
          <div className="dk-emb-live">
            <div className="dk-emb-live-head">Live preview</div>
            {frame}
          </div>
        </div>
      ) : (
        frame
      )}
      {tab === 'code' && editable && !phone && <div className="dk-emb-hint">Preview updates when you stop typing</div>}
      {footer}
      {source && <SourceView html={html} />}
      {fullScreen &&
        createPortal(
          <div className="dk-emb-full" role="dialog" aria-label="Edit HTML" data-block-ui="">
            <div className="dk-emb-full-head">
              <strong>Edit HTML</strong>
              <button type="button" className="dk-btn-primary" onClick={() => setFullScreen(false)}>
                Done
              </button>
            </div>
            <CodeArea
              value={draft}
              onChange={setDraft}
              crossed={crossed}
              label="HTML code"
              areaRef={areaRef}
              autoFocus
            />
            <SandboxNote />
            <div className="dk-emb-symbols" role="toolbar" aria-label="Symbols">
              {SYMBOLS.map((s) => (
                <button key={s} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => insert(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </NodeViewWrapper>
  );
}
