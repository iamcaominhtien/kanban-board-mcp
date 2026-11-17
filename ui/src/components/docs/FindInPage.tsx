import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import './docs.css';
import { Icon } from './Icon';
import { getActiveReplaceAdapter } from './editorReplace';

export interface FindReplaceOptions {
  /** true for Replace all; false replaces only the current match (`index`). */
  all: boolean;
  matchCase: boolean;
  wholeWord: boolean;
  /** Index of the current match (0-based) when `all` is false. */
  index: number;
}

/** Implemented by the editor (Tiptap/ProseMirror) so replacement goes through a single transaction. */
export interface FindReplaceAdapter {
  /** Replaces and returns the number of replacements. */
  replace(find: string, replaceWith: string, opts: FindReplaceOptions): number;
  /** Optional undo of the last replace (the Undo button); falls back to `document.execCommand('undo')`. */
  undo?: () => void;
  /**
   * The matches as page ranges, in the order `replace` counts them (so the current match is the one replaced). The
   * bar uses them instead of searching the page's DOM when given.
   */
  find?: (find: string, opts: { matchCase: boolean; wholeWord: boolean }) => Range[];
}

export interface FindInPageProps {
  /** Rendered page content or the editor's DOM element. */
  root: HTMLElement | null;
  /** Shows Replace / Replace all (needs `replaceAdapter` or `onReplace`). */
  editable?: boolean;
  onClose: () => void;
  replaceAdapter?: FindReplaceAdapter;
  onReplace?: (from: string, to: string, all: boolean) => void;
  /** Open with the replace row (Ctrl/Cmd+H); Ctrl/Cmd+H or the bar's toggle shows it later. */
  replaceOpen?: boolean;
}

const OPT_KEY = 'docsFindOptions';

/** The event the editor's Find button sends to open the bar (`detail.replace` asks for the replace row). */
export const OPEN_FIND_EVENT = 'docs-open-find';

/** Whether the next bar opens with its replace row (set by Ctrl+H or the editor's Find and replace button). */
let replaceNext = false;

/**
 * Opens the find bar of the Docs space (from the editor's ribbon or the phone's More sheet).
 * @param replace - Open with the replace row.
 */
export function openDocsFind(replace: boolean) {
  window.dispatchEvent(new CustomEvent(OPEN_FIND_EVENT, { detail: { replace } }));
}

/**
 * Ctrl/Cmd+F opens the bar; a second Ctrl/Cmd+F lets the browser's own find run (we stop intercepting while open).
 * Ctrl/Cmd+H opens it with the replace row while a page is being edited. Pass `isOpen` so the hook knows. Mount only
 * while a page is shown.
 * @param onOpen - Called when Ctrl/Cmd+F or H is pressed while the bar is closed.
 * @param isOpen - Whether the bar is open; interception stops while true.
 */
export function useDocsFindHotkey(onOpen: () => void, isOpen: boolean) {
  const ref = useRef({ onOpen, isOpen });
  ref.current = { onOpen, isOpen };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'f') {
        if (ref.current.isOpen) return; // second press: native browser find
        e.preventDefault();
        replaceNext = false;
        ref.current.onOpen();
      } else if (k === 'h' && getActiveReplaceAdapter()) {
        e.preventDefault();
        replaceNext = true;
        if (ref.current.isOpen) window.dispatchEvent(new CustomEvent(SHOW_REPLACE_EVENT));
        else ref.current.onOpen();
      }
    };
    const onEvent = (e: Event) => {
      const replace = !!(e as CustomEvent<{ replace?: boolean }>).detail?.replace;
      replaceNext = replace;
      if (ref.current.isOpen) {
        if (replace) window.dispatchEvent(new CustomEvent(SHOW_REPLACE_EVENT));
      } else ref.current.onOpen();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_FIND_EVENT, onEvent);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(OPEN_FIND_EVENT, onEvent);
    };
  }, []);
}

/** Shows the replace row of an open bar. */
const SHOW_REPLACE_EVENT = 'docs-find-show-replace';

function loadOpts(): { matchCase: boolean; wholeWord: boolean } {
  try {
    const v = JSON.parse(localStorage.getItem(OPT_KEY) ?? '{}');
    return { matchCase: !!v.matchCase, wholeWord: !!v.wholeWord };
  } catch {
    return { matchCase: false, wholeWord: false };
  }
}

const HL =
  typeof CSS !== 'undefined' &&
  'highlights' in CSS &&
  typeof (window as unknown as { Highlight?: unknown }).Highlight === 'function';

/**
 * The search as a regular expression (global, Unicode): a whole word is not touched by a letter, digit or `_`.
 * @param q - The text searched for.
 * @param matchCase - Match upper and lower case as typed.
 * @param wholeWord - Match whole words only.
 */
export function buildRegex(q: string, matchCase: boolean, wholeWord: boolean): RegExp | null {
  if (!q) return null;
  const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(wholeWord ? `(?<![\\p{L}\\p{N}_])${esc}(?![\\p{L}\\p{N}_])` : esc, matchCase ? 'gu' : 'giu');
}

function textNodes(root: HTMLElement, skip: HTMLElement | null): Text[] {
  const out: Text[] = [];
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = n.parentElement;
      if (!p || (skip && skip.contains(p))) return NodeFilter.FILTER_REJECT;
      if (p.closest('.dk-cmt-badge')) return NodeFilter.FILTER_REJECT;
      const tag = p.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
      return n.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  let n: Node | null;
  while ((n = w.nextNode())) out.push(n as Text);
  return out;
}

function unwrapMarks(root: HTMLElement) {
  const marks = root.querySelectorAll('mark.docs-find-mark');
  const parents = new Set<Node>();
  marks.forEach((m) => {
    const p = m.parentNode;
    if (!p) return;
    p.replaceChild(document.createTextNode(m.textContent ?? ''), m);
    parents.add(p);
  });
  parents.forEach((p) => p.normalize());
}

/**
 * Find (and replace) bar. Design: DocsSearch.dc.html artboard F. Position it inside a `position: relative` container.
 * @param props.root - Rendered page content or the editor's DOM element to search.
 * @param props.editable - Show Replace and Replace all (needs `replaceAdapter` or `onReplace`).
 * @param props.onClose - Called to close the bar.
 * @param props.replaceAdapter - Replaces matches inside an editor.
 * @param props.onReplace - Called with the search text, the replacement and whether to replace all.
 */
export function FindInPage({
  root,
  editable = false,
  onClose,
  replaceAdapter,
  onReplace,
  replaceOpen,
}: FindInPageProps) {
  const [q, setQ] = useState(() => {
    const s = window.getSelection()?.toString().trim();
    return s && s.length < 80 && !s.includes('\n') ? s : '';
  });
  const [dq, setDq] = useState(q);
  const [opts, setOpts] = useState(loadOpts);
  const [replaceWith, setReplaceWith] = useState('');
  const [count, setCount] = useState(0);
  const [cur, setCur] = useState(0);
  const [showReplace, setShowReplace] = useState(() => replaceOpen ?? replaceNext);
  // after Replace all: how many were changed (shown with Undo until the next search)
  const [replaced, setReplaced] = useState<number | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const show = () => setShowReplace(true);
    window.addEventListener(SHOW_REPLACE_EVENT, show);
    return () => window.removeEventListener(SHOW_REPLACE_EVENT, show);
  }, []);

  // The bar takes room above the page instead of covering its header (Share, Edit, ···): while it is open, the
  // space it sits in is marked, and the page view and the editor are pushed down by the bar's height (docs.css)
  useLayoutEffect(() => {
    const bar = barRef.current;
    const host = bar?.parentElement;
    if (!bar || !host) return;
    const sync = () => host.style.setProperty('--dk-find-h', `${Math.ceil(bar.getBoundingClientRect().height)}px`);
    sync();
    host.classList.add('dk-find-open');
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(sync);
    ro?.observe(bar);
    return () => {
      ro?.disconnect();
      host.classList.remove('dk-find-open');
      host.style.removeProperty('--dk-find-h');
    };
  }, []);
  const inputRef = useRef<HTMLInputElement>(null);
  const ranges = useRef<Range[]>([]);
  const marksRef = useRef<HTMLElement[]>([]);
  const useMarks = !HL && !editable;
  const canReplace = editable && !!(replaceAdapter || onReplace);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  useEffect(() => {
    const t = window.setTimeout(() => setDq(q), 100);
    return () => window.clearTimeout(t);
  }, [q]);
  useEffect(() => {
    try {
      localStorage.setItem(OPT_KEY, JSON.stringify(opts));
    } catch {
      /* ignore */
    }
  }, [opts]);

  const clearHighlights = useCallback(() => {
    if (HL) {
      CSS.highlights.delete('docs-find');
      CSS.highlights.delete('docs-find-current');
    }
    if (root && marksRef.current.length) unwrapMarks(root);
    marksRef.current = [];
  }, [root]);

  const scan = useCallback(() => {
    clearHighlights();
    ranges.current = [];
    const re = buildRegex(dq, opts.matchCase, opts.wholeWord);
    if (!root || !re) {
      setCount(0);
      setCur(0);
      return;
    }
    const found: Range[] = [];
    if (editable && replaceAdapter?.find) {
      // the editor's own matches: the same ones, in the same order, that Replace changes
      found.push(...replaceAdapter.find(dq, { matchCase: opts.matchCase, wholeWord: opts.wholeWord }));
    } else
      for (const node of textNodes(root, barRef.current)) {
        const text = node.nodeValue ?? '';
        re.lastIndex = 0;
        for (const m of text.matchAll(re)) {
          if (!m[0]) continue;
          const r = document.createRange();
          r.setStart(node, m.index ?? 0);
          r.setEnd(node, (m.index ?? 0) + m[0].length);
          found.push(r);
        }
      }
    if (useMarks) {
      // no CSS Custom Highlight API: wrap matches (read mode only), last to first so earlier ranges stay valid
      const marks: HTMLElement[] = [];
      for (let i = found.length - 1; i >= 0; i--) {
        const mk = document.createElement('mark');
        mk.className = 'docs-find-mark';
        try {
          found[i].surroundContents(mk);
          marks.unshift(mk);
        } catch {
          /* skip */
        }
      }
      marksRef.current = marks;
      ranges.current = marks.map((m) => {
        const r = document.createRange();
        r.selectNodeContents(m);
        return r;
      });
    } else {
      ranges.current = found;
      if (HL && found.length) {
        const H = (window as unknown as { Highlight: new (...r: Range[]) => Highlight }).Highlight;
        CSS.highlights.set('docs-find', new H(...found));
      }
    }
    setCount(ranges.current.length);
    setCur((c) => (ranges.current.length ? Math.min(c, ranges.current.length - 1) : 0));
  }, [dq, opts.matchCase, opts.wholeWord, root, useMarks, clearHighlights, editable, replaceAdapter]);

  useLayoutEffect(() => {
    scan();
    return clearHighlights;
  }, [scan, clearHighlights]);

  // re-scan when the content changes (typing in the editor, page refresh)
  useEffect(() => {
    if (!root || !editable) return;
    let t: number | undefined;
    const mo = new MutationObserver(() => {
      window.clearTimeout(t);
      t = window.setTimeout(scan, 150);
    });
    mo.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      window.clearTimeout(t);
      mo.disconnect();
    };
  }, [root, editable, scan]);

  // paint the current match and scroll it into view
  useEffect(() => {
    const r = ranges.current[cur];
    if (!r) return;
    if (HL) {
      const H = (window as unknown as { Highlight: new (...r: Range[]) => Highlight }).Highlight;
      CSS.highlights.set('docs-find-current', new H(r));
    }
    marksRef.current.forEach((m, i) => m.classList.toggle('docs-find-cur', i === cur));
    const el = (
      r.startContainer.nodeType === 1 ? (r.startContainer as HTMLElement) : r.startContainer.parentElement
    ) as HTMLElement | null;
    el?.scrollIntoView({ block: 'center', inline: 'nearest' });
  }, [cur, count]);

  const step = (d: 1 | -1) => {
    if (!count) return;
    setCur((c) => (c + d + count) % count);
  };

  const doReplace = (all: boolean) => {
    if (!canReplace || !dq) return;
    let n = 0;
    if (replaceAdapter) {
      n = replaceAdapter.replace(dq, replaceWith, {
        all,
        matchCase: opts.matchCase,
        wholeWord: opts.wholeWord,
        index: cur,
      });
    } else {
      onReplace?.(dq, replaceWith, all);
      n = all ? count : 1;
    }
    window.setTimeout(scan, 0);
    if (all && n > 0) setReplaced(n);
  };
  const undoReplaceAll = () => {
    if (replaceAdapter?.undo) replaceAdapter.undo();
    else document.execCommand('undo');
    setReplaced(null);
    window.setTimeout(scan, 50);
  };
  useEffect(() => setReplaced(null), [dq]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    }
  };

  const none = dq !== '' && count === 0 && replaced === null;
  const counter = useMemo(
    () => (dq === '' ? '' : count ? `${cur + 1}/${count}` : replaced !== null ? '0/0' : 'No results'),
    [dq, count, cur, replaced],
  );

  const tbtn = (label: string, on: boolean, onClick: () => void, child: React.ReactNode) => (
    <button
      type="button"
      aria-label={label}
      aria-pressed={on}
      title={label}
      onClick={onClick}
      className={`fx-findbtn${on ? ' fx-findbtn-on' : ''}`}
    >
      {child}
    </button>
  );

  return (
    <div
      ref={barRef}
      className="docs-root"
      style={{ position: 'absolute', right: 18, top: 12, zIndex: 40 }}
      role="search"
      aria-label="Find in page"
    >
      <div
        // reading (Reader boards, F: frame 47): a 430 px card, 12 px corners, a 36 px field and 36 px buttons
        className={editable ? 'dk-menu' : 'dk-menu fx-find-read'}
        style={{
          width: editable ? 460 : 430,
          maxWidth: 'calc(100vw - 32px)',
          padding: 8,
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <div
            style={{
              flex: 1,
              minWidth: 0,
              display: 'flex',
              alignItems: 'center',
              gap: editable ? 6 : 7,
              padding: editable ? '0 9px' : '0 10px',
              height: editable ? 30 : 36,
              borderRadius: editable ? 7 : 8,
              border: `1px solid ${none ? '#C4432A' : '#2E6F40'}`,
              background: '#FFFFFF',
              boxSizing: 'border-box',
              boxShadow: none
                ? '0 0 0 3px rgba(196,67,42,0.14)'
                : `0 0 0 3px rgba(46,111,64,${editable ? 0.18 : 0.14})`,
            }}
          >
            {!editable && <Icon name="search" size={14} strokeWidth={1.9} style={{ color: '#5B6B60' }} />}
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={onKey}
              aria-label="Find"
              placeholder="Find in page"
              spellCheck={false}
              style={{
                flex: 1,
                minWidth: 0,
                border: 'none',
                outline: 'none',
                background: 'transparent',
                fontSize: editable ? 13 : 13.5,
                fontWeight: 500,
                color: '#1E2A22',
                fontFamily: 'inherit',
                padding: 0,
              }}
            />
            <span
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 11.5,
                fontWeight: 500,
                color: none ? '#C4432A' : '#5B6B60',
                whiteSpace: 'nowrap',
              }}
            >
              {counter}
            </span>
          </div>
          <button
            type="button"
            aria-label="Previous match"
            title="Previous match (Shift+Enter)"
            className="fx-findbtn"
            onClick={() => step(-1)}
          >
            <Icon name="i34" size={15} strokeWidth={1.9} />
          </button>
          <button
            type="button"
            aria-label="Next match"
            title="Next match (Enter)"
            className="fx-findbtn"
            onClick={() => step(1)}
          >
            <Icon name="i06" size={15} strokeWidth={1.9} />
          </button>
          <div style={{ width: 1, height: 16, background: '#DCE6DF', margin: '0 3px' }} />
          {tbtn('Match case', opts.matchCase, () => setOpts((o) => ({ ...o, matchCase: !o.matchCase })), 'Aa')}
          {tbtn(
            'Whole word',
            opts.wholeWord,
            () => setOpts((o) => ({ ...o, wholeWord: !o.wholeWord })),
            <span
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 11,
                fontWeight: 700,
                border: '1.5px solid currentColor',
                borderTop: 'none',
                padding: '0 2px 1px',
                lineHeight: 1.1,
              }}
            >
              ab
            </span>,
          )}
          {canReplace &&
            tbtn(
              showReplace ? 'Hide replace' : 'Replace',
              showReplace,
              () => setShowReplace((v) => !v),
              <Icon name={showReplace ? 'chevronDown' : 'chevronRight'} size={14} strokeWidth={2} />,
            )}
          <button type="button" aria-label="Close" title="Close (Esc)" className="fx-findbtn" onClick={onClose}>
            <Icon name="i08" size={15} strokeWidth={1.9} />
          </button>
        </div>
        {canReplace && showReplace && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div
              style={{
                flex: 1,
                minWidth: 0,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '0 9px',
                height: 30,
                borderRadius: 7,
                border: '1px solid #C7D2CB',
                background: '#FFFFFF',
                boxSizing: 'border-box',
              }}
            >
              <input
                value={replaceWith}
                onChange={(e) => setReplaceWith(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') onKey(e);
                  else if (e.key === 'Enter') {
                    e.preventDefault();
                    doReplace(false);
                  }
                }}
                aria-label="Replace with"
                placeholder="Replace with"
                style={{
                  flex: 1,
                  minWidth: 0,
                  border: 'none',
                  outline: 'none',
                  background: 'transparent',
                  fontSize: 13,
                  fontWeight: 500,
                  color: '#1E2A22',
                  fontFamily: 'inherit',
                  padding: 0,
                }}
              />
            </div>
            <button
              type="button"
              className="st-btn st-btn-sm"
              style={{ height: 30, padding: '0 10px' }}
              disabled={!count}
              onClick={() => doReplace(false)}
            >
              Replace
            </button>
            <button
              type="button"
              className="st-btn st-btn-sm"
              style={{ height: 30, padding: '0 10px' }}
              disabled={!count}
              onClick={() => doReplace(true)}
            >
              Replace all
            </button>
          </div>
        )}
        {replaced !== null && (
          <div
            role="status"
            data-testid="find-replaced"
            style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, fontWeight: 600, color: '#2E6F40' }}
          >
            <span style={{ flex: 1 }}>
              Replaced {replaced} {replaced === 1 ? 'match' : 'matches'}
            </span>
            <button type="button" className="st-btn st-btn-sm" onClick={undoReplaceAll}>
              Undo
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
