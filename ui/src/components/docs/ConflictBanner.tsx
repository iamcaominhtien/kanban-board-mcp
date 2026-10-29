import { useState } from 'react';
import { useDocsDiff } from '../../api/docs';
import { actorName } from '../../utils/relativeTime';
import { Avatar, fmtTimeOnly, PlusMinus } from './docsShared';
import { DiffView } from './DiffView';
import { Icon } from './Icon';
import './docs.css';

interface Props {
  pageId: string;
  baseVersion: number;
  latestVersion: number;
  latestAuthor?: string | null;
  latestAt?: string | null;
  busy?: boolean;
  onKeepMine: () => void;
  onReload: () => void;
}

/**
 * Amber conflict bar under the editor header (DocsEditor board F): View their changes / Keep mine / Reload.
 * @param props.pageId - Page the conflict belongs to.
 * @param props.baseVersion - Version the local edit started from.
 * @param props.latestVersion - Newer version found on the server.
 * @param props.latestAuthor - Author of the newer version.
 * @param props.latestAt - ISO time of the newer version.
 * @param props.busy - Disable the actions while a save or reload runs.
 * @param props.onKeepMine - Called to overwrite the newer version with the local edit.
 * @param props.onReload - Called to discard the local edit and load the newer version.
 */
export function ConflictBanner({
  pageId,
  baseVersion,
  latestVersion,
  latestAuthor,
  latestAt,
  busy,
  onKeepMine,
  onReload,
}: Props) {
  const [open, setOpen] = useState(false);
  const diff = useDocsDiff(open ? pageId : null, open ? baseVersion : null, open ? latestVersion : null);
  const who = latestAuthor ? actorName(latestAuthor) : 'Someone else';
  return (
    <div data-testid="conflict-banner" role="alert" style={{ flexShrink: 0 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '11px 16px',
          background: '#FCEFD9',
          borderBottom: '1px solid #EBD3A6',
          boxSizing: 'border-box',
        }}
      >
        <span style={{ color: '#B4791E', display: 'flex' }}>
          <Icon name="i22" size={18} />
        </span>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: '#1E2A22' }}>Someone else edited this page</div>
          <div style={{ fontSize: 12.5, color: '#3A4A3E', lineHeight: 1.45 }}>
            {who} published v{latestVersion}
            {latestAt ? ` at ${fmtTimeOnly(latestAt)}` : ''}. You started from v{baseVersion}, so Publish is paused.
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <button
            type="button"
            className="st-btn st-btn-sm"
            onClick={() => setOpen((v) => !v)}
            data-testid="view-theirs"
          >
            <Icon name="i40" size={14} />
            {open ? 'Hide changes' : 'View their changes'}
          </button>
          <button
            type="button"
            className="st-btn st-btn-sm"
            disabled={busy}
            onClick={onKeepMine}
            data-testid="keep-mine"
          >
            Keep mine
          </button>
          <button
            type="button"
            className="st-btn st-btn-sm st-btn-danger-outline"
            disabled={busy}
            onClick={onReload}
            data-testid="reload-theirs"
          >
            Reload
          </button>
        </div>
      </div>
      {open && (
        <div
          style={{
            maxHeight: 260,
            overflowY: 'auto',
            background: '#FFFFFF',
            borderBottom: '1px solid #E3E8E5',
            padding: '12px 20px',
          }}
        >
          {diff.isLoading && <div className="st-hint">Loading their changes…</div>}
          {diff.data && (
            <>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  marginBottom: 8,
                  fontSize: 12.5,
                  color: '#5B6B60',
                }}
              >
                <Avatar name={latestAuthor ?? 'user'} size={20} />
                <b style={{ color: '#1E2A22' }}>
                  v{latestVersion} by {who}
                </b>
                <PlusMinus added={diff.data.added} removed={diff.data.removed} />
                <span>lines{latestAt ? ` · ${fmtTimeOnly(latestAt)}` : ''}</span>
              </div>
              <DiffView diff={diff.data} mode="inline" />
            </>
          )}
        </div>
      )}
    </div>
  );
}
