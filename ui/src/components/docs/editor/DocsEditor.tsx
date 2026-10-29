import { DragHandle } from '@tiptap/extension-drag-handle-react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { client } from '../../../api/client';
import { docsKeys } from '../../../api/docs';
import { useProject } from '../../../api/projects';
import { resolveOrigin } from '../../../api/resolveOrigin';
import { uploadDescriptionImage, useTickets } from '../../../api/tickets';
import type { DocsPage, DocsTreeNode } from '../../../types/docs';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '../../Toast';
import { imagesIn, usePreview } from '../../preview/PreviewContext';
import { Icon } from '../Icon';
import '../docs.css';
import './editor.css';
import { BubbleToolbar } from './BubbleToolbar';
import { EditorEnvContext, RefResolver, type EditorEnv, type TicketLite } from './context';
import { EditorToc } from './EditorToc';
import { EditorToolbar } from './EditorToolbar';
import { buildExtensions } from './extensions';
import { anchorFromState, commentHighlightKey, type HighlightThread } from './extensions/CommentHighlights';
import { useCommentShortcut, type Pick } from '../comments/SelectionComment';
import { createSuggest } from './extensions/suggest';
import { useDiagramStarter } from '../../diagrams/useDiagramStarter';
import { DIAGRAM_LINE } from '../../diagrams/diagramRefs';
import { firstDiagramFile } from '../../diagrams/diagramFile';
import { DiagramDropZone, isDiagramDrag } from '../../diagrams/DiagramDropZone';
import { MarkdownPane } from './MarkdownPane';
import { MenuHost } from './menuHost';
import { RefSuggester, type RefPayload } from './RefSuggester';
import { SlashMenu } from './SlashMenu';
import type { SlashItem } from './slashItems';
import { TableControls } from './TableControls';
import { cleanEditorMarkdown } from '../../../utils/docsMarkdown';

export type EditorMode = 'visual' | 'markdown';

/** Inline comments shown in the editor: highlights, a Comment button on the selection and the shortcut. */
export interface EditorComments {
  threads: HighlightThread[];
  activeId: string | null;
  onSelect: (threadId: string) => void;
  /** Called with the current selection when Comment (button or Ctrl+Alt+M) is used. */
  onPick: (pick: Pick) => void;
}

export interface DocsEditorHandle {
  /** Push pending edits to onChange and return the current markdown. */
  flush: () => string;
  focus: () => void;
  /** The ProseMirror element (data-testid="docs-editor-surface"). */
  getRoot: () => HTMLElement | null;
  getEditor: () => Editor | null;
}

interface Props {
  projectId: string;
  markdown: string;
  mode: EditorMode;
  onChange: (markdown: string) => void;
  nodes: DocsTreeNode[];
  currentPageId: string;
  pageTitle: string;
  /** File name shown in the Markdown view (e.g. "api.md"). */
  filename: string;
  /** Title field etc., rendered at the top of the 640px column. */
  header?: ReactNode;
  /** Right rail: undefined = built-in "On this page", null = none, node = custom. */
  toc?: ReactNode | null;
  onOpenPage?: (pageId: string, anchor?: string | null) => void;
  onOpenTicket?: (ticketId: string) => void;
  onBlur?: () => void;
  /** Fires on the first real keystroke, paste or drop (lets the caller tell edits from load-time normalisation). */
  onUserInput?: () => void;
  readOnly?: boolean;
  comments?: EditorComments;
  /** Board AI: the toolbar "Ask AI" and the selection's Summarise / Rewrite / Ask AI… */
  ai?: { onAsk: () => void; onSelection: (action: 'summarise' | 'rewrite' | 'ask', text: string) => void };
}

const EMIT_MS = 180;
// stable props: a new object on every render makes the drag handle re-register its ProseMirror plugin,
// which tears down the "/" and "[[" suggestion views while they are open
const DRAG_POSITION = { placement: 'left-start', strategy: 'absolute' } as const;

/** Caption above each pane in the side-by-side Markdown view. */
const PANE_LABEL: React.CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 8,
  height: 32,
  fontSize: 12,
  color: '#5B6B60',
};

/**
 * Tiptap WYSIWYG editor that reads and writes Markdown.
 * @param props.projectId - Project used to resolve references.
 * @param props.markdown - Markdown to edit; external changes reload the editor.
 * @param props.mode - Visual (WYSIWYG) or Markdown source view.
 * @param props.onChange - Called with the Markdown after edits (debounced).
 * @param props.nodes - Page tree, used for `[[` suggestions.
 * @param props.currentPageId - Page being edited.
 * @param props.pageTitle - Title of the page being edited.
 * @param props.filename - File name shown in the Markdown view.
 * @param props.header - Rendered at the top of the content column (title field etc.).
 * @param props.toc - Right rail: undefined for the built-in "On this page", `null` for none, or a custom node.
 * @param props.onOpenPage - Called with page id and anchor when a page reference is opened.
 * @param props.onOpenTicket - Called with a ticket id when a ticket reference is opened.
 * @param props.onBlur - Called when the editor loses focus.
 * @param props.onUserInput - Called on the first real keystroke, paste or drop (tells edits from load-time normalisation).
 * @param props.readOnly - Disable editing.
 * @param props.comments - Inline comments: highlights, Comment button and shortcut.
 * @param props.ai - Board AI entry points (toolbar Ask AI, selection actions).
 * @param ref - Imperative handle: `flush`, `focus`, `getRoot`, `getEditor`.
 */
export const DocsEditor = forwardRef<DocsEditorHandle, Props>(function DocsEditor(
  {
    projectId,
    markdown,
    mode,
    onChange,
    nodes,
    currentPageId,
    pageTitle,
    filename,
    header,
    toc,
    onOpenPage,
    onOpenTicket,
    onBlur,
    onUserInput,
    readOnly,
    comments,
    ai,
  },
  ref,
) {
  const toast = useToast();
  const qc = useQueryClient();
  const project = useProject(projectId);
  const ticketsQ = useTickets(projectId);
  const tickets = useMemo<TicketLite[]>(
    () =>
      [...(ticketsQ.data ?? [])]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((t) => ({ id: t.id, title: t.title, status: t.status })),
    [ticketsQ.data],
  );
  const ticketPrefix = project.data?.prefix ?? tickets[0]?.id.split('-')[0] ?? 'KAN';

  const slashHost = useMemo(() => new MenuHost(), []);
  const refHost = useMemo(() => new MenuHost(), []);
  const keyHost = useMemo(() => new MenuHost(), []);
  const resolver = useMemo(() => new RefResolver(projectId), [projectId]);
  const hostRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [linkOpen, setLinkOpen] = useState(false);

  const lastMd = useRef(markdown);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const live = useRef<{
    onChange: Props['onChange'];
    tickets: TicketLite[];
    nodes: DocsTreeNode[];
    currentPageId: string;
    ticketPrefix: string;
    pageTitle: string;
    toast: ReturnType<typeof useToast>;
    onBlur: Props['onBlur'];
    onUserInput: Props['onUserInput'];
    onCommentSelect?: (id: string) => void;
  }>({ onChange, tickets, nodes, currentPageId, ticketPrefix, pageTitle, toast, onBlur, onUserInput });
  live.current = {
    onChange,
    tickets,
    nodes,
    currentPageId,
    ticketPrefix,
    pageTitle,
    toast,
    onBlur,
    onUserInput,
    onCommentSelect: comments?.onSelect,
  };
  const editorRef = useRef<Editor | null>(null);
  const pickImage = useCallback(() => fileRef.current?.click(), []);

  // draw.io: /diagram starts a drawing, a dropped .drawio/.svg file opens in the editor layer first
  const insertDiagram = useCallback((md: string) => {
    const parts = DIAGRAM_LINE.exec(md);
    if (!parts || !editorRef.current) return;
    editorRef.current
      .chain()
      .focus()
      .insertContent({ type: 'diagram', attrs: { id: parts[2], label: parts[1] } })
      .run();
  }, []);
  const diagramStarter = useDiagramStarter({
    projectId,
    saveTo: `Docs › ${pageTitle || 'Untitled'}`,
    itemKind: 'doc',
    itemId: currentPageId ?? undefined,
    onInsert: insertDiagram,
  });
  const starterRef = useRef(diagramStarter);
  starterRef.current = diagramStarter;
  const [diagramDrag, setDiagramDrag] = useState(false);
  const dragDepth = useRef(0);

  const uploadImage = useCallback(async (file: File, at?: number) => {
    const ed = editorRef.current;
    if (!ed) return;
    try {
      const res = await uploadDescriptionImage(file);
      const src = res.url.startsWith('/uploads/') ? `${resolveOrigin()}${res.url}` : res.url;
      const node = { type: 'image', attrs: { src, alt: file.name.replace(/\.[^.]+$/, '') } };
      const chain = ed.chain().focus();
      (at != null ? chain.insertContentAt(at, node) : chain.insertContent(node)).run();
    } catch {
      live.current.toast.error(
        'Could not upload the image',
        'Check the file type (png, jpeg, gif, webp) and size (max 5 MB).',
      );
    }
  }, []);

  const extensions = useMemo(() => {
    const slash = createSuggest({
      name: 'slashMenu',
      char: '/',
      host: slashHost,
      command: ({ editor, range, payload }) =>
        (payload as SlashItem).run(editor, range, {
          pickImage,
          newDiagram: () => starterRef.current.startNew(),
          importDiagram: () => starterRef.current.pickFile(),
          ticketPrefix: live.current.ticketPrefix,
          pageTitle: live.current.pageTitle,
        }),
    });
    const ref = createSuggest({
      name: 'refMenu',
      char: '[[',
      host: refHost,
      allowSpaces: true,
      allowedPrefixes: null,
      accept: (q) => q.length < 90 && !q.includes(']]') && !q.includes('\n'),
      command: ({ editor, range, payload }) => {
        const p = payload as RefPayload;
        const insert = (content: unknown) =>
          editor
            .chain()
            .focus()
            .insertContentAt(range, content as never)
            .run();
        if (p.kind === 'text') insert(p.text);
        else if (p.kind === 'ticket')
          insert([
            { type: 'ticketRef', attrs: { key: p.key } },
            { type: 'text', text: ' ' },
          ]);
        else if (p.kind === 'page')
          insert([
            { type: 'docRef', attrs: { page: p.page, section: p.section, label: p.label } },
            { type: 'text', text: ' ' },
          ]);
        else {
          void (async () => {
            const parent = live.current.nodes.find((n) => n.id === live.current.currentPageId)?.parentId ?? null;
            try {
              await client.post<DocsPage>(`/projects/${projectId}/docs/pages`, { title: p.title, parent_id: parent });
              void qc.invalidateQueries({ queryKey: ['docs'] });
              resolver.invalidate();
            } catch {
              live.current.toast.error('Could not create the page', p.title);
              return;
            }
            insert([
              { type: 'docRef', attrs: { page: p.title, section: null, label: p.label } },
              { type: 'text', text: ' ' },
            ]);
          })();
        }
      },
    });
    // a bare ticket key ("KAN-" or "KAN-1") offers the project's tickets, with no [[ needed
    const bareKey = createSuggest({
      name: 'ticketKeyMenu',
      char: '',
      host: keyHost,
      accept: (q) => live.current.tickets.some((t) => t.id.toLowerCase().startsWith(q.toLowerCase())),
      find: ({ $position }) => {
        const text = $position.nodeBefore?.isText ? ($position.nodeBefore.text ?? '') : '';
        const m = /(?:^|\s)([A-Za-z][A-Za-z0-9]{1,5}-\d*)$/.exec(text);
        if (!m) return null;
        const before = text.slice(0, m.index);
        if (before.lastIndexOf('[[') > before.lastIndexOf(']]')) return null; // inside a [[ reference
        return { range: { from: $position.pos - m[1].length, to: $position.pos }, query: m[1], text: m[1] };
      },
      command: ({ editor, range, payload }) => {
        const p = payload as RefPayload;
        editor
          .chain()
          .focus()
          .insertContentAt(
            range,
            p.kind === 'ticket'
              ? [
                  { type: 'ticketRef', attrs: { key: p.key } },
                  { type: 'text', text: ' ' },
                ]
              : p.kind === 'text'
                ? p.text
                : '',
          )
          .run();
      },
    });
    return [
      ...buildExtensions({
        isTicket: (key) => live.current.tickets.some((t) => t.id === key),
        onLink: () => setLinkOpen(true),
        onCommentSelect: (id) => live.current.onCommentSelect?.(id),
      }),
      slash,
      ref,
      bareKey,
    ];
  }, [slashHost, refHost, keyHost, pickImage, projectId, qc, resolver]);

  const emit = useCallback(() => {
    const ed = editorRef.current;
    if (!ed || ed.isDestroyed) return lastMd.current;
    const md = cleanEditorMarkdown(ed.getMarkdown());
    if (md !== lastMd.current) {
      lastMd.current = md;
      live.current.onChange(md);
    }
    return md;
  }, []);

  const preview = usePreview();
  const previewRef = useRef(preview);
  previewRef.current = preview;

  const editor = useEditor({
    extensions,
    content: markdown,
    contentType: 'markdown',
    editable: !readOnly,
    editorProps: {
      attributes: {
        class: 'dk-pm',
        'data-testid': 'docs-editor-surface',
        'aria-label': 'Page content',
        spellcheck: 'true',
      },
      handleDOMEvents: {
        beforeinput: () => {
          live.current.onUserInput?.();
          return false;
        },
        // Double-click an image to look at it in the viewer
        dblclick: (view, event) => {
          const target = event.target;
          if (!(target instanceof HTMLImageElement)) return false;
          const { items, index } = imagesIn(view.dom, target);
          previewRef.current.open(items, index);
          return true;
        },
      },
      // Space on a selected image opens the viewer too
      handleKeyDown: (view, event) => {
        if (event.key !== ' ' || event.ctrlKey || event.metaKey || event.altKey) return false;
        const sel = view.state.selection as { node?: { type: { name: string } }; from: number };
        if (sel.node?.type.name !== 'image') return false;
        const dom = view.nodeDOM(sel.from);
        const img =
          dom instanceof HTMLImageElement ? dom : dom instanceof HTMLElement ? dom.querySelector('img') : null;
        if (!img) return false;
        event.preventDefault();
        const { items, index } = imagesIn(view.dom, img);
        previewRef.current.open(items, index);
        return true;
      },
      handlePaste: (_view, event) => {
        live.current.onUserInput?.();
        const file = Array.from(event.clipboardData?.files ?? []).find((f) => f.type.startsWith('image/'));
        if (!file) return false;
        void uploadImage(file);
        return true;
      },
      handleDrop: (view, event) => {
        const diagramFile = firstDiagramFile((event as DragEvent).dataTransfer?.files);
        if (diagramFile) {
          event.preventDefault();
          void starterRef.current.startImport(diagramFile);
          return true;
        }
        const file = Array.from((event as DragEvent).dataTransfer?.files ?? []).find((f) =>
          f.type.startsWith('image/'),
        );
        if (!file) return false;
        const at = view.posAtCoords({ left: (event as DragEvent).clientX, top: (event as DragEvent).clientY })?.pos;
        void uploadImage(file, at);
        return true;
      },
    },
    onUpdate: () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(emit, EMIT_MS);
    },
    onBlur: () => {
      emit();
      live.current.onBlur?.();
    },
  });
  editorRef.current = editor;

  // outside changes (reload, offline re-sync, Markdown view edits) flow into the editor
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (markdown !== lastMd.current) {
      lastMd.current = markdown;
      editor.commands.setContent(markdown, { contentType: 'markdown', emitUpdate: false });
    }
  }, [markdown, editor]);

  // leaving the visual view pushes pending edits first
  useEffect(() => {
    if (mode === 'markdown') emit();
  }, [mode, emit]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.setEditable(!readOnly);
  }, [editor, readOnly]);

  useImperativeHandle(
    ref,
    () => ({
      flush: () => {
        if (timer.current) clearTimeout(timer.current);
        // beside the Markdown pane the visual pane can still hold edits that were not pushed yet
        const visualFocused = mode === 'markdown' && !!editorRef.current?.isFocused;
        return mode === 'visual' || visualFocused ? emit() : lastMd.current;
      },
      focus: () => editorRef.current?.commands.focus(),
      getRoot: () => (editorRef.current?.view.dom as HTMLElement | undefined) ?? null,
      getEditor: () => editorRef.current,
    }),
    [emit, mode],
  );

  const slashState = useSyncExternalStore(slashHost.subscribe, slashHost.getSnapshot);
  const refState = useSyncExternalStore(refHost.subscribe, refHost.getSnapshot);
  const keyState = useSyncExternalStore(keyHost.subscribe, keyHost.getSnapshot);

  const env = useMemo<EditorEnv>(
    () => ({ projectId, currentPageId, resolver, onOpenPage, onOpenTicket }),
    [projectId, currentPageId, resolver, onOpenPage, onOpenTicket],
  );

  // inline comment highlights follow the threads and the active one
  const commentThreads = comments?.threads;
  const commentActive = comments?.activeId ?? null;
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.view.dispatch(
      editor.state.tr.setMeta(commentHighlightKey, { threads: commentThreads ?? [], activeId: commentActive }),
    );
  }, [editor, commentThreads, commentActive]);

  const startComment = useCallback(() => {
    const ed = editorRef.current;
    if (!ed || ed.isDestroyed || !comments) return;
    const hit = anchorFromState(ed.state);
    if (!hit) {
      live.current.toast.error('Select text in one paragraph', 'A comment attaches to text inside a single block.');
      return;
    }
    const a = ed.view.coordsAtPos(hit.from);
    const b = ed.view.coordsAtPos(hit.to);
    comments.onPick({
      anchor: hit.anchor,
      rect: { left: Math.min(a.left, b.left), right: Math.max(a.right, b.right), top: a.top, bottom: b.bottom },
    });
  }, [comments]);
  useCommentShortcut(startComment, !!comments && !readOnly);

  // Ctrl/Cmd+K from anywhere in the editor opens the link field (or selects the word under the caret first)
  const openLink = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    if (ed.state.selection.empty) {
      const { $from } = ed.state.selection;
      const text = $from.parent.textContent;
      let s = $from.parentOffset;
      let e = s;
      while (s > 0 && /\S/.test(text[s - 1])) s -= 1;
      while (e < text.length && /\S/.test(text[e])) e += 1;
      if (s === e) return;
      ed.commands.setTextSelection({ from: $from.start() + s, to: $from.start() + e });
    }
    setLinkOpen(true);
  }, []);

  const dragNode = useRef<{ pos: number; size: number } | null>(null);
  const onDragNode = useCallback(({ node, pos }: { node: { nodeSize: number } | null; pos: number }) => {
    dragNode.current = node ? { pos, size: node.nodeSize } : null;
  }, []);

  return (
    <EditorEnvContext.Provider value={env}>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }} className="dk-editor-root">
        {
          <EditorToolbar
            editor={editor}
            disabled={readOnly}
            onLink={openLink}
            onPickImage={pickImage}
            ticketPrefix={ticketPrefix}
            onAskAi={ai?.onAsk}
          />
        }
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <div
            data-testid="editor-scroll"
            onDragEnter={(e) => {
              if (!readOnly && mode === 'visual' && isDiagramDrag(e.dataTransfer)) {
                dragDepth.current += 1;
                setDiagramDrag(true);
              }
            }}
            onDragLeave={() => {
              if (!diagramDrag) return;
              dragDepth.current = Math.max(0, dragDepth.current - 1);
              if (dragDepth.current === 0) setDiagramDrag(false);
            }}
            onDrop={() => {
              dragDepth.current = 0;
              setDiagramDrag(false);
            }}
            style={{
              flex: 1,
              minWidth: 0,
              overflowY: 'auto',
              padding: '30px 0 40px',
              position: 'relative',
              background: '#FFFFFF',
            }}
          >
            <div
              ref={hostRef}
              style={{
                width: mode === 'markdown' ? '100%' : 'clamp(640px, 62vw, 1120px)',
                maxWidth: mode === 'markdown' ? 'calc(100% - 48px)' : 'calc(100% - 48px)',
                margin: '0 auto',
                position: 'relative',
              }}
            >
              {header}
              {diagramDrag && (
                <DiagramDropZone
                  onFile={(f) => void starterRef.current.startImport(f)}
                  onChoose={() => starterRef.current.pickFile()}
                  onDone={() => {
                    dragDepth.current = 0;
                    setDiagramDrag(false);
                  }}
                />
              )}
              <div
                data-testid="editor-panes"
                style={mode === 'markdown' ? { display: 'flex', gap: 16, alignItems: 'flex-start' } : undefined}
              >
                <div style={mode === 'markdown' ? { flex: 1, minWidth: 0 } : undefined}>
                  {mode === 'markdown' && (
                    <div style={PANE_LABEL}>
                      <b style={{ color: '#1E2A22' }}>Visual</b> Rich text, what readers see
                    </div>
                  )}
                  <div className="dk-md dk-editor">
                    <EditorContent editor={editor} />
                    {editor && !readOnly && (
                      <>
                        <DragHandle editor={editor} computePositionConfig={DRAG_POSITION} onNodeChange={onDragNode}>
                          <div className="dk-handle">
                            <button
                              type="button"
                              title="Add block"
                              aria-label="Add block"
                              onClick={() => {
                                const n = dragNode.current;
                                if (!n) return;
                                editor
                                  .chain()
                                  .focus()
                                  .insertContentAt(n.pos + n.size, {
                                    type: 'paragraph',
                                    content: [{ type: 'text', text: '/' }],
                                  })
                                  .run();
                              }}
                            >
                              <Icon name="i01" size={15} strokeWidth={2} />
                            </button>
                            <button type="button" className="dk-grip" title="Drag to move" aria-label="Drag to move">
                              <Icon name="i03" size={15} strokeWidth={1.8} />
                            </button>
                          </div>
                        </DragHandle>
                        <TableControls editor={editor} hostRef={hostRef} />
                      </>
                    )}
                  </div>
                </div>
                {mode === 'markdown' && (
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={PANE_LABEL}>
                      <b style={{ color: '#1E2A22' }}>Markdown</b> Source. Editing either pane updates the other
                    </div>
                    <MarkdownPane value={markdown} filename={filename} onChange={onChange} readOnly={readOnly} />
                  </div>
                )}
              </div>
            </div>
          </div>
          {toc === null ? null : (
            <div
              style={{
                width: 200,
                flexShrink: 0,
                padding: '30px 20px 0 8px',
                boxSizing: 'border-box',
                background: '#FFFFFF',
              }}
            >
              {toc === undefined ? <EditorToc editor={editor} markdown={markdown} /> : toc}
            </div>
          )}
        </div>
        {editor && !readOnly && (
          <BubbleToolbar
            editor={editor}
            linkOpen={linkOpen}
            setLinkOpen={setLinkOpen}
            ticketPrefix={ticketPrefix}
            onComment={comments ? startComment : undefined}
            onAi={ai?.onSelection}
          />
        )}
        {slashState && (
          <SlashMenu
            host={slashHost}
            state={slashState}
            ctx={{
              pickImage,
              newDiagram: diagramStarter.startNew,
              importDiagram: diagramStarter.pickFile,
              ticketPrefix,
              pageTitle,
            }}
          />
        )}
        {refState && (
          <RefSuggester
            host={refHost}
            state={refState}
            nodes={nodes}
            tickets={tickets}
            currentPageId={currentPageId}
            onClose={() => undefined}
          />
        )}
        {keyState && mode === 'visual' && !refState && (
          <RefSuggester
            bare
            host={keyHost}
            state={keyState}
            nodes={nodes}
            tickets={tickets}
            currentPageId={currentPageId}
            onClose={() => undefined}
          />
        )}
        {diagramStarter.fileInput}
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          hidden
          aria-label="Upload image"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void uploadImage(f);
          }}
        />
      </div>
    </EditorEnvContext.Provider>
  );
});

export { docsKeys };
