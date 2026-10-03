import { useState } from 'react';
import { useTicketWorkspace, useSetTicketWorkspaceRetention } from '../api/tickets';
import styles from './WorkspaceSection.module.css';

interface WorkspaceSectionProps {
  ticketId: string;
  readOnly?: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function formatTimeAgo(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffSec = Math.floor((now.getTime() - date.getTime()) / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay}d ago`;
}

function getFileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase();
  const isDir = name.endsWith('/');

  if (isDir) {
    return (
      <div className={styles.tcFileIcon} style={{ background: '#F1F3F1' }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#5B6B60" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 7C3 5.9 3.9 5 5 5H9.2L11.2 7.5H19C20.1 7.5 21 8.4 21 9.5V17C21 18.1 20.1 19 19 19H5C3.9 19 3 18.1 3 17V7Z" />
        </svg>
      </div>
    );
  }

  if (['png', 'jpg', 'jpeg', 'webp', 'svg'].includes(ext ?? '')) {
    return (
      <div className={styles.tcFileIcon} style={{ background: '#FBE9E1' }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#B4571F" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="M21 15L16 10L5 21" />
        </svg>
      </div>
    );
  }

  return (
    <div className={styles.tcFileIcon} style={{ background: '#E1EEFB' }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2F6FB0" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 3H7C5.9 3 5 3.9 5 5V19C5 20.1 5.9 21 7 21H17C18.1 21 19 20.1 19 19V8L14 3Z" />
        <path d="M14 3V8H19" />
      </svg>
    </div>
  );
}

export function WorkspaceSection({ ticketId, readOnly = false }: WorkspaceSectionProps) {
  const { data: ws, isLoading, refetch } = useTicketWorkspace(ticketId);
  const setRetentionMutation = useSetTicketWorkspaceRetention();
  const [copied, setCopied] = useState(false);

  const displayPath = ws?.path || `~/kanban-workspace/${ticketId}`;
  const retentionDays = ws?.retentionDays;

  function copyPath() {
    navigator.clipboard.writeText(displayPath);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleRetentionChange(val: string) {
    const parsed = val === 'inherit' ? null : parseInt(val, 10);
    setRetentionMutation.mutate({ ticketId, retentionDays: parsed });
  }

  if (isLoading) {
    return <div className={styles.emptyState}>Loading workspace...</div>;
  }

  return (
    <div className={styles.container}>
      {/* Top Bar: Path & Action Buttons */}
      <div className={styles.topBar}>
        <div className={styles.wsPathBar}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#9AA8A0" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 7C3 5.9 3.9 5 5 5H9.2L11.2 7.5H19C20.1 7.5 21 8.4 21 9.5V17C21 18.1 20.1 19 19 19H5C3.9 19 3 18.1 3 17V7Z" />
          </svg>
          <span>{displayPath}</span>
          <button
            type="button"
            className={styles.copyBtn}
            onClick={copyPath}
            title={copied ? 'Copied!' : 'Copy path'}
            aria-label="Copy path"
          >
            {copied ? (
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#2E6F40" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="12" height="12" rx="2" />
                <path d="M5 15H4A2 2 0 0 1 2 13V4A2 2 0 0 1 4 2H13A2 2 0 0 1 15 4V5" />
              </svg>
            )}
          </button>
        </div>

        <div className={styles.topActions}>
          {/* Retention status chip */}
          {retentionDays === null || retentionDays === undefined || retentionDays === 0 ? (
            <span className={`${styles.retentionChip} ${styles.retentionChipForever}`}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" />
                <polyline points="12 6 12 12 14 14" />
              </svg>
              Kept forever
            </span>
          ) : (
            <span className={styles.retentionChip}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7V12L15.5 14.5" />
              </svg>
              Auto-delete in {retentionDays} days
            </span>
          )}

          <button
            type="button"
            className={styles.actionBtn}
            onClick={copyPath}
            title="Open folder"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M13 3L4 14H12L11 21L20 10H12L13 3Z" />
            </svg>
            Open folder
          </button>
        </div>
      </div>

      {/* Retention setting card */}
      {!readOnly && (
        <div className={styles.retentionCard}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: '#1E2A22' }}>Retention Policy</span>
            <span style={{ fontSize: 11, color: '#5B6B60' }}>
              Control when files in this scratch directory are cleaned up.
            </span>
          </div>
          <select
            className={styles.retentionSelect}
            value={retentionDays ?? 'inherit'}
            onChange={(e) => handleRetentionChange(e.target.value)}
          >
            <option value="inherit">Inherit workspace default</option>
            <option value="7">Auto-delete after 7 days</option>
            <option value="14">Auto-delete after 14 days</option>
            <option value="30">Auto-delete after 30 days</option>
            <option value="0">Keep forever (never delete)</option>
          </select>
        </div>
      )}

      {/* Files count & Refresh bar */}
      <div className={styles.metaRow}>
        <span className={styles.tcLabel}>
          {(ws?.files.length ?? 0)} ITEMS · {formatBytes(ws?.totalBytes ?? 0)}
        </span>
        <button
          type="button"
          className={styles.actionBtn}
          style={{ fontSize: 11.5, padding: '4px 10px' }}
          onClick={() => refetch()}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 4V10H10" />
            <path d="M4 10L8 6.5A8 8 0 1 1 4 14" />
          </svg>
          Refresh
        </button>
      </div>

      {/* Files Table */}
      <div className={styles.tableContainer}>
        {(!ws?.files || ws.files.length === 0) ? (
          <div className={styles.emptyState}>
            No files in workspace directory yet. Files created by tools or dumped in {displayPath} will appear here.
          </div>
        ) : (
          ws.files.map((file, i) => (
            <div key={file.name || i} className={styles.wsRow}>
              {getFileIcon(file.name)}
              <span className={styles.fileName}>{file.name}</span>
              <span className={styles.fileSize}>{formatBytes(file.size)}</span>
              <span className={styles.fileTime}>{formatTimeAgo(file.modifiedAt)}</span>
              <button
                type="button"
                className={styles.copyBtn}
                onClick={copyPath}
                title="Reveal path"
                aria-label="Reveal in folder"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M13 3L4 14H12L11 21L20 10H12L13 3Z" />
                </svg>
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
