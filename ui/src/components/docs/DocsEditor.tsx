import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { client } from '../../api/client';
import { docsKeys } from '../../api/docs';
import { useTickets, uploadDescriptionImage } from '../../api/tickets';
import { resolveOrigin } from '../../api/resolveOrigin';
import { htmlToMarkdown, isSafeUrl, markdownToHtml } from '../../utils/markdownWysiwyg';
import { slugify } from '../../utils/docsMarkdown';
import type { DocsHeading, DocsPage, DocsTreeNode } from '../../types/docs';
import mdStyles from '../MarkdownRenderer.module.css';
import styles from './DocsEditor.module.css';

export type EditorMode = 'visual' | 'markdown';

interface Props {
  projectId: string;
  markdown: string;
  onChange: (markdown: string) => void;
  mode: EditorMode;
  nodes: DocsTreeNode[];
  currentPageId: string;
  onSave?: () => void;
  onPublish?: () => void;
  onToggleMode?: () => void;
}

interface SlashItem {
  id: string;
  label: string;
  hint: string;
  keywords: string;
  run: () => void;
}

interface Popup {
  kind: 'slash' | 'ref';
  query: string;
  rect: { top: number; left: number };
  node: Text;
  start: number;
  end: number;
}

const CALLOUT_HTML = (kind: string) =>
  `<blockquote data-callout="${kind}"><p>${kind === 'warning' ? 'Heads up…' : 'Note…'}</p></blockquote><p><br></p>`;
const TABLE_HTML =
  '<table><thead><tr><th>Column</th><th>Column</th><th>Column</th></tr></thead><tbody>' +
  '<tr><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr><tr><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr></tbody></table><p><br></p>';

function exec(cmd: string, value?: string) {
  document.execCommand(cmd, false, value);
}

function escapeAttr(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function DocsEditor({
  projectId,
  markdown,
  onChange,
  mode,
  nodes,
  currentPageId,
  onSave,
  onPublish,
  onToggleMode,
}: Props) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const savedRange = useRef<Range | null>(null);
  const [popup, setPopup] = useState<Popup | null>(null);
  const [active, setActive] = useState(0);
  const [floating, setFloating] = useState<{ top: number; left: number; inTable: boolean } | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { data: tickets = [] } = useTickets(projectId);
  const [sectionPage, setSectionPage] = useState<{ title: string; headings: DocsHeading[] } | null>(null);

  // ── keep the contentEditable in sync with the markdown source ──
  useEffect(() => {
    const el = surfaceRef.current;
    if (mode !== 'visual' || !el) return;
    if (htmlToMarkdown(el) !== markdown.trim()) el.innerHTML = markdownToHtml(markdown);
  }, [markdown, mode]);

  const emit = useCallback(() => {
    const el = surfaceRef.current;
    if (el) onChange(htmlToMarkdown(el));
  }, [onChange]);

  // ── slash menu and [[ suggester ──
  const closePopup = useCallback(() => {
    setPopup(null);
    setSectionPage(null);
  }, []);

  function detectTriggers() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return closePopup();
    const node = sel.anchorNode;
    if (!node || node.nodeType !== Node.TEXT_NODE || !surfaceRef.current?.contains(node)) return closePopup();
    const before = (node.textContent ?? '').slice(0, sel.anchorOffset);
    const rect = (() => {
      const r = sel.getRangeAt(0).getClientRects()[0] ?? (node.parentElement as HTMLElement).getBoundingClientRect();
      const w = wrapRef.current!.getBoundingClientRect();
      return { top: r.bottom - w.top + 6, left: Math.max(0, r.left - w.left) };
    })();
    const ref = before.match(/\[\[([^\]\n]*)$/);
    if (ref) {
      setPopup({ kind: 'ref', query: ref[1], rect, node: node as Text, start: before.length - ref[0].length, end: sel.anchorOffset });
      setActive(0);
      return;
    }
    const slash = before.match(/(^|\s)\/([\w-]*)$/);
    if (slash) {
      const start = before.length - slash[2].length - 1;
      setPopup({ kind: 'slash', query: slash[2], rect, node: node as Text, start, end: sel.anchorOffset });
      setActive(0);
      return;
    }
    closePopup();
  }

  function removeTrigger(p: Popup) {
    const range = document.createRange();
    range.setStart(p.node, p.start);
    range.setEnd(p.node, Math.min(p.end, p.node.length));
    range.deleteContents();
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }

  function convertBlockShortcut(): boolean {
    const sel = window.getSelection();
    const node = sel?.anchorNode;
    if (!sel || !node || node.nodeType !== Node.TEXT_NODE) return false;
    const text = (node.textContent ?? '').replace(/ /g, ' ');
    const block = (node.parentElement as HTMLElement).closest('p,div,li');
    if (!block || block !== node.parentElement) return false;
    const apply = (cmd: () => void) => {
      node.textContent = '';
      cmd();
      return true;
    };
    const h = text.match(/^(#{1,4}) $/);
    if (h) return apply(() => exec('formatBlock', `h${Math.max(2, h[1].length)}`));
    if (/^[-*] $/.test(text)) return apply(() => exec('insertUnorderedList'));
    if (/^1[.)] $/.test(text)) return apply(() => exec('insertOrderedList'));
    if (/^> $/.test(text)) return apply(() => exec('formatBlock', 'blockquote'));
    if (/^\[\] $/.test(text)) {
      return apply(() =>
        exec('insertHTML', '<ul><li data-task="1"><input type="checkbox" contenteditable="false">&nbsp;</li></ul>'),
      );
    }
    return false;
  }

  function onInput(e: React.FormEvent) {
    const native = e.nativeEvent as InputEvent;
    if (native.inputType === 'insertText' && native.data === ' ') convertBlockShortcut();
    emit();
    detectTriggers();
  }

  // ── commands (toolbar + slash menu share these) ──
  const insertImage = () => {
    const sel = window.getSelection();
    savedRange.current = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    fileRef.current?.click();
  };

  async function onImagePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    try {
      const res = await uploadDescriptionImage(file);
      surfaceRef.current?.focus();
      const sel = window.getSelection();
      if (savedRange.current) {
        sel?.removeAllRanges();
        sel?.addRange(savedRange.current);
      }
      const src = res.url.startsWith('/uploads/') ? `${resolveOrigin()}${res.url}` : res.url;
      exec('insertHTML', `<img src="${escapeAttr(src)}" alt="${escapeAttr(file.name.replace(/\.[^.]+$/, ''))}">`);
      emit();
    } catch {
      setError('Could not upload the image. Check the file type (png, jpeg, gif, webp) and size (max 5 MB).');
    }
  }

  const cmds = useMemo(
    () => ({
      h: (n: number) => () => exec('formatBlock', `h${n}`),
      ul: () => exec('insertUnorderedList'),
      ol: () => exec('insertOrderedList'),
      task: () =>
        exec('insertHTML', '<ul><li data-task="1"><input type="checkbox" contenteditable="false">&nbsp;</li></ul>'),
      quote: () => exec('formatBlock', 'blockquote'),
      table: () => exec('insertHTML', TABLE_HTML),
      code: () => exec('insertHTML', '<pre><code>code</code></pre><p><br></p>'),
      callout: (kind: string) => () => exec('insertHTML', CALLOUT_HTML(kind)),
      hr: () => exec('insertHorizontalRule'),
    }),
    [],
  );

  function inlineCode() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return;
    const text = sel.toString();
    exec('insertHTML', `<code>${escapeAttr(text)}</code>`);
  }

  function openLink() {
    const sel = window.getSelection();
    savedRange.current = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    setLinkUrl('');
    setLinkOpen(true);
  }

  function applyLink() {
    setLinkOpen(false);
    const url = linkUrl.trim();
    if (!url || !isSafeUrl(url)) return;
    surfaceRef.current?.focus();
    const sel = window.getSelection();
    if (savedRange.current) {
      sel?.removeAllRanges();
      sel?.addRange(savedRange.current);
    }
    if (sel && sel.isCollapsed) exec('insertHTML', `<a href="${escapeAttr(url)}">${escapeAttr(url)}</a>`);
    else exec('createLink', url);
    emit();
  }

  function insertRefTrigger() {
    surfaceRef.current?.focus();
    exec('insertText', '[[');
    detectTriggers();
  }

  const slashItems: SlashItem[] = useMemo(
    () => [
      { id: 'h2', label: 'Heading 2', hint: '##', keywords: 'heading h2 title', run: cmds.h(2) },
      { id: 'h3', label: 'Heading 3', hint: '###', keywords: 'heading h3', run: cmds.h(3) },
      { id: 'h4', label: 'Heading 4', hint: '####', keywords: 'heading h4', run: cmds.h(4) },
      { id: 'ul', label: 'Bulleted list', hint: '-', keywords: 'bullet list ul', run: cmds.ul },
      { id: 'ol', label: 'Numbered list', hint: '1.', keywords: 'number ordered list ol', run: cmds.ol },
      { id: 'task', label: 'Task list', hint: '[]', keywords: 'task todo checkbox checklist', run: cmds.task },
      { id: 'quote', label: 'Quote', hint: '>', keywords: 'quote blockquote', run: cmds.quote },
      { id: 'table', label: 'Table', hint: '3×3', keywords: 'table grid', run: cmds.table },
      { id: 'code', label: 'Code block', hint: '```', keywords: 'code block pre', run: cmds.code },
      { id: 'info', label: 'Info callout', hint: '[!INFO]', keywords: 'callout info note', run: cmds.callout('info') },
      { id: 'warning', label: 'Warning callout', hint: '[!WARNING]', keywords: 'callout warning alert', run: cmds.callout('warning') },
      { id: 'hr', label: 'Divider', hint: '---', keywords: 'divider line hr rule', run: cmds.hr },
      { id: 'image', label: 'Image', hint: 'upload', keywords: 'image picture photo upload', run: insertImage },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cmds],
  );

  // ── reference suggester data ──
  const refQuery = popup?.kind === 'ref' ? popup.query : '';
  const [titlePart, sectionPart] = refQuery.split('#');
  const pageMatches = useMemo(() => {
    if (popup?.kind !== 'ref' || sectionPart !== undefined) return [];
    const q = titlePart.trim().toLowerCase();
    return nodes
      .filter((n) => n.id !== currentPageId && (!q || n.title.toLowerCase().includes(q)))
      .slice(0, 6);
  }, [popup?.kind, nodes, titlePart, sectionPart, currentPageId]);
  const ticketMatches = useMemo(() => {
    if (popup?.kind !== 'ref' || sectionPart !== undefined) return [];
    const q = titlePart.trim().toLowerCase();
    if (!q) return [];
    return tickets.filter((t) => t.id.toLowerCase().includes(q) || t.title.toLowerCase().includes(q)).slice(0, 4);
  }, [popup?.kind, tickets, titlePart, sectionPart]);

  // when the title part names a page, load its headings so [[Page# can complete sections
  useEffect(() => {
    if (popup?.kind !== 'ref' || sectionPart === undefined) {
      setSectionPage(null);
      return;
    }
    const target = nodes.find((n) => n.title.toLowerCase() === titlePart.trim().toLowerCase());
    if (!target) {
      setSectionPage(null);
      return;
    }
    let cancelled = false;
    void queryClient
      .fetchQuery({
        queryKey: docsKeys.page(target.id),
        queryFn: async () => (await client.get<DocsPage>(`/docs/pages/${target.id}`)).data,
        staleTime: 10_000,
      })
      .then((p) => !cancelled && setSectionPage({ title: p.title, headings: p.headings }))
      .catch(() => !cancelled && setSectionPage(null));
    return () => {
      cancelled = true;
    };
  }, [popup?.kind, titlePart, sectionPart, nodes, queryClient]);

  const sectionMatches = useMemo(() => {
    if (!sectionPage || sectionPart === undefined) return [];
    const q = slugify(sectionPart);
    return sectionPage.headings.filter((h) => !q || h.slug.includes(q) || h.text.toLowerCase().includes(sectionPart.toLowerCase()));
  }, [sectionPage, sectionPart]);

  const slashMatches = useMemo(() => {
    if (popup?.kind !== 'slash') return [];
    const q = popup.query.toLowerCase();
    return slashItems.filter((i) => !q || i.label.toLowerCase().includes(q) || i.keywords.includes(q));
  }, [popup, slashItems]);

  type RefChoice =
    | { type: 'page'; label: string; sub: string; ref: string }
    | { type: 'section'; label: string; sub: string; ref: string }
    | { type: 'ticket'; label: string; sub: string; key: string };
  const refChoices: RefChoice[] = useMemo(
    () => [
      ...pageMatches.map((n): RefChoice => ({ type: 'page', label: n.title, sub: 'Page', ref: n.title })),
      ...sectionMatches.map((h): RefChoice => ({
        type: 'section',
        label: h.text,
        sub: `Section of ${sectionPage?.title ?? ''}`,
        ref: `${sectionPage?.title ?? ''}#${h.text}`,
      })),
      ...ticketMatches.map((t): RefChoice => ({ type: 'ticket', label: t.id, sub: t.title, key: t.id })),
    ],
    [pageMatches, sectionMatches, ticketMatches, sectionPage],
  );
  const itemCount = popup?.kind === 'slash' ? slashMatches.length : refChoices.length;

  function chooseRef(choice: RefChoice) {
    if (!popup) return;
    removeTrigger(popup);
    if (choice.type === 'ticket') exec('insertText', `${choice.key} `);
    else {
      const label = choice.type === 'section' ? choice.ref.replace('#', ' › ') : choice.ref;
      // insert at the caret with the Range API: execCommand('insertHTML') can hoist the chip out of its paragraph
      const sel = window.getSelection();
      if (sel && sel.rangeCount) {
        const chip = document.createElement('span');
        chip.className = 'docRef';
        chip.setAttribute('data-ref', choice.ref);
        chip.setAttribute('contenteditable', 'false');
        chip.textContent = label;
        const space = document.createTextNode('\u00a0');
        const range = sel.getRangeAt(0);
        range.insertNode(space);
        range.insertNode(chip);
        range.setStartAfter(space);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
    closePopup();
    emit();
  }

  function chooseSlash(item: SlashItem) {
    if (!popup) return;
    removeTrigger(popup);
    closePopup();
    item.run();
    emit();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey;
    if (popup && itemCount > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((a) => (a + 1) % itemCount);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => (a - 1 + itemCount) % itemCount);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        if (popup.kind === 'slash') chooseSlash(slashMatches[active]);
        else chooseRef(refChoices[active]);
        return;
      }
    }
    if (popup && e.key === 'Escape') {
      e.preventDefault();
      closePopup();
      return;
    }
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      onSave?.();
    } else if (mod && e.key === 'Enter') {
      e.preventDefault();
      onPublish?.();
    } else if (mod && e.shiftKey && e.key.toLowerCase() === 'm') {
      e.preventDefault();
      onToggleMode?.();
    } else if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openLink();
    } else if (mod && e.shiftKey && e.key.toLowerCase() === 'x') {
      e.preventDefault();
      exec('strikeThrough');
    } else if (mod && e.key.toLowerCase() === 'e') {
      e.preventDefault();
      inlineCode();
    } else if (mod && e.altKey && ['2', '3', '4'].includes(e.key)) {
      e.preventDefault();
      exec('formatBlock', `h${e.key}`);
    } else if (mod && e.shiftKey && e.key === '8') {
      e.preventDefault();
      exec('insertUnorderedList');
    } else if (mod && e.shiftKey && e.key === '7') {
      e.preventDefault();
      exec('insertOrderedList');
    } else if (mod && e.shiftKey && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      exec('formatBlock', 'blockquote');
    }
  }

  // ── floating selection toolbar ──
  useEffect(() => {
    if (mode !== 'visual') return;
    function onSelectionChange() {
      const sel = window.getSelection();
      const surface = surfaceRef.current;
      if (!sel || !sel.rangeCount || !surface || !surface.contains(sel.anchorNode)) return setFloating(null);
      const inTable = !!(sel.anchorNode?.parentElement as HTMLElement | null)?.closest('td,th');
      if (sel.isCollapsed && !inTable) return setFloating(null);
      const r = sel.getRangeAt(0).getBoundingClientRect();
      const w = wrapRef.current!.getBoundingClientRect();
      if (!r.width && !r.height) return setFloating(null);
      setFloating({ top: r.top - w.top - 42, left: Math.max(8, r.left - w.left + r.width / 2 - 110), inTable });
    }
    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, [mode]);

  function tableAction(action: 'row' | 'col' | 'delete') {
    const sel = window.getSelection();
    const cell = (sel?.anchorNode?.parentElement as HTMLElement | null)?.closest('td,th') as HTMLTableCellElement | null;
    const table = cell?.closest('table');
    if (!cell || !table) return;
    if (action === 'delete') table.remove();
    else if (action === 'row') {
      const row = cell.parentElement as HTMLTableRowElement;
      const copy = row.cloneNode(true) as HTMLTableRowElement;
      copy.querySelectorAll('td,th').forEach((c) => {
        const td = document.createElement('td');
        td.innerHTML = '&nbsp;';
        c.replaceWith(td);
      });
      (row.parentElement?.tagName === 'THEAD' ? table.tBodies[0] : row.parentElement)?.insertBefore(
        copy,
        row.parentElement?.tagName === 'THEAD' ? table.tBodies[0].firstChild : row.nextSibling,
      );
    } else {
      const idx = cell.cellIndex;
      table.querySelectorAll('tr').forEach((tr) => {
        const isHead = tr.parentElement?.tagName === 'THEAD';
        const c = document.createElement(isHead ? 'th' : 'td');
        c.innerHTML = isHead ? 'Column' : '&nbsp;';
        tr.insertBefore(c, tr.children[idx + 1] ?? null);
      });
    }
    emit();
  }

  const tb = (label: string, title: string, run: () => void, extra?: string) => (
    <button
      type="button"
      className={`${styles.tbBtn} ${extra ?? ''}`}
      title={title}
      aria-label={title}
      onMouseDown={(e) => {
        e.preventDefault();
        run();
        emit();
      }}
    >
      {label}
    </button>
  );

  if (mode === 'markdown') {
    return (
      <div className={styles.wrap}>
        <textarea
          className={styles.source}
          value={markdown}
          spellCheck={false}
          aria-label="Markdown source"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            const mod = e.metaKey || e.ctrlKey;
            if (mod && e.key.toLowerCase() === 's') {
              e.preventDefault();
              onSave?.();
            } else if (mod && e.key === 'Enter') {
              e.preventDefault();
              onPublish?.();
            } else if (mod && e.shiftKey && e.key.toLowerCase() === 'm') {
              e.preventDefault();
              onToggleMode?.();
            }
          }}
        />
      </div>
    );
  }

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <div className={styles.toolbar} role="toolbar" aria-label="Formatting">
        {tb('B', 'Bold (Ctrl+B)', () => exec('bold'), styles.bold)}
        {tb('i', 'Italic (Ctrl+I)', () => exec('italic'), styles.italic)}
        {tb('S', 'Strikethrough (Ctrl+Shift+X)', () => exec('strikeThrough'), styles.strike)}
        {tb('</>', 'Inline code (Ctrl+E)', inlineCode, styles.mono)}
        <span className={styles.sep} />
        {tb('H2', 'Heading 2', cmds.h(2))}
        {tb('H3', 'Heading 3', cmds.h(3))}
        {tb('H4', 'Heading 4', cmds.h(4))}
        <span className={styles.sep} />
        {tb('•', 'Bulleted list', cmds.ul)}
        {tb('1.', 'Numbered list', cmds.ol)}
        {tb('☑', 'Task list', cmds.task)}
        {tb('❝', 'Quote', cmds.quote)}
        {tb('▦', 'Table', cmds.table)}
        {tb('{ }', 'Code block', cmds.code, styles.mono)}
        {tb('ⓘ', 'Callout', cmds.callout('info'))}
        <span className={styles.sep} />
        {tb('🔗', 'Link (Ctrl+K)', openLink)}
        {tb('[[', 'Link a page or ticket', insertRefTrigger, styles.mono)}
        {tb('🖼', 'Image', insertImage)}
        <span className={styles.spacer} />
        {tb('↶', 'Undo', () => exec('undo'))}
        {tb('↷', 'Redo', () => exec('redo'))}
        <span className={styles.hint}>
          Type <kbd>/</kbd> for blocks
        </span>
      </div>
      {linkOpen && (
        <form
          className={styles.linkPop}
          onSubmit={(e) => {
            e.preventDefault();
            applyLink();
          }}
        >
          <input
            autoFocus
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            placeholder="https://…"
            aria-label="Link URL"
            onKeyDown={(e) => e.key === 'Escape' && setLinkOpen(false)}
          />
          <button type="submit">Add link</button>
        </form>
      )}
      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}
      <div
        ref={surfaceRef}
        className={`${mdStyles.markdown} ${styles.surface}`}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label="Page content"
        data-testid="docs-editor-surface"
        spellCheck
        onInput={onInput}
        onKeyDown={onKeyDown}
        onClick={(e) => {
          if ((e.target as HTMLElement).tagName === 'INPUT') emit();
          detectTriggers();
        }}
        onBlur={() => {
          emit();
        }}
      />
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        hidden
        onChange={(e) => void onImagePicked(e)}
      />
      {floating && (
        <div className={styles.floating} style={{ top: floating.top, left: floating.left }} role="toolbar" aria-label="Selection">
          {floating.inTable ? (
            <>
              {tb('+ Row', 'Add row below', () => tableAction('row'))}
              {tb('+ Column', 'Add column to the right', () => tableAction('col'))}
              {tb('Delete table', 'Delete table', () => tableAction('delete'), styles.danger)}
            </>
          ) : (
            <>
              {tb('B', 'Bold', () => exec('bold'), styles.bold)}
              {tb('i', 'Italic', () => exec('italic'), styles.italic)}
              {tb('S', 'Strikethrough', () => exec('strikeThrough'), styles.strike)}
              {tb('</>', 'Inline code', inlineCode, styles.mono)}
              {tb('🔗', 'Link', openLink)}
              {tb('H2', 'Heading 2', cmds.h(2))}
              {tb('❝', 'Quote', cmds.quote)}
            </>
          )}
        </div>
      )}
      {popup?.kind === 'slash' && (
        <div className={styles.menu} style={{ top: popup.rect.top, left: popup.rect.left }} role="listbox" aria-label="Blocks">
          <div className={styles.menuHead}>Blocks{popup.query && <span> · “{popup.query}”</span>}</div>
          {slashMatches.length === 0 && <div className={styles.menuEmpty}>No matching block</div>}
          {slashMatches.map((item, i) => (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={i === active}
              className={`${styles.menuItem} ${i === active ? styles.menuActive : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                chooseSlash(item);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span>{item.label}</span>
              <span className={styles.menuHint}>{item.hint}</span>
            </button>
          ))}
        </div>
      )}
      {popup?.kind === 'ref' && (
        <div className={styles.menu} style={{ top: popup.rect.top, left: popup.rect.left }} role="listbox" aria-label="References">
          <div className={styles.menuHead}>
            {sectionPart !== undefined ? 'Sections' : 'Link a page or ticket'}
            <span className={styles.menuKeys}>↑↓ choose · Enter insert · Esc close</span>
          </div>
          {refChoices.length === 0 && (
            <div className={styles.menuEmpty}>
              {sectionPart !== undefined ? 'No matching section' : refQuery ? 'No matching page or ticket' : 'Start typing a page title or ticket key'}
            </div>
          )}
          {refChoices.map((c, i) => (
            <button
              key={`${c.type}-${c.label}`}
              type="button"
              role="option"
              aria-selected={i === active}
              className={`${styles.menuItem} ${i === active ? styles.menuActive : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                chooseRef(c);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span>{c.label}</span>
              <span className={styles.menuHint}>{c.sub}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
