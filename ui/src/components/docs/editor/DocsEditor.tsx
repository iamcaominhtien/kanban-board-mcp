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
  type CSSProperties,
  type ReactNode,
} from 'react';
import { client } from '../../../api/client';
import { docsKeys } from '../../../api/docs';
import { useProject } from '../../../api/projects';
import { resolveOrigin } from '../../../api/resolveOrigin';
import { uploadAnyFile, uploadDescriptionImage, useTickets } from '../../../api/tickets';
import type { DocsPage, DocsTreeNode, RichDoc } from '../../../types/docs';
import { ensureBlockIds } from '../../../richdoc/ids';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '../../Toast';
import { filesIn, imagesIn, usePreview } from '../../preview/PreviewContext';
import { Icon } from '../Icon';
import '../docs.css';
import './editor.css';
import { BubbleToolbar } from './BubbleToolbar';
import { EditorEnvContext, RefResolver, type EditorEnv, type TicketLite } from './context';
import { EditorToc } from './EditorToc';
import { EditorToolbar, type ToolbarVariant } from './EditorToolbar';
import { buildExtensions } from './extensions';
import { commentHighlightKey, type HighlightThread } from './extensions/CommentHighlights';
import { useCommentShortcut, type Pick } from '../comments/SelectionComment';
import { editorCommentPick } from '../comments/editorAnchor';
import { tiptapAdapter } from '../../ai/editor/adapters';
import { NodeSelection } from '@tiptap/pm/state';
import { EditorAiSelectionBar, useEditorAi } from '../../ai/editor/useEditorAi';
import { createSuggest } from './extensions/suggest';
import { useDiagramStarter } from '../../diagrams/useDiagramStarter';
import { DIAGRAM_LINE } from '../../diagrams/diagramRefs';
import { SKETCH_LINE } from '../../sketch/sketchRefs';
import { useSketchStarter } from '../../sketch/useSketchStarter';
import { CANVAS_LINE } from '../../canvas/canvasRefs';
import { useCanvasStarter } from '../../canvas/useCanvasStarter';
import { firstDiagramFile } from '../../diagrams/diagramFile';
import { DiagramDropZone, isDiagramDrag } from '../../diagrams/DiagramDropZone';
import { MenuHost } from './menuHost';
import { RefSuggester, type RefPayload } from './RefSuggester';
import { SlashMenu } from './SlashMenu';
import type { AiSlashId, SlashItem } from './slashItems';
import { TableControls } from './TableControls';
// Rich Docs phase 4: block views, the block handle's menu, the Insert image flow
import { BlockKit } from './blocks/BlockKit';
import { BlockLayer } from './blocks/BlockLayer';
import { askBlockUi, blockKitOf } from './blocks/bus';
import { dropPlacement, startImageUpload } from './blocks/imageUpload';
import { startDocUpload } from './blocks/docUpload';
import { isVideoFile } from './blocks/InsertVideoDialog';
import { withBlockViews } from './blocks/nodeViews';
import type { Placement } from './blocks/commands';
import { cleanEditorMarkdown } from '../../../utils/docsMarkdown';
import { compactMarkdown } from './compactMarkdown';
import { markdownToPaste } from './pasteMarkdown';
import { openDocsFind } from '../FindInPage';
import { openInsertMenu } from './ribbon/format';
import { PainterBar } from './ribbon/PainterBar';
import { PasteChip } from './ribbon/PasteChip';
import { RichFormatting, richStorage } from './ribbon/RichFormatting';
import { ShortcutSheet } from './ribbon/ShortcutSheet';
import { StatusLine } from './ribbon/StatusLine';
import { useStore } from './ribbon/store';
import { AskTeamButton, useAskTeam } from '../suggestions/AskTeam';

/** Inline comments shown in the editor: highlights, a Comment button on the selection and the shortcut. */
export interface EditorComments {
  threads: HighlightThread[];
  activeId: string | null;
  onSelect: (threadId: string) => void;
  /** Called with the current selection when Comment (button or Ctrl+Alt+M) is used. */
  onPick: (pick: Pick) => void;
}

/** AI where you write (design/screens/ai-where-you-work.md, D): `/ai`, Ctrl+J, the selection bar and drafts over the text. */
export interface InlineAi {
  /** A Docs page or an idea page; the server decides what each offers. */
  surface: 'doc' | 'idea';
  /** The project the request is booked on. Undefined switches the helpers off (e.g. an idea with no project, yet). */
  projectId?: string;
}

export interface DocsEditorHandle {
  /** Push pending edits to onChange / onContentChange and return the current text as plain Markdown. */
  flush: () => string;
  /**
   * Push pending edits and return the current page JSON (block ids made valid): a rich page's `content`. In Markdown
   * mode, the editor's JSON of the Markdown.
   */
  flushContent: () => RichDoc;
  focus: () => void;
  /** The ProseMirror element (data-testid="docs-editor-surface"). */
  getRoot: () => HTMLElement | null;
  getEditor: () => Editor | null;
}

interface Props {
  projectId: string;
  /** Markdown mode (idea pages): the text to edit. Give either this or `content`. */
  markdown?: string;
  /** Markdown mode: called with the Markdown after edits (debounced). */
  onChange?: (markdown: string) => void;
  /** Rich mode (Docs pages): the page JSON to edit. */
  content?: RichDoc;
  /** Rich mode: called with the page JSON after edits (debounced), every block with a valid, unique `blockId`. */
  onContentChange?: (doc: RichDoc) => void;
  nodes: DocsTreeNode[];
  currentPageId: string;
  /** Idea pages save their drawings as the idea's; everything else is a Docs page. */
  sketchOwnerKind?: 'doc' | 'idea';
  pageTitle: string;
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
  ai?: {
    onAsk: () => void;
    onSelection: (action: 'summarise' | 'rewrite' | 'ask', text: string) => void;
    /** `/ai`: a row of the slash menu was picked. */
    onSlash?: (id: AiSlashId) => void;
    /** Docs AI is on for the project: `/ai` adds the Docs-only group. */
    docsAi?: boolean;
  };
  /** AI in the text itself: the /ai command, Ctrl+J, a selection bar and drafts you accept. */
  inlineAi?: InlineAi;
  /**
   * The page's look (Page settings): class names and CSS variables put on the scrolling page, which then sets the
   * column width (`--dp-col`), the page colours, fonts and palette. Without it the editor keeps its own look.
   */
  surface?: { className: string; style: CSSProperties };
  /** Where the formatting bar sits (EditorToolbar `variant`). */
  toolbarVariant?: ToolbarVariant;
  /** Hides the editor (it stays mounted, with its undo history), e.g. while the page is previewed. */
  hidden?: boolean;
}

const EMIT_MS = 180;

/** The picture types the image upload takes (server/uploads.py); every other file is attached as a link. */
const PICTURE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const isPicture = (file: File) => PICTURE_TYPES.has(file.type);
// stable props: a new object on every render makes the drag handle re-register its ProseMirror plugin,
// which tears down the "/" and "[[" suggestion views while they are open
const DRAG_POSITION = { placement: 'left-start', strategy: 'absolute' } as const;

/** The editor's text as stored plain Markdown (what docToMarkdown writes for its JSON). */
function markdownOf(ed: Editor): string {
  return compactMarkdown(cleanEditorMarkdown(ed.getMarkdown()));
}

/**
 * Tiptap WYSIWYG editor. A Docs page is edited as rich JSON (`content` / `onContentChange`, format 1); an idea page
 * as Markdown (`markdown` / `onChange`).
 * @param props.projectId - Project used to resolve references.
 * @param props.markdown - Markdown mode: the Markdown to edit; external changes reload the editor.
 * @param props.onChange - Markdown mode: called with the Markdown after edits (debounced).
 * @param props.content - Rich mode: the page JSON to edit; external changes reload the editor.
 * @param props.onContentChange - Rich mode: called with the page JSON after edits (debounced).
 * @param props.nodes - Page tree, used for `[[` suggestions.
 * @param props.currentPageId - Page being edited.
 * @param props.pageTitle - Title of the page being edited.
 * @param props.header - Rendered at the top of the content column (title field etc.).
 * @param props.toc - Right rail: undefined for the built-in "On this page", `null` for none, or a custom node.
 * @param props.onOpenPage - Called with page id and anchor when a page reference is opened.
 * @param props.onOpenTicket - Called with a ticket id when a ticket reference is opened.
 * @param props.onBlur - Called when the editor loses focus.
 * @param props.onUserInput - Called on the first real keystroke, paste or drop (tells edits from load-time normalisation).
 * @param props.readOnly - Disable editing.
 * @param props.comments - Inline comments: highlights, Comment button and shortcut.
 * @param props.ai - Board AI entry points (toolbar Ask AI, selection actions).
 * @param props.inlineAi - AI in the text: `/ai`, Ctrl+J, the selection bar and drafts (a Docs page or an idea page).
 * @param props.surface - The page's look (Page settings): class names and CSS variables of the scrolling page.
 * @param props.toolbarVariant - Where the formatting bar sits: top, a sideways strip, or the bottom of the screen.
 * @param props.hidden - Hide the editor while keeping it mounted.
 * @param ref - Imperative handle: `flush`, `flushContent`, `focus`, `getRoot`, `getEditor`.
 */
export const DocsEditor = forwardRef<DocsEditorHandle, Props>(function DocsEditor(
  {
    projectId,
    markdown,
    onChange,
    content,
    onContentChange,
    nodes,
    currentPageId,
    sketchOwnerKind = 'doc',
    pageTitle,
    header,
    toc,
    onOpenPage,
    onOpenTicket,
    onBlur,
    onUserInput,
    readOnly,
    comments,
    ai,
    inlineAi,
    surface,
    toolbarVariant,
    hidden,
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
  const attachRef = useRef<HTMLInputElement>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  // rich text editing (ribbon/): focus mode, the shortcut sheet, the ribbon peeking in focus mode
  const [focusMode, setFocusMode] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [ribbonPeek, setRibbonPeek] = useState(false);

  const aiSlash = useMemo(
    () => (ai?.onSlash ? { run: ai.onSlash, docs: !!ai.docsAi } : undefined),
    [ai?.onSlash, ai?.docsAi],
  );
  // rich mode is chosen once, when the editor is made
  const rich = useRef(content !== undefined).current;
  const lastMd = useRef(markdown ?? '');
  const lastDoc = useRef<RichDoc | undefined>(content);
  const lastJson = useRef(content !== undefined ? JSON.stringify(content) : '');
  // No edit since the text was loaded: the editor's own Markdown of it may still differ from the stored text (it
  // normalises spacing, tables, escapes), and that difference alone must not be saved as an edit (ideas IP-15)
  const pristine = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const live = useRef<{
    onChange: Props['onChange'];
    onContentChange: Props['onContentChange'];
    tickets: TicketLite[];
    nodes: DocsTreeNode[];
    currentPageId: string;
    ticketPrefix: string;
    pageTitle: string;
    toast: ReturnType<typeof useToast>;
    onBlur: Props['onBlur'];
    onUserInput: Props['onUserInput'];
    onCommentSelect?: (id: string) => void;
    ai?: { run: (id: AiSlashId) => void; docs: boolean };
    toggleFocus?: () => void;
    openShortcuts?: () => void;
  }>({ onChange, onContentChange, tickets, nodes, currentPageId, ticketPrefix, pageTitle, toast, onBlur, onUserInput });
  live.current = {
    onChange,
    onContentChange,
    tickets,
    nodes,
    currentPageId,
    ticketPrefix,
    pageTitle,
    toast,
    onBlur,
    onUserInput,
    onCommentSelect: comments?.onSelect,
    ai: aiSlash,
    toggleFocus: () => setFocusMode((v) => !v),
    openShortcuts: () => setShortcutsOpen(true),
  };
  const editorRef = useRef<Editor | null>(null);
  const pickImage = useCallback(() => fileRef.current?.click(), []);
  const pickFile = useCallback(() => attachRef.current?.click(), []);

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

  // Sketch: /draw opens the paint-style editor and puts the saved drawing on its own line
  const insertSketch = useCallback((md: string) => {
    const parts = SKETCH_LINE.exec(md);
    if (!parts || !editorRef.current) return;
    editorRef.current
      .chain()
      .focus()
      .insertContent({ type: 'sketch', attrs: { id: parts[2], label: parts[1] } })
      .run();
  }, []);
  const sketchStarter = useSketchStarter({
    ownerKind: sketchOwnerKind,
    ownerId: currentPageId ?? undefined,
    projectId,
    ownerLabel: pageTitle || 'Untitled',
    onInsert: insertSketch,
  });
  const sketchRef = useRef(sketchStarter);
  sketchRef.current = sketchStarter;

  // Canvas: /canvas opens the "New canvas" dialog, then the editor, and puts the canvas on its own line
  const insertCanvas = useCallback((md: string) => {
    const parts = CANVAS_LINE.exec(md);
    if (!parts || !editorRef.current) return;
    editorRef.current
      .chain()
      .focus()
      .insertContent({ type: 'canvas', attrs: { id: parts[2], label: parts[1], fragment: parts[3] ?? '' } })
      .run();
  }, []);
  const canvasStarter = useCanvasStarter({
    ownerKind: sketchOwnerKind,
    ownerId: currentPageId ?? undefined,
    projectId,
    ownerLabel: pageTitle || 'Untitled',
    onInsert: insertCanvas,
  });
  const canvasRef = useRef(canvasStarter);
  canvasRef.current = canvasStarter;
  const [diagramDrag, setDiagramDrag] = useState(false);
  const dragDepth = useRef(0);

  const uploadImage = useCallback(async (file: File, at?: number, placement?: Placement) => {
    const ed = editorRef.current;
    if (!ed) return;
    // Anything that is not a picture (an Excel sheet picked with "All files", a PDF) is attached as a file instead
    if (!isPicture(file)) {
      await uploadFileRef.current(file, at);
      return;
    }
    // Rich Docs phase 4: the picture goes in at once with its upload state (progress, Cancel, failed, too large)
    const kit = blockKitOf(ed);
    if (kit) {
      startImageUpload(ed, file, { at, placement, limitMb: kit.imageLimitMb });
      return;
    }
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

  // Any other file (Excel, Word, PDF, zip…). A rich page puts it in as a file card (or a video block) that uploads to
  // the project's Docs uploads with its progress and the server's refusals (Rich Docs phase 5); a Markdown page stores
  // it like a ticket attachment and inserts a link to it, which the page shows as a file card (DocsMarkdown) and opens
  // in the viewer on double-click.
  const uploadFile = useCallback(
    async (file: File, at?: number) => {
      const ed = editorRef.current;
      if (!ed) return;
      if (rich && blockKitOf(ed)?.projectId) {
        startDocUpload(ed, file, { kind: isVideoFile(file) ? 'video' : 'file', at });
        return;
      }
      try {
        const res = await uploadAnyFile(file);
        const nodes = [
          { type: 'text', text: res.name || file.name, marks: [{ type: 'link', attrs: { href: res.url } }] },
          { type: 'text', text: ' ' },
        ];
        const chain = ed.chain().focus();
        (at != null ? chain.insertContentAt(at, nodes) : chain.insertContent(nodes)).run();
      } catch {
        live.current.toast.error('Could not attach the file', 'Files up to 100 MB can be attached.');
      }
    },
    [rich],
  );
  const uploadFileRef = useRef(uploadFile);
  uploadFileRef.current = uploadFile;

  // AI in the text: /ai (a slash item), Ctrl+J, the selection bar. The hook is told how to read and write this editor.
  // IP-14: a picked sketch/image/diagram (a node selection) has no text: the AI selection bar never offers actions there
  const aiAdapter = useMemo(() => {
    const base = tiptapAdapter(() => editorRef.current);
    return {
      ...base,
      capture: (mode: Parameters<typeof base.capture>[0]) =>
        mode === 'selection' && editorRef.current?.state.selection instanceof NodeSelection ? null : base.capture(mode),
    };
  }, []);
  const aiSurface = inlineAi?.surface ?? 'doc';
  // a Docs page with an AI team: "Ask the team" takes the place of the AI items of the selection bar
  const teamAsk = useAskTeam();
  const askTeam = inlineAi && aiSurface === 'doc' && !readOnly ? teamAsk : null;
  const textAi = useEditorAi({
    surface: aiSurface,
    projectId: inlineAi?.projectId,
    docId: aiSurface === 'doc' ? currentPageId : undefined,
    ideaId: aiSurface === 'idea' ? currentPageId : undefined,
    adapter: aiAdapter,
    enabled: !!inlineAi?.projectId && !readOnly,
    insertDiagramLine: insertDiagram,
    diagramSaveTo: `${aiSurface === 'idea' ? 'Idea' : 'Docs'} › ${pageTitle || 'Untitled'}`,
  });
  const textAiRef = useRef(textAi);
  textAiRef.current = textAi;
  const openAi = useCallback(() => window.setTimeout(() => textAiRef.current.openMenu(), 0), []);

  const extensions = useMemo(() => {
    const slash = createSuggest({
      name: 'slashMenu',
      char: '/',
      host: slashHost,
      command: ({ editor, range, payload }) =>
        (payload as SlashItem).run(editor, range, {
          openAi: textAiRef.current.available ? openAi : undefined,
          ai: live.current.ai,
          pickImage,
          newDiagram: () => starterRef.current.startNew(),
          newSketch: () => void sketchRef.current.start(),
          newCanvas: () => void canvasRef.current.start(),
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
      ...withBlockViews(
        buildExtensions({
          isTicket: (key) => live.current.tickets.some((t) => t.id === key),
          onLink: () => setLinkOpen(true),
          onCommentSelect: (id) => live.current.onCommentSelect?.(id),
        }),
      ),
      BlockKit,
      slash,
      ref,
      bareKey,
      RichFormatting.configure({
        onFocusMode: () => live.current.toggleFocus?.(),
        onShortcuts: () => live.current.openShortcuts?.(),
      }),
    ];
  }, [slashHost, refHost, keyHost, pickImage, openAi, projectId, qc, resolver]);

  // push the edits since the last call to the caller (nothing while the text is as it was loaded)
  const emit = useCallback(() => {
    const ed = editorRef.current;
    if (!ed || ed.isDestroyed || pristine.current) return;
    if (rich) {
      const doc = ensureBlockIds(ed.getJSON());
      const json = JSON.stringify(doc);
      if (json !== lastJson.current) {
        lastJson.current = json;
        lastDoc.current = doc;
        live.current.onContentChange?.(doc);
      }
      return;
    }
    const md = markdownOf(ed);
    if (md !== lastMd.current) {
      lastMd.current = md;
      live.current.onChange?.(md);
    }
  }, [rich]);

  const preview = usePreview();
  const previewRef = useRef(preview);
  previewRef.current = preview;

  const editor = useEditor({
    extensions,
    ...(rich ? { content } : { content: markdown ?? '', contentType: 'markdown' as const }),
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
        // Double-click an image or a link to an uploaded file to look at it in the viewer
        dblclick: (view, event) => {
          const target = event.target;
          if (!(target instanceof HTMLElement)) return false;
          const file =
            target instanceof HTMLImageElement ? target : target.closest<HTMLElement>('a[href*="/uploads/"]');
          if (!file) return false;
          const { items, index } = filesIn(view.dom, file);
          previewRef.current.open(items, index);
          return true;
        },
      },
      handleKeyDown: (view, event) => {
        // Ctrl+J belongs to the editor's /ai menu while it has focus, not to the board-wide dock
        const textAiNow = textAiRef.current;
        if (textAiNow.available && textAiNow.onKeyDown(event)) {
          event.stopPropagation();
          return true;
        }
        // Space on a selected image opens the viewer
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
      handlePaste: (view, event) => {
        live.current.onUserInput?.();
        const files = Array.from(event.clipboardData?.files ?? []);
        const image = files.find(isPicture);
        if (image) {
          void uploadImage(image);
          return true;
        }
        if (files.length) {
          void (async () => {
            for (const f of files) await uploadFile(f);
          })();
          return true;
        }
        // a bare address pasted on an empty line: it goes in as a link, and a small menu asks whether it becomes a
        // card or a player (Rich Docs phase 5, "Embed from a link")
        const pastedText = (event.clipboardData?.getData('text/plain') ?? '').trim();
        const { $from: at, empty } = view.state.selection;
        if (
          rich &&
          editorRef.current &&
          blockKitOf(editorRef.current) &&
          empty &&
          /^https?:\/\/[^\s<>"]+$/i.test(pastedText) &&
          at.parent.type.name === 'paragraph' &&
          at.parent.content.size === 0 &&
          at.depth >= 1
        ) {
          const ed = editorRef.current;
          const pos = at.before();
          ed.chain()
            .insertContent({ type: 'text', text: pastedText, marks: [{ type: 'link', attrs: { href: pastedText } }] })
            .run();
          askBlockUi(ed, { type: 'pasteLink', pos, url: pastedText });
          return true;
        }
        // Markdown from a plain-text source becomes blocks (not "## Title" as text); never inside a code block
        const md = view.state.selection.$from.parent.type.spec.code
          ? null
          : markdownToPaste(
              event.clipboardData?.getData('text/plain') ?? '',
              event.clipboardData?.getData('text/html') ?? '',
            );
        if (md == null || !editorRef.current) return false;
        editorRef.current.commands.insertContent(md, { contentType: 'markdown' });
        return true;
      },
      handleDrop: (view, event) => {
        const diagramFile = firstDiagramFile((event as DragEvent).dataTransfer?.files);
        if (diagramFile) {
          event.preventDefault();
          void starterRef.current.startImport(diagramFile);
          return true;
        }
        const files = Array.from((event as DragEvent).dataTransfer?.files ?? []);
        if (!files.length) return false;
        event.preventDefault();
        const at = view.posAtCoords({ left: (event as DragEvent).clientX, top: (event as DragEvent).clientY })?.pos;
        // dropped beside the text: the picture floats on that side
        const place = dropPlacement((event as DragEvent).clientX, (view.dom as HTMLElement).getBoundingClientRect());
        void (async () => {
          // in reverse, so each one lands at the drop point ahead of the ones after it
          for (const f of [...files].reverse()) await (isPicture(f) ? uploadImage(f, at, place) : uploadFile(f, at));
        })();
        return true;
      },
    },
    onUpdate: ({ transaction }) => {
      // an update that changed nothing (no steps) is not an edit
      if (transaction.docChanged) pristine.current = false;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(emit, EMIT_MS);
    },
    onBlur: () => {
      emit();
      live.current.onBlur?.();
    },
  });
  editorRef.current = editor;

  // outside changes (reload, offline re-sync, an AI rewrite) flow into the editor
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (rich) {
      if (!content || content === lastDoc.current) return;
      const json = JSON.stringify(content);
      lastDoc.current = content;
      if (json === lastJson.current) return;
      lastJson.current = json;
      pristine.current = true;
      editor.commands.setContent(content, { emitUpdate: false });
      return;
    }
    if (markdown !== undefined && markdown !== lastMd.current) {
      lastMd.current = markdown;
      pristine.current = true;
      editor.commands.setContent(markdown, { contentType: 'markdown', emitUpdate: false });
    }
  }, [markdown, content, editor, rich]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.setEditable(!readOnly);
  }, [editor, readOnly]);

  // the editor says it has AI, so the board-wide Ctrl+J leaves the key to it
  const hasTextAi = textAi.available;
  // ED-2: one bar on a selection. The formatting bar shows first; its "AI" item swaps it for the AI selection bar,
  // which closes again when the selection changes or on Esc
  const [aiBarOpen, setAiBarOpen] = useState(false);
  useEffect(() => {
    if (!editor || !aiBarOpen) return undefined;
    // the AI bar places itself on selection events; give it one now that it is mounted
    editor.view.dom.dispatchEvent(new Event('select'));
    const close = () => setAiBarOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    editor.on('selectionUpdate', close);
    document.addEventListener('keydown', onKey, true);
    return () => {
      editor.off('selectionUpdate', close);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [editor, aiBarOpen]);
  useEffect(() => {
    const dom = editor && !editor.isDestroyed ? (editor.view.dom as HTMLElement) : null;
    if (!dom) return undefined;
    if (hasTextAi) dom.setAttribute('data-ai-editor', 'true');
    else dom.removeAttribute('data-ai-editor');
    return () => dom.removeAttribute('data-ai-editor');
  }, [editor, hasTextAi]);

  useImperativeHandle(
    ref,
    () => ({
      flush: () => {
        if (timer.current) clearTimeout(timer.current);
        emit();
        const ed = editorRef.current;
        if (!rich) return lastMd.current;
        return ed && !ed.isDestroyed ? markdownOf(ed) : '';
      },
      flushContent: () => {
        if (timer.current) clearTimeout(timer.current);
        emit();
        const ed = editorRef.current;
        if (rich && lastDoc.current) return lastDoc.current;
        return ed && !ed.isDestroyed ? ensureBlockIds(ed.getJSON()) : { type: 'doc', content: [] };
      },
      focus: () => editorRef.current?.commands.focus(),
      getRoot: () => (editorRef.current?.view.dom as HTMLElement | undefined) ?? null,
      getEditor: () => editorRef.current,
    }),
    [emit, rich],
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
    // the selected text with its block, or a whole image, table or embed
    const pick = editorCommentPick(ed);
    if (!pick) {
      live.current.toast.error('Select text in one paragraph', 'A comment attaches to text inside a single block.');
      return;
    }
    comments.onPick(pick);
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

  // focus mode: Esc leaves; the line being typed stays near the middle of the screen
  useEffect(() => {
    if (!focusMode || !editor) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !slashHost.getSnapshot()) setFocusMode(false);
    };
    const center = () => {
      const scroller = editor.view.dom.closest('[data-testid="editor-scroll"]');
      if (!scroller || !editor.isFocused) return;
      try {
        const c = editor.view.coordsAtPos(editor.state.selection.head);
        const box = scroller.getBoundingClientRect();
        scroller.scrollTop += c.top - (box.top + box.height / 2);
      } catch {
        /* no layout */
      }
    };
    window.addEventListener('keydown', onKey);
    editor.on('update', center);
    return () => {
      window.removeEventListener('keydown', onKey);
      editor.off('update', center);
    };
  }, [focusMode, editor, slashHost]);
  // ? outside the text opens the shortcut sheet
  useEffect(() => {
    if (readOnly) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (document.querySelector('[role="dialog"]')) return;
      e.preventDefault();
      setShortcutsOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [readOnly]);
  const painting = useStore(richStorage(editor)?.painter, { format: null, mode: 'off' as const }).mode !== 'off';
  const pageHex = (surface?.style as Record<string, string> | undefined)?.['--dp-page'] ?? '#FFFFFF';
  const phoneBar = toolbarVariant === 'bottom';

  const dragNode = useRef<{ pos: number; size: number } | null>(null);
  const onDragNode = useCallback(({ node, pos }: { node: { nodeSize: number } | null; pos: number }) => {
    dragNode.current = node ? { pos, size: node.nodeSize } : null;
  }, []);

  return (
    <EditorEnvContext.Provider value={env}>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: hidden ? 'none' : 'flex',
          flexDirection: 'column',
          position: 'relative',
          ...(focusMode ? surface?.style : null),
        }}
        className={`dk-editor-root${focusMode ? ' dk-focus-mode' : ''}${painting ? ' dk-painting' : ''}`}
        data-focus-mode={focusMode || undefined}
      >
        {focusMode && !phoneBar && <div className="dk-focus-edge" onMouseEnter={() => setRibbonPeek(true)} />}
        {(!focusMode || ribbonPeek || phoneBar) && (
          <div
            className={focusMode && !phoneBar ? 'dk-focus-ribbon' : undefined}
            onMouseLeave={focusMode ? () => setRibbonPeek(false) : undefined}
            style={focusMode && phoneBar ? { display: 'none' } : undefined}
          >
            <EditorToolbar
              variant={toolbarVariant}
              editor={editor}
              disabled={readOnly}
              onLink={openLink}
              onPickImage={pickImage}
              onPickFile={pickFile}
              onSketch={sketchStarter.available ? () => void sketchStarter.start() : undefined}
              onCanvas={canvasStarter.available ? () => void canvasStarter.start() : undefined}
              ticketPrefix={ticketPrefix}
              onAskAi={ai?.onAsk}
              onInsert={() => editor && openInsertMenu(editor)}
              onFind={rich ? openDocsFind : undefined}
              onFocusMode={() => setFocusMode((v) => !v)}
              onShortcuts={() => setShortcutsOpen(true)}
              pageHex={pageHex}
              markdownOnly={!rich}
            />
          </div>
        )}
        {focusMode && (
          <button
            type="button"
            className="dk-focus-pill"
            data-testid="leave-focus"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setFocusMode(false)}
          >
            Leave Focus mode <span className="dk-kbd">Esc</span>
          </button>
        )}
        {!readOnly && <PainterBar editor={editor} touch={phoneBar} />}
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <div
            data-testid="editor-scroll"
            onDragEnter={(e) => {
              if (!readOnly && isDiagramDrag(e.dataTransfer)) {
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
            className={surface?.className}
            style={{
              flex: 1,
              minWidth: 0,
              overflowY: 'auto',
              padding: toolbarVariant === 'bottom' ? '20px 0 96px' : '30px 0 40px',
              position: 'relative',
              background: surface ? 'var(--dp-page)' : '#FFFFFF',
              ...surface?.style,
            }}
          >
            <div
              ref={hostRef}
              style={{
                width: surface ? 'var(--dp-col)' : 'clamp(640px, 62vw, 1120px)',
                maxWidth: surface ? 'calc(100% - var(--dp-gutter, 48px))' : 'calc(100% - 48px)',
                margin: '0 auto',
                position: 'relative',
              }}
              className={surface ? 'dk-doc-col-edit' : undefined}
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
              <div data-testid="editor-panes">
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
                          <button
                            type="button"
                            className="dk-grip"
                            title="Drag to move. Click for the menu."
                            aria-label="Drag to move"
                            onClick={(e) => {
                              const n = dragNode.current;
                              if (!n) return;
                              askBlockUi(
                                editor,
                                e.shiftKey
                                  ? { type: 'chooseBlock', pos: n.pos }
                                  : { type: 'blockMenu', pos: n.pos, anchor: e.currentTarget.getBoundingClientRect() },
                              );
                            }}
                          >
                            <Icon name="i03" size={15} strokeWidth={1.8} />
                          </button>
                        </div>
                      </DragHandle>
                      <TableControls editor={editor} hostRef={hostRef} />
                      <BlockLayer
                        editor={editor}
                        hostRef={hostRef}
                        projectId={projectId}
                        onComment={comments ? startComment : undefined}
                      />
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
          {toc === null || focusMode ? null : (
            <div
              style={{
                width: 200,
                flexShrink: 0,
                padding: '30px 20px 0 8px',
                boxSizing: 'border-box',
                background: surface ? (surface.style as Record<string, string>)['--dp-page'] : '#FFFFFF',
              }}
            >
              {toc === undefined ? <EditorToc editor={editor} markdown={markdown ?? ''} /> : toc}
            </div>
          )}
        </div>
        {editor && !readOnly && !aiBarOpen && (
          <BubbleToolbar
            editor={editor}
            linkOpen={linkOpen}
            setLinkOpen={setLinkOpen}
            ticketPrefix={ticketPrefix}
            onComment={comments ? startComment : undefined}
            // the selection bar of the AI layer (Improve, Shorten, Fix spelling, Explain, Ask…) replaces these three;
            // it opens from the bar's "AI" item, so one bar shows at a time
            onAi={hasTextAi || askTeam ? undefined : ai?.onSelection}
            onAiBar={inlineAi && hasTextAi && !askTeam ? () => setAiBarOpen(true) : undefined}
            askTeam={
              askTeam ? (
                <AskTeamButton
                  className="dk-bubble-ask"
                  capture={() => {
                    const ed = editorRef.current;
                    if (!ed) return null;
                    const { from, to, $from } = ed.state.selection;
                    const top = $from.depth >= 1 ? $from.node(1) : null;
                    const explain = textAi.available && textAi.bar.some((b) => b.action === 'explain');
                    return {
                      quote: ed.state.doc.textBetween(from, to, '\n'),
                      blockId: typeof top?.attrs.blockId === 'string' ? top.attrs.blockId : null,
                      explain: explain ? () => textAi.run('explain') : undefined,
                    };
                  }}
                />
              ) : undefined
            }
            pageHex={pageHex}
            plain={!rich}
          />
        )}
        {editor && !readOnly && !phoneBar && (
          <StatusLine
            editor={editor}
            quiet={focusMode}
            onFocusMode={() => setFocusMode((v) => !v)}
            onShortcuts={() => setShortcutsOpen(true)}
          />
        )}
        {!readOnly && <PasteChip editor={editor} sheet={phoneBar} />}
        {shortcutsOpen && <ShortcutSheet sheet={phoneBar} onClose={() => setShortcutsOpen(false)} />}
        {inlineAi && (
          <>
            {textAi.layer}
            {aiBarOpen && <EditorAiSelectionBar ai={textAi} adapter={aiAdapter} />}
          </>
        )}
        {slashState && (
          <SlashMenu
            host={slashHost}
            state={slashState}
            ctx={{
              openAi: hasTextAi ? openAi : undefined,
              ai: aiSlash,
              pickImage,
              pickFile,
              newDiagram: diagramStarter.startNew,
              newSketch: () => void sketchStarter.start(),
              newCanvas: () => void canvasStarter.start(),
              importDiagram: diagramStarter.pickFile,
              ticketPrefix,
              pageTitle,
              rich,
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
        {keyState && !refState && (
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
        <input
          ref={attachRef}
          type="file"
          multiple
          hidden
          aria-label="Attach a file"
          data-testid="docs-attach-input"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            void (async () => {
              for (const f of files) await uploadFile(f);
            })();
          }}
        />
      </div>
    </EditorEnvContext.Provider>
  );
});

export { docsKeys };
