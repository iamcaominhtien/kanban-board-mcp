import { useState } from 'react';
import { useRestoreVersion } from '../../api/docs';
import { extractError } from '../../api/extractError';
import type { Member } from '../../types/ticket';
import type { DocsPage } from '../../types/docs';
import { absoluteTime, relativeTime } from '../../utils/relativeTime';
import { useToast } from '../Toast';
import { LineIcon } from '../ui/LineIcon';
import { Icon } from './Icon';

const key = (pageId: string, version: number) => `docsAiChanged:${pageId}:${version}`;

function dismissed(pageId: string, version: number): boolean {
  try {
    return localStorage.getItem(key(pageId, version)) === '1';
  } catch {
    return false;
  }
}

/** Whether the latest published version was written by an AI team of the project, and which one. */
export function aiWriter(page: DocsPage, members: Member[]): Member | null {
  if (page.version < 2) return null;
  const by = page.updatedBy.trim().toLowerCase();
  return members.find((m) => m.kind === 'ai' && m.name.trim().toLowerCase() === by) ?? null;
}

interface Props {
  page: DocsPage;
  projectId: string;
  members: Member[];
  /** Whether the reader can edit the page (Undo restores the previous version). */
  canEdit: boolean;
  /** Open the diff between two versions. */
  onCompare?: (from: number, to: number) => void;
}

/**
 * "Team X changed this page · See changes · Undo": a slim bar above the page when its latest version was written by an
 * AI team. "x" hides it for this page and version.
 * @param props.page - Page being read.
 * @param props.projectId - Project of the page.
 * @param props.members - The project's members (an AI team's name is the page's `updatedBy`).
 * @param props.canEdit - Show Undo.
 * @param props.onCompare - Called with the previous version and the latest to open their diff.
 */
export function AiChangedBar({ page, projectId, members, canEdit, onCompare }: Props) {
  const toast = useToast();
  const restore = useRestoreVersion(projectId);
  const [hiddenFor, setHiddenFor] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const writer = aiWriter(page, members);
  const id = key(page.id, page.version);
  if (!writer || hiddenFor === id || dismissed(page.id, page.version)) return null;

  const previous = page.version - 1;
  const close = () => {
    try {
      localStorage.setItem(id, '1');
    } catch {
      /* storage unavailable: hidden until the page is closed */
    }
    setHiddenFor(id);
  };
  const undo = async () => {
    try {
      const p = await restore.mutateAsync({ pageId: page.id, version: previous });
      setConfirming(false);
      toast.success(`Restored v${previous}`, `The page is v${p.version} now, with the text of v${previous}.`);
    } catch (e) {
      toast.error("Couldn't undo the change", extractError(e));
    }
  };

  const cancel = (
    <button type="button" className="st-btn st-btn-sm" onClick={() => setConfirming(false)}>
      Cancel
    </button>
  );
  return (
    <div
      className="docs-root"
      data-testid="ai-changed-bar"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '7px 12px',
        marginBottom: 16,
        borderRadius: 10,
        background: '#F1ECFB',
        border: '1px solid #DCD0F3',
        fontSize: 13,
        color: '#1E2A22',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px 10px' }}>
        <span style={{ display: 'flex', color: '#6B4FBB' }}>
          <LineIcon name="sparkle" size={15} />
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <b style={{ fontWeight: 700 }}>{writer.name}</b> changed this page{' '}
          <span style={{ color: '#5B6B60' }} title={absoluteTime(page.updatedAt)}>
            · {relativeTime(page.updatedAt)} · v{page.version}
          </span>
        </span>
        {!confirming && onCompare && (
          <button
            type="button"
            className="st-btn st-btn-sm"
            onClick={() => onCompare(previous, page.version)}
            data-testid="ai-changed-diff"
          >
            See changes
          </button>
        )}
        {!confirming && canEdit && (
          <button
            type="button"
            className="st-btn st-btn-sm"
            onClick={() => setConfirming(true)}
            data-testid="ai-changed-undo"
          >
            Undo
          </button>
        )}
        <button type="button" className="dk-icobtn" aria-label="Hide" style={{ width: 26, height: 26 }} onClick={close}>
          <Icon name="i08" size={14} strokeWidth={2} />
        </button>
      </div>
      {confirming && (
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px 10px', paddingLeft: 25 }}>
          <span style={{ color: '#5B6B60', flex: 1, minWidth: 0 }}>
            Go back to v{previous}? It is kept as a new version.
          </span>
          {cancel}
          <button
            type="button"
            className="st-btn st-btn-sm st-btn-primary"
            disabled={restore.isPending}
            onClick={() => void undo()}
            data-testid="ai-changed-undo-yes"
          >
            {restore.isPending ? 'Restoring…' : `Restore v${previous}`}
          </button>
        </div>
      )}
    </div>
  );
}
