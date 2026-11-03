import { useEffect, useState } from 'react';
import { useProject } from '../../api/projects';
import { useBackendStatus } from '../../hooks/useBackendStatus';
import { useSSEInvalidation } from '../../hooks/useSSEInvalidation';
import { useTheme } from '../../hooks/useTheme';
import { Splash } from '../Splash';
import { DocsSpace } from './DocsSpace';
import { DockIcon } from './DocsWindowIcons';
import { useDocsWindowGuest } from './useDocsWindow';

/**
 * The app in a Docs window of its own (`?docsWindow=1`): only the Docs space of one project, under a thin bar with the
 * project's name and "Dock back", which closes this window and opens Docs in the board on the same page.
 */
export function DocsWindowApp() {
  useSSEInvalidation();
  useTheme();
  const { status, errorMessage, retry } = useBackendStatus();
  const [params] = useState(() => new URLSearchParams(window.location.search));
  const projectId = params.get('proj') ?? '';
  const [request, setRequest] = useState<string | null>(() => params.get('docs') || null);
  const project = useProject(projectId).data;
  const name = project?.name ?? '';
  const { dock, openTicket } = useDocsWindowGuest(projectId, setRequest);

  useEffect(() => {
    document.title = name ? `Docs · ${name}` : 'Docs';
  }, [name]);

  useEffect(() => {
    // Ctrl/Cmd+Shift+D docks back, as the button does
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        dock();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dock]);

  // the Splash component takes the page's own boot splash away once the backend is ready, as in the board
  const splash = <Splash status={status} errorMessage={errorMessage} onRetryBackend={retry} />;
  if (status !== 'ready') return splash;
  if (!projectId) {
    return (
      <div role="alert" style={{ padding: 32, fontSize: 14, color: '#1E2A22' }}>
        {splash}
        This Docs window does not name a project. Open Docs from the board instead.
      </div>
    );
  }

  return (
    <div
      data-testid="docs-window"
      style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg, #EEF3EF)' }}
    >
      {splash}
      <header
        style={{
          height: 44,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '0 12px 0 16px',
          borderBottom: '1px solid #DDE7E0',
          background: '#FFFFFF',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 22,
            height: 22,
            borderRadius: 6,
            background: '#2E6F40',
            color: '#FFFFFF',
            fontSize: 11,
            fontWeight: 800,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {(project?.prefix ?? 'D').slice(0, 1)}
        </span>
        <h1 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: '#1E2A22' }}>
          Docs
          {name && <span style={{ fontWeight: 500, color: '#5B6B60' }}> · {name}</span>}
        </h1>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={dock}
          title="Dock back into the board (Ctrl+Shift+D)"
          aria-keyshortcuts="Control+Shift+D"
          data-testid="docs-dock-back"
          style={{
            height: 30,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '0 12px',
            borderRadius: 8,
            border: '1px solid #CFDDD3',
            background: '#FFFFFF',
            color: '#1E2A22',
            fontSize: 13,
            fontWeight: 600,
            fontFamily: 'inherit',
            cursor: 'pointer',
          }}
        >
          <DockIcon />
          Dock back
        </button>
      </header>
      <main style={{ flex: 1, minHeight: 0, display: 'flex', padding: 12, gap: 12 }}>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            borderRadius: 12,
            overflow: 'hidden',
            border: '1px solid #DDE7E0',
            background: '#FFFFFF',
          }}
        >
          <DocsSpace
            projectId={projectId}
            projectName={name}
            requestedPageId={request}
            onRequestHandled={() => setRequest(null)}
            onOpenTicket={openTicket}
            onBack={dock}
          />
        </div>
      </main>
    </div>
  );
}
