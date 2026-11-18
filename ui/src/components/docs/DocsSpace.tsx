import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
} from 'react';
import { useDocsTree } from '../../api/docs';
import { DocsView } from './DocsView';
import { getActiveReplaceAdapter } from './editorReplace';
import { FindInPage, useDocsFindHotkey } from './FindInPage';
import { ImportDialog } from './ImportDialog';
import type { ImportSource } from './start/importConvert';
import { RefCheatSheetHost } from './RefCheatSheet';
import { SearchPalette, rememberDocsPage, useDocsSearchHotkey } from './SearchPalette';
import { DOCS_PHONE_BELOW, useNarrowWindow, type DocsLayout } from '../../hooks/useDocsLayout';
import './docs.css';

interface Props {
  projectId: string;
  projectName: string;
  requestedPageId?: string | null;
  onRequestHandled?: () => void;
  onOpenTicket: (ticketId: string) => void;
  onOpenSettings?: () => void;
  onBack?: () => void;
  /** Move Docs into a window of its own, on this page (#268). */
  onPopOut?: (pageId: string | null) => void;
  /** Opens the project sidebar where the app hides it (tablet and phone widths). */
  onOpenSidebar?: () => void;
  /** Called with true while the app bar should hide (editing on a tablet or a phone), false after. */
  onImmersiveChange?: (on: boolean) => void;
}

/**
 * The whole Docs space: DocsView plus the search palette and results, find-in-page, import and notifications.
 * @param props.projectId - Project whose docs are shown.
 * @param props.projectName - Space name used in headers.
 * @param props.requestedPageId - Page to open once, e.g. from a linked doc or `?docs=` link.
 * @param props.onRequestHandled - Called after `requestedPageId` has been opened.
 * @param props.onOpenTicket - Called with a ticket id when a ticket reference is opened.
 * @param props.onOpenSettings - Called to open project settings when Docs is disabled.
 * @param props.onBack - Called to leave the Docs space.
 * @param props.onPopOut - Called with the open page to move Docs into a window of its own.
 * @param props.onOpenSidebar - Opens the project sidebar the app hides on narrow screens.
 * @param props.onImmersiveChange - Called with true while the app bar should hide (editing on touch layouts).
 */
export function DocsSpace({
  projectId,
  projectName,
  requestedPageId,
  onRequestHandled,
  onOpenTicket,
  onOpenSettings,
  onBack,
  onPopOut,
  onOpenSidebar,
  onImmersiveChange,
}: Props) {
  const tree = useDocsTree(projectId);
  const nodes = tree.data ?? [];
  const [request, setRequest] = useState<{ id: string; anchor?: string } | null>(null);
  const [intent, setIntent] = useState<ComponentProps<typeof DocsView>['intent']>(null);
  const [palette, setPalette] = useState<{ q?: string; mode?: 'ask' } | null>(null);
  const [results, setResults] = useState<string | null>(null);
  const [importing, setImporting] = useState<{ files?: File[]; source?: ImportSource; text?: string } | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const [layout, setLayout] = useState<DocsLayout>('desktop');

  // a root whose page or editor was closed is no longer in the document
  const liveRoot = root?.isConnected ? root : null;

  const open = useCallback((id: string, anchor?: string) => {
    setResults(null);
    setRequest({ id, anchor });
  }, []);
  useDocsSearchHotkey(() => setPalette({}));
  useDocsFindHotkey(() => setFindOpen(true), findOpen);

  // remember what was opened for the palette's "recently viewed"
  const [current, setCurrent] = useState<string | null>(() => localStorage.getItem(`docsPage:${projectId}`));
  useEffect(() => {
    const t = setInterval(() => setCurrent(localStorage.getItem(`docsPage:${projectId}`)), 800);
    return () => clearInterval(t);
  }, [projectId]);
  useEffect(() => {
    const n = nodes.find((x) => x.id === current);
    if (n) rememberDocsPage(projectId, n.id, n.title);
  }, [current, nodes, projectId]);

  // A phone has Docs edge to edge (Shell A 3, D 12-13): the app's view leaves a side and bottom margin around every
  // tab; the Docs area cancels it with negative margins of the same size (read from the parent, so it follows the app)
  const [bleed, setBleed] = useState<CSSProperties | undefined>(undefined);
  const spaceRef = useRef<HTMLDivElement>(null);
  // only when the window itself is a phone's: then the wider area is still a phone's, and the layout cannot flip
  const phoneWindow = useNarrowWindow(DOCS_PHONE_BELOW);
  useLayoutEffect(() => {
    const parent = spaceRef.current?.parentElement;
    if (layout !== 'phone' || !phoneWindow || !parent) {
      setBleed(undefined);
      return;
    }
    const cs = getComputedStyle(parent);
    const px = (v: string) => parseFloat(v) || 0;
    setBleed({
      marginLeft: -px(cs.paddingLeft),
      marginRight: -px(cs.paddingRight),
      marginBottom: -px(cs.paddingBottom),
    });
  }, [layout, phoneWindow]);

  return (
    <div
      ref={spaceRef}
      style={{ flex: 1, minHeight: 0, display: 'flex', position: 'relative', overflow: 'hidden', ...bleed }}
    >
      <DocsView
        projectId={projectId}
        projectName={projectName}
        requestedPageId={request?.id ?? requestedPageId}
        requestedAnchor={request?.anchor}
        onRequestHandled={() => {
          setRequest(null);
          onRequestHandled?.();
        }}
        onOpenTicket={onOpenTicket}
        onImport={(source) => {
          // Paste starts with what is on the clipboard, when the browser lets the page read it
          if (source === 'paste' && navigator.clipboard?.readText)
            navigator.clipboard.readText().then(
              (text) => setImporting({ source, text }),
              () => setImporting({ source }),
            );
          else setImporting({ source });
        }}
        onDropFiles={(files) => setImporting({ files })}
        onOpenSettings={onOpenSettings}
        onBack={onBack}
        onPopOut={onPopOut}
        onSearch={(q) => (q ? setResults(q) : setPalette({}))}
        onAskDocs={() => setPalette({ mode: 'ask' })}
        onBodyRef={setRoot}
        resultsQuery={results}
        onCloseResults={() => setResults(null)}
        intent={intent}
        onIntentHandled={() => setIntent(null)}
        onOpenSidebar={onOpenSidebar}
        onImmersiveChange={onImmersiveChange}
        onLayoutChange={setLayout}
      />
      <RefCheatSheetHost />
      {findOpen && (
        <FindInPage
          root={liveRoot}
          editable={Boolean(liveRoot?.isContentEditable)}
          replaceAdapter={getActiveReplaceAdapter()}
          onClose={() => setFindOpen(false)}
        />
      )}
      {palette && (
        <SearchPalette
          projectId={projectId}
          projectName={projectName}
          pageId={current ?? undefined}
          initialQuery={palette.q}
          mode={palette.mode}
          fullScreen={layout === 'phone'}
          onClose={() => setPalette(null)}
          onOpenPage={(id, anchor) => {
            setPalette(null);
            open(id, anchor);
          }}
          onOpenTicket={(id) => {
            setPalette(null);
            onOpenTicket(id);
          }}
          onOpenResults={(q) => {
            setPalette(null);
            setResults(q);
          }}
          onCreatePage={(title) => {
            setPalette(null);
            setIntent({ kind: 'create-page', title });
          }}
          onFilterTree={(q) => {
            setPalette(null);
            setIntent({ kind: 'filter-tree', q });
          }}
          onWritePage={(question) => {
            setPalette(null);
            setIntent({ kind: 'write-page', question });
          }}
        />
      )}
      {importing && (
        <ImportDialog
          projectId={projectId}
          projectName={projectName}
          nodes={nodes}
          initialFiles={importing.files}
          initialSource={importing.source}
          initialText={importing.text}
          phone={layout === 'phone'}
          onClose={() => setImporting(null)}
          onDone={(created) => {
            if (created.length) {
              void tree.refetch();
              open(created[0]);
            }
          }}
          onReviewLinks={(id) => open(id)}
        />
      )}
    </div>
  );
}
