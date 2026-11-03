import { useDocsTree } from '../../api/docs';
import { DockIcon, PopOutIcon } from './DocsWindowIcons';

interface Props {
  projectId: string;
  projectName: string;
  pageId: string | null;
  onFocus: () => void;
  onDockBack: () => void;
}

/**
 * What the board's Docs tab shows while this project's Docs is open in a window of its own: where it is, a button to
 * bring that window to the front and one to dock Docs back here.
 */
export function DocsPoppedOut({ projectId, projectName, pageId, onFocus, onDockBack }: Props) {
  const nodes = useDocsTree(projectId).data ?? [];
  const page = pageId ? nodes.find((n) => n.id === pageId) : undefined;
  const btn = {
    height: 36,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    padding: '0 16px',
    borderRadius: 8,
    fontSize: 13.5,
    fontWeight: 600,
    fontFamily: 'inherit',
    cursor: 'pointer',
  } as const;
  return (
    <div
      data-testid="docs-popped-out"
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#FFFFFF',
        borderRadius: 12,
        padding: 24,
      }}
    >
      <section
        aria-labelledby="docs-popped-title"
        style={{
          maxWidth: 440,
          textAlign: 'center',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 48,
            height: 48,
            borderRadius: '50%',
            background: '#DCEEE1',
            color: '#2E6F40',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <PopOutIcon size={22} />
        </span>
        <h2 id="docs-popped-title" style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#1E2A22' }}>
          Docs is open in its own window
        </h2>
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55, color: '#5B6B60' }}>
          {projectName ? `${projectName}’s Docs` : 'This project’s Docs'}
          {page ? (
            <>
              {' '}
              is showing <strong style={{ color: '#1E2A22' }}>{page.title}</strong>
            </>
          ) : null}
          . Work there beside the board, or dock it back here when you need it in this window.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center', marginTop: 4 }}>
          <button
            type="button"
            onClick={onFocus}
            data-testid="docs-show-window"
            style={{ ...btn, border: '1px solid #CFDDD3', background: '#FFFFFF', color: '#1E2A22' }}
          >
            <PopOutIcon />
            Show the window
          </button>
          <button
            type="button"
            onClick={onDockBack}
            data-testid="docs-dock-here"
            style={{ ...btn, border: '1px solid #2E6F40', background: '#2E6F40', color: '#FFFFFF' }}
          >
            <DockIcon />
            Dock back here
          </button>
        </div>
      </section>
    </div>
  );
}
