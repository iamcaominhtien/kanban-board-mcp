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
import { Icon } from '../Icon';
import '../docs.css';
import './editor.css';
import { BubbleToolbar } from './BubbleToolbar';
import { EditorEnvContext, RefResolver, type EditorEnv, type TicketLite } from './context';
import { EditorToc } from './EditorToc';
import { EditorToolbar } from './EditorToolbar';
import { buildExtensions } from './extensions';
import { createSuggest } from './extensions/suggest';
import { MarkdownPane } from './MarkdownPane';
import { MenuHost } from './menuHost';
import { RefSuggester, type RefPayload } from './RefSuggester';
import { SlashMenu } from './SlashMenu';
import type { SlashItem } from './slashItems';
import { TableControls } from './TableControls';

export type EditorMode = 'visual' | 'markdown';

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
}

const EMIT_MS = 180;
// stable props: a new object on every render makes the drag handle re-register its ProseMirror plugin,
// which tears down the "/" and "[[" suggestion views while they are open
const DRAG_POSITION = { placement: 'left-start', strategy: 'absolute' } as const;

export const DocsEditor = forwardRef<DocsEditorHandle, Props>(function DocsEditor(
  { projectId, markdown, mode, onChange, nodes, currentPageId, pageTitle, filename, header, toc, onOpenPage, onOpenTicket, onBlur, onUserInput, readOnly },
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
  const resolver = useMemo(() => new RefResolver(projectId), [projectId]);
  const hostRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [linkOpen, setLinkOpen] = useState(false);

  const lastMd = useRef(markdown);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const live = useRef({ onChange, tickets, nodes, currentPageId, ticketPrefix, pageTitle, toast, onBlur, onUserInput });
  live.current = { onChange, tickets, nodes, currentPageId, ticketPrefix, pageTitle, toast, onBlur, onUserInput };
  const editorRef = useRef<Editor | null>(null);
  const pickImage = useCallback(() => fileRef.current?.click(), []);

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
      live.current.toast.error('Could not upload the image', 'Check the file type (png, jpeg, gif, webp) and size (max 5 MB).');
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
        const insert = (content: unknown) => editor.chain().focus().insertContentAt(range, content as never).run();
        if (p.kind === 'text') insert(p.text);
        else if (p.kind === 'ticket') insert([{ type: 'ticketRef', attrs: { key: p.key } }, { type: 'text', text: ' ' }]);
        else if (p.kind === 'page')
          insert([{ type: 'docRef', attrs: { page: p.page, section: p.section, label: p.label } }, { type: 'text', text: ' ' }]);
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
            insert([{ type: 'docRef', attrs: { page: p.title, section: null, label: p.label } }, { type: 'text', text: ' ' }]);
          })();
        }
      },
    });
    return [
      ...buildExtensions({
        isTicket: (key) => live.current.tickets.some((t) => t.id === key),
        onLink: () => setLinkOpen(true),
      }),
      slash,
      ref,
    ];
  }, [slashHost, refHost, pickImage, projectId, qc, resolver]);

  const emit = useCallback(() => {
    const ed = editorRef.current;
    if (!ed || ed.isDestroyed) return lastMd.current;
    const md = ed.getMarkdown();
    if (md !== lastMd.current) {
      lastMd.current = md;
      live.current.onChange(md);
    }
    return md;
  }, []);

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
      },
      handlePaste: (_view, event) => {
        live.current.onUserInput?.();
        const file = Array.from(event.clipboardData?.files ?? []).find((f) => f.type.startsWith('image/'));
        if (!file) return false;
        void uploadImage(file);
        return true;
      },
      handleDrop: (view, event) => {
        const file = Array.from((event as DragEvent).dataTransfer?.files ?? []).find((f) => f.type.startsWith('image/'));
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
        return mode === 'visual' ? emit() : lastMd.current;
      },
      focus: () => editorRef.current?.commands.focus(),
      getRoot: () => (editorRef.current?.view.dom as HTMLElement | undefined) ?? null,
      getEditor: () => editorRef.current,
    }),
    [emit, mode],
  );

  const slashState = useSyncExternalStore(slashHost.subscribe, slashHost.getSnapshot);
  const refState = useSyncExternalStore(refHost.subscribe, refHost.getSnapshot);

  const env = useMemo<EditorEnv>(
    () => ({ projectId, currentPageId, resolver, onOpenPage, onOpenTicket }),
    [projectId, currentPageId, resolver, onOpenPage, onOpenTicket],
  );

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
        {mode === 'visual' && (
          <EditorToolbar editor={editor} disabled={readOnly} onLink={openLink} onPickImage={pickImage} ticketPrefix={ticketPrefix} />
        )}
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <div
            data-testid="editor-scroll"
            style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: '30px 0 40px', position: 'relative', background: '#FFFFFF' }}
          >
            <div ref={hostRef} style={{ width: 640, maxWidth: 'calc(100% - 48px)', margin: '0 auto', position: 'relative' }}>
              {header}
              <div style={{ display: mode === 'visual' ? 'block' : 'none' }}>
                <div className="dk-md dk-editor">
                  <EditorContent editor={editor} />
                  {editor && mode === 'visual' && !readOnly && (
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
                                .insertContentAt(n.pos + n.size, { type: 'paragraph', content: [{ type: 'text', text: '/' }] })
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
                <MarkdownPane value={markdown} filename={filename} onChange={onChange} readOnly={readOnly} />
              )}
            </div>
          </div>
          {toc === null ? null : (
            <div style={{ width: 200, flexShrink: 0, padding: '30px 20px 0 8px', boxSizing: 'border-box', background: '#FFFFFF' }}>
              {toc === undefined ? <EditorToc editor={editor} markdown={markdown} /> : toc}
            </div>
          )}
        </div>
        {editor && mode === 'visual' && !readOnly && (
          <BubbleToolbar editor={editor} linkOpen={linkOpen} setLinkOpen={setLinkOpen} ticketPrefix={ticketPrefix} />
        )}
        {slashState && mode === 'visual' && (
          <SlashMenu
            host={slashHost}
            state={slashState}
            ctx={{ pickImage, ticketPrefix, pageTitle }}
          />
        )}
        {refState && mode === 'visual' && (
          <RefSuggester
            host={refHost}
            state={refState}
            nodes={nodes}
            tickets={tickets}
            currentPageId={currentPageId}
            onClose={() => undefined}
          />
        )}
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
