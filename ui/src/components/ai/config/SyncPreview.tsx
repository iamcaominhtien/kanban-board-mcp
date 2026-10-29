import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { extractError } from '../../../api/extractError';
import { useToast } from '../../Toast';
import { ago } from '../aiUi';
import {
  configApi,
  configKeys,
  type Backup,
  type ConflictInfo,
  type PlannedFile,
  type SyncPreview as Preview,
  type WriteResult,
} from './configApi';
import { adapterOf, useCfg } from './configCtx';
import { CfgCard, Chip, CopyButton, DiffView, Dialog } from './parts';

function when(iso: string | null): string {
  if (!iso) return 'earlier';
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const ACTION_TEXT: Record<PlannedFile['action'], string> = {
  new: 'new',
  modified: 'modified',
  delete: 'removed',
  error: 'error',
};

/** One conflict: your edits against the board, with keep / overwrite and the previous versions (design B9). */
function ConflictCard({
  c,
  choice,
  onChoice,
}: {
  c: ConflictInfo;
  choice: 'keep' | 'overwrite';
  onChoice: (v: 'keep' | 'overwrite') => void;
}) {
  const what =
    c.kind === 'removed'
      ? 'was removed or emptied outside Kanban'
      : c.kind === 'exists'
        ? 'already exists and was not written by Kanban'
        : 'changed outside Kanban';
  return (
    <div
      className="ai-card"
      style={{ padding: 12, borderColor: '#F0C4B8', display: 'flex', flexDirection: 'column', gap: 8 }}
      data-testid="conflict-card"
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <b style={{ fontSize: 12.5 }}>
          <span className="ai-mono">{c.path}</span> {what}.
        </b>
        <span style={{ flex: 1 }} />
        <Chip tone="bad">conflict</Chip>
      </div>
      <div className="ai-hint">
        {c.writtenAt
          ? `It no longer matches the copy written ${when(c.writtenAt)}. `
          : 'Kanban has not written this file before. '}
        Nothing was overwritten.
        {c.editedAt ? ` Edited by hand ${when(c.editedAt)}.` : ''}
      </div>
      <div className="ai-label">{c.path} — your edits (+) vs the board (−)</div>
      <DiffView rows={c.diff} />
      <label className="ai-option" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
        <input
          type="radio"
          name={`res-${c.path}-${c.unit}`}
          checked={choice === 'keep'}
          onChange={() => onChoice('keep')}
          aria-label="Keep my lines, update the rest"
        />
        <span>
          <b style={{ fontSize: 12.5 }}>Keep my lines, update the rest</b> <Chip>Default</Chip>
          <div className="ai-muted">Your edits stay; Kanban updates the rest of its own content around them.</div>
        </span>
      </label>
      <label className="ai-option" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
        <input
          type="radio"
          name={`res-${c.path}-${c.unit}`}
          checked={choice === 'overwrite'}
          onChange={() => onChoice('overwrite')}
          aria-label="Overwrite with the board version"
        />
        <span>
          <b style={{ fontSize: 12.5 }}>Overwrite with the board version</b>
          <div className="ai-muted">Your version is saved as a backup first.</div>
        </span>
      </label>
    </div>
  );
}

/** Put an earlier version of a file back. */
function RestoreDialog({
  path,
  backup,
  onClose,
  onDone,
}: {
  path: string;
  backup: Backup;
  onClose: () => void;
  onDone: () => void;
}) {
  const { member } = useCfg();
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      title="Restore this version?"
      width={460}
      onClose={onClose}
      foot={
        <>
          <span style={{ flex: 1 }} />
          <button type="button" className="ai-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="ai-btn ai-btn-primary"
            onClick={async () => {
              try {
                await configApi.restore(member.id, path, backup.id);
                onDone();
              } catch (e) {
                setError(extractError(e));
              }
            }}
          >
            Restore
          </button>
        </>
      }
    >
      <div className="ai-hint">
        <span className="ai-mono">{path}</span> goes back to the copy from {when(backup.at)}. The current file is saved
        as a backup first.
      </div>
      {error && <div className="ai-error-text">{error}</div>}
    </Dialog>
  );
}

/** Files the runner writes before the next run, with diffs, conflicts and previous versions (design B8, B9, F4, F5). */
export function SyncPreview() {
  const { member, dirty, status, setCfg, cfg, refreshStatus } = useCfg();
  const qc = useQueryClient();
  const toast = useToast();
  const kind = adapterOf(member);
  const q = useQuery<Preview>({
    queryKey: [...configKeys.status(member.id), 'preview', status?.version ?? 0, status?.syncedAt ?? ''],
    queryFn: () => configApi.preview(member.id),
    enabled: !!status,
  });
  const [open, setOpen] = useState<string | null>(null);
  const [choices, setChoices] = useState<Record<string, 'keep' | 'overwrite'>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ path: string; message: string } | null>(null);
  const [restoring, setRestoring] = useState<{ path: string; backup: Backup } | null>(null);
  const p = q.data;
  const experimental = kind === 'antigravity';

  async function write() {
    if (!p) return;
    setBusy(true);
    setFailure(null);
    try {
      const resolutions = [...new Set(p.conflicts.map((c) => c.path))].map((path) => ({
        path,
        choice: choices[path] ?? 'keep',
      }));
      const r: WriteResult = await configApi.write(member.id, { resolutions });
      if (r.ok) {
        toast.success(
          r.written.length
            ? `Wrote ${r.written.length} file${r.written.length === 1 ? '' : 's'}`
            : 'Already up to date',
          member.workingDir ?? '',
        );
        setChoices({});
      } else if (r.error) {
        setFailure(r.error);
      }
      await qc.invalidateQueries({ queryKey: ['ai', 'config-status', member.id] });
      refreshStatus();
    } catch (e) {
      setFailure({ path: '', message: extractError(e) });
    } finally {
      setBusy(false);
    }
  }

  const folderOnline = p?.runner.online ?? true;
  const switchToDocumented = () =>
    setCfg({
      skills: cfg.skills.map((s) => ({ ...s, mode: 'documented' as const })),
      mcpServers: cfg.mcpServers.map((s) => ({ ...s, mode: 'documented' as const })),
    });
  return (
    <CfgCard
      id="cfg-sync"
      testId="card-sync"
      title="Sync preview"
      mode={experimental ? 'documented' : 'synced'}
      right={
        <span className="ai-muted">
          {experimental ? 'Experimental · writes when you press Write now' : 'Synced · writes on next run'}
        </span>
      }
      sub="Files the runner will write before the next run."
    >
      {q.isLoading && <div className="ai-skel" style={{ height: 90 }} />}
      {q.isError && <div className="ai-notice ai-notice-error">{extractError(q.error)}</div>}
      {p && !folderOnline && (
        <div
          className="ai-notice ai-notice-warn"
          style={{ flexDirection: 'column', gap: 4 }}
          data-testid="runner-offline"
        >
          <b>Pending — will apply on the next run</b>
          <span>
            {p.runner.reason} {p.pending} file{p.pending === 1 ? '' : 's'} cannot be written yet. Items show “Pending”
            and the run waits in the queue.
          </span>
          <div style={{ display: 'flex', gap: 6 }}>
            <Chip tone="warn">{p.pending} files pending</Chip>
            {p.hooksPending && <Chip tone="warn">Hooks pending</Chip>}
          </div>
        </div>
      )}
      {failure && (
        <div
          className="ai-notice ai-notice-error"
          style={{ flexDirection: 'column', gap: 6 }}
          data-testid="sync-failed"
        >
          <b>Could not write {failure.path || 'the files'}</b>
          <span>{failure.message}</span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" className="ai-btn ai-btn-sm" onClick={() => void write()}>
              Retry
            </button>
            <button
              type="button"
              className="ai-btn ai-btn-sm"
              onClick={() => (document.querySelector('[data-path="working_dir"]') as HTMLElement | null)?.focus()}
            >
              Change folder
            </button>
            {!experimental && (
              <button
                type="button"
                className="ai-btn ai-btn-sm"
                onClick={switchToDocumented}
                title="Skills and MCP servers become Documented (unsaved)"
              >
                Switch to Documented
              </button>
            )}
          </div>
        </div>
      )}
      {p && p.files.length === 0 && p.conflicts.length === 0 && folderOnline && (
        <div className="ai-muted" data-testid="sync-uptodate">
          {experimental && p.mode === 'none'
            ? 'Nothing to write: experimental MCP sync is off.'
            : `Everything is written. ${p.syncedFiles} file${p.syncedFiles === 1 ? '' : 's'} managed${p.syncedAt ? `, last written ${ago(p.syncedAt)}` : ''}.`}
        </div>
      )}
      {p &&
        p.files.map((f) => (
          <div key={f.path} data-testid={`sync-file-${f.path}`}>
            <button
              type="button"
              className="cfg-row"
              style={{
                width: '100%',
                background: 'none',
                border: 'none',
                borderTop: '1px solid #eef3ef',
                cursor: 'pointer',
                textAlign: 'left',
                fontFamily: 'inherit',
              }}
              onClick={() => setOpen(open === f.path ? null : f.path)}
            >
              <span className="ai-mono cfg-row-main" style={{ fontSize: 12.5, fontWeight: 600 }}>
                {f.path}
              </span>
              <Chip
                tone={
                  f.action === 'error' ? 'bad' : f.action === 'new' ? 'synced' : f.action === 'delete' ? 'warn' : 'lib'
                }
              >
                {ACTION_TEXT[f.action]}
              </Chip>
              {f.foreign && (
                <Chip tone="warn" title="The file exists and was not written by Kanban">
                  your file
                </Chip>
              )}
              <span className="ai-mono ai-muted">
                +{f.added} −{f.removed}
              </span>
              <span aria-hidden="true">{open === f.path ? '▾' : '▸'}</span>
            </button>
            {f.error && <div className="ai-error-text">{f.error}</div>}
            {open === f.path && !f.error && (
              <div style={{ marginBottom: 8 }}>
                <div className="ai-label" style={{ marginBottom: 4 }}>
                  {f.path} — diff
                </div>
                <DiffView rows={f.diff} />
              </div>
            )}
          </div>
        ))}
      {p && p.hooksPending && (
        <div className="ai-notice ai-notice-warn" data-testid="hooks-pending">
          Hooks are not written yet: they need the typed confirmation “allow hooks” (Hooks card).
        </div>
      )}
      {p && p.conflicts.length > 0 && (
        <>
          <div className="ai-notice ai-notice-error" style={{ flexDirection: 'column' }}>
            <b>
              {p.conflicts.length} conflict{p.conflicts.length === 1 ? '' : 's'}
            </b>
            <span>The runner is paused for this member until you choose.</span>
          </div>
          {p.conflicts.map((c) => (
            <ConflictCard
              key={`${c.path}-${c.unit}`}
              c={c}
              choice={choices[c.path] ?? 'keep'}
              onChoice={(v) => setChoices({ ...choices, [c.path]: v })}
            />
          ))}
        </>
      )}
      {p && p.backups.length > 0 && (
        <div className="ai-field" data-testid="backups">
          <span className="ai-label ai-label-dark">Previous versions (last 5 kept in .claude/.kanban/backups)</span>
          {p.backups.map((b) => (
            <div key={b.path} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12 }}>
              <span className="ai-mono">{b.path}</span>
              {b.items.map((it) => (
                <button
                  key={it.id}
                  type="button"
                  className="ai-link"
                  onClick={() => setRestoring({ path: b.path, backup: it })}
                >
                  {when(it.at)}
                </button>
              ))}
              <span className="ai-muted">Restore…</span>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          type="button"
          className="ai-btn ai-btn-primary"
          data-testid="write-now"
          disabled={busy || !p || !folderOnline || dirty || (p.files.length === 0 && p.conflicts.length === 0)}
          title={dirty ? 'Save your changes first: Write now writes the saved configuration' : undefined}
          onClick={() => void write()}
        >
          {p && p.conflicts.length ? 'Resolve and write' : 'Write now'}
        </button>
        {member.workingDir && <CopyButton text={member.workingDir} label="Copy folder path" />}
        <span className="ai-muted" data-testid="sync-summary">
          {folderOnline ? 'Runner online' : 'Runner offline'} · {p?.files.length ?? 0} file
          {(p?.files.length ?? 0) === 1 ? '' : 's'} · {p?.conflicts.length ?? 0} conflict
          {(p?.conflicts.length ?? 0) === 1 ? '' : 's'}
          {dirty ? ' · unsaved changes are not included' : ''}
        </span>
      </div>
      {restoring && (
        <RestoreDialog
          path={restoring.path}
          backup={restoring.backup}
          onClose={() => setRestoring(null)}
          onDone={() => {
            setRestoring(null);
            void qc.invalidateQueries({ queryKey: ['ai', 'config-status', member.id] });
            toast.success('Restored', restoring.path);
          }}
        />
      )}
    </CfgCard>
  );
}
