import { useCallback, useEffect, useState, type ComponentProps } from 'react';
import { useDocsTree } from '../../api/docs';
import { DocsView } from './DocsView';
import { getActiveReplaceAdapter } from './editorReplace';
import { FindInPage, useDocsFindHotkey } from './FindInPage';
import { ImportDialog } from './ImportDialog';
import { RefCheatSheetHost } from './RefCheatSheet';
import { SearchPalette, rememberDocsPage, useDocsSearchHotkey } from './SearchPalette';
import { useCommentNotifications } from './comments/useCommentNotifications';
import { useDocsNotifications } from './useDocsNotifications';
import './docs.css';

interface Props {
  projectId: string;
  projectName: string;
  requestedPageId?: string | null;
  onRequestHandled?: () => void;
  onOpenTicket: (ticketId: string) => void;
  onOpenSettings?: () => void;
  onBack?: () => void;
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
 */
export function DocsSpace({
  projectId,
  projectName,
  requestedPageId,
  onRequestHandled,
  onOpenTicket,
  onOpenSettings,
  onBack,
}: Props) {
  const tree = useDocsTree(projectId);
  const nodes = tree.data ?? [];
  const [request, setRequest] = useState<{ id: string; anchor?: string } | null>(null);
  const [intent, setIntent] = useState<ComponentProps<typeof DocsView>['intent']>(null);
  const [palette, setPalette] = useState<{ q?: string; mode?: 'ask' } | null>(null);
  const [results, setResults] = useState<string | null>(null);
  const [importing, setImporting] = useState<{ files?: File[] } | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [root, setRoot] = useState<HTMLElement | null>(null);

  const open = useCallback((id: string, anchor?: string) => {
    setResults(null);
    setRequest({ id, anchor });
  }, []);
  useDocsNotifications({ projectId, onOpenPage: open });
  useCommentNotifications({ projectId, onOpenPage: open });
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

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', position: 'relative', overflow: 'hidden' }}>
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
        onImport={() => setImporting({})}
        onDropFiles={(files) => setImporting({ files })}
        onOpenSettings={onOpenSettings}
        onBack={onBack}
        onSearch={(q) => (q ? setResults(q) : setPalette({}))}
        onAskDocs={() => setPalette({ mode: 'ask' })}
        onBodyRef={setRoot}
        resultsQuery={results}
        onCloseResults={() => setResults(null)}
        intent={intent}
        onIntentHandled={() => setIntent(null)}
      />
      <RefCheatSheetHost />
      {findOpen && (
        <FindInPage
          root={root}
          editable={Boolean(root?.isContentEditable)}
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
