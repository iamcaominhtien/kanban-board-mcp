import { useState } from 'react';
import { usePacks } from '../../../api/aiPacks';
import type { RolePack } from '../../../types/aiPacks';
import { LineIcon } from '../../ui/LineIcon';
import { useToast } from '../../Toast';
import { LoadError } from '../aiUi';
import { AddRoleDialog, ConfirmPackDialog } from './PackDialogs';
import { PackEditor } from './PackEditor';
import { PackFileDialog } from './PackFileDialog';
import { PackList, type PackActions } from './PackList';
import './rolePacks.css';

type Dialog =
  { kind: 'add' } | { kind: 'file'; pack: RolePack | null } | { kind: 'reset' | 'remove'; pack: RolePack } | null;

/**
 * Settings › AI › Role packs: the ready-made roles and the project's own, each one pack (persona, model and effort,
 * what it writes and hands in, plugins, limits). Edit one, add one, export and import a file, put a ready-made role
 * back or remove an own one (design/screens/ai-project-settings.md, D).
 */
export function RolePacksSection({ projectId }: { projectId: string }) {
  const packs = usePacks(projectId);
  const toast = useToast();
  const [editing, setEditing] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const current = editing ? packs.data?.find((p) => p.key === editing) : undefined;

  const actions: PackActions = {
    onEdit: (p) => setEditing(p.key),
    onExport: (p) => setDialog({ kind: 'file', pack: p }),
    onReset: (p) => setDialog({ kind: 'reset', pack: p }),
    onRemove: (p) => setDialog({ kind: 'remove', pack: p }),
  };

  let body;
  if (packs.isError) {
    body = <LoadError what="the role packs" error={packs.error} onRetry={() => void packs.refetch()} />;
  } else if (!packs.data) {
    body = <div className="ai-skel" style={{ height: 240 }} aria-busy="true" data-testid="packs-loading" />;
  } else if (editing && current) {
    body = (
      <PackEditor
        // a save makes a new version: the form starts again from what the server kept
        key={`${current.key}:${current.id}:${current.version}`}
        projectId={projectId}
        pack={current}
        onBack={() => setEditing(null)}
        onExport={actions.onExport}
        onReset={actions.onReset}
        onRemove={actions.onRemove}
      />
    );
  } else {
    body = (
      <>
        <PackList packs={packs.data} actions={actions} />
        <p className="rp-note">
          Editing a ready-made role makes this project’s own copy; the ready-made one is not touched. Every save is a
          new version; the last 20 are kept.
        </p>
      </>
    );
  }

  return (
    <div className="rp-root" data-testid="role-packs" data-setting="role-packs">
      <div className="rp-toolbar">
        <div className="ai-hint" style={{ maxWidth: 520 }}>
          Everything that makes an AI a role, in one pack: who it is, its model, what it hands in. A team is made from
          packs; you can edit them for this project.
        </div>
        <div className="rp-toolbar-actions">
          <button
            type="button"
            className="ai-btn ai-btn-sm"
            onClick={() => setDialog({ kind: 'file', pack: null })}
            data-testid="pack-import"
          >
            <LineIcon name="upload" size={13} />
            Import a pack
          </button>
          <button
            type="button"
            className="ai-btn ai-btn-sm ai-btn-primary"
            onClick={() => setDialog({ kind: 'add' })}
            disabled={!packs.data}
            data-testid="pack-add"
          >
            <LineIcon name="plus" size={13} />
            Add a role
          </button>
        </div>
      </div>

      {body}

      {dialog?.kind === 'add' && packs.data && (
        <AddRoleDialog
          projectId={projectId}
          packs={packs.data}
          onClose={() => setDialog(null)}
          onAdded={(p) => {
            setDialog(null);
            setEditing(p.key);
            toast.success(`${p.name} added`, `Version ${p.version}.`);
          }}
        />
      )}
      {dialog?.kind === 'file' && (
        <PackFileDialog projectId={projectId} pack={dialog.pack} onClose={() => setDialog(null)} />
      )}
      {(dialog?.kind === 'reset' || dialog?.kind === 'remove') && (
        <ConfirmPackDialog
          projectId={projectId}
          pack={dialog.pack}
          mode={dialog.kind}
          onClose={() => setDialog(null)}
          onDone={(p) => {
            setDialog(null);
            setEditing(null);
            if (dialog.kind === 'reset') toast.success(`Ready-made ${p.name} is back`);
            else toast.success(`${p.name} removed`);
          }}
        />
      )}
    </div>
  );
}
