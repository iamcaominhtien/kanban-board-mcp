import { Suspense, lazy, useState } from 'react';
import type { DocsPage } from '../../types/docs';
import { currentActor } from '../canvas/CanvasProvider';
// the editor is only fetched when a canvas page is opened
const CanvasEditor = lazy(() => import('../canvas/CanvasEditor').then((m) => ({ default: m.CanvasEditor })));
import { Icon } from './Icon';
import { PageMenu, type PageMenuAction } from './PageMenu';
import canvasStyles from '../canvas/Canvas.module.css';

interface Props {
  page: DocsPage;
  projectId: string;
  projectName: string;
  onAction: (a: PageMenuAction) => void;
  onOpenPage: (pageId: string) => void;
}

const crumb = { fontSize: 12.5, color: '#5B6B60', whiteSpace: 'nowrap' } as const;

/**
 * A Docs page of kind canvas: it opens right in Docs with the same editor as an inline canvas, without Done (changes
 * save as they are made) and with Share. The page header keeps the page tree path and the page menu; page history,
 * access and backlinks are Docs'.
 * @param props.page - The canvas page.
 * @param props.projectId - Its project.
 * @param props.projectName - Shown first in the path.
 * @param props.onAction - Called with a page menu action (rename, move, history, delete…).
 * @param props.onOpenPage - Called when a parent page in the path is clicked.
 */
export function CanvasPageView({ page, projectId, projectName, onAction, onOpenPage }: Props) {
  const [menu, setMenu] = useState(false);
  const canvasId = /canvas:(cv_[0-9a-f]{8})/.exec(page.markdown)?.[1];
  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '18px 24px', flex: 1, minHeight: 0 }}
      data-testid="canvas-page"
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between' }}>
        <nav
          aria-label="Breadcrumb"
          style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0, flex: 1, overflow: 'hidden' }}
        >
          <Icon name="folder" size={13} strokeWidth={1.8} style={{ color: '#9AA8A0' }} />
          <span style={crumb}>{projectName}</span>
          <Icon name="chevronRight" size={10} strokeWidth={2.4} style={{ color: '#C7D2CB' }} />
          {page.path.map((p) => (
            <span key={p.id} style={{ display: 'contents' }}>
              <button
                type="button"
                onClick={() => onOpenPage(p.id)}
                style={{
                  ...crumb,
                  border: 'none',
                  background: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {p.title}
              </button>
              <Icon name="chevronRight" size={10} strokeWidth={2.4} style={{ color: '#C7D2CB' }} />
            </span>
          ))}
          <Icon name="canvas" size={13} strokeWidth={1.8} style={{ color: '#244E78' }} />
          <span style={{ fontSize: 12.5, fontWeight: 700, color: '#1E2A22', whiteSpace: 'nowrap' }}>{page.title}</span>
        </nav>
        <div data-popover style={{ position: 'relative' }}>
          <button
            type="button"
            className="st-btn"
            aria-label="Page menu"
            aria-expanded={menu}
            onClick={() => setMenu((v) => !v)}
            data-testid="canvas-page-menu"
          >
            <Icon name="more" size={14} strokeWidth={1.8} />
          </button>
          {menu && (
            <PageMenu
              page={page}
              onClose={() => setMenu(false)}
              onAction={(a) => {
                setMenu(false);
                onAction(a);
              }}
            />
          )}
        </div>
      </div>
      <div className={canvasStyles.pageEditor} data-project={projectId}>
        {canvasId ? (
          <Suspense fallback={<div style={{ padding: 24, color: '#5B6B60' }}>Loading the canvas…</div>}>
            <CanvasEditor
              key={canvasId}
              canvasId={canvasId}
              variant="page"
              me={currentActor()}
              request={{ ownerKind: 'page', ownerId: page.id, canvasId, projectId, ownerLabel: `Docs › ${page.title}` }}
              onClose={() => undefined}
            />
          </Suspense>
        ) : (
          <div style={{ padding: 24, color: '#5B6B60' }}>This canvas page has no canvas yet.</div>
        )}
      </div>
    </div>
  );
}
