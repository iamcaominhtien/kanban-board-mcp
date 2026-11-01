import { useState } from 'react';
import { packsApi, useDeletePack, usePacks } from '../../../api/aiPacks';
import { extractError } from '../../../api/extractError';
import type { Pack } from '../../../types/aiPacks';
import { CeilingChip, LoadError, STATUS_NAMES } from '../aiUi';
import { EditPackModal, ImportPackModal, MakeMemberModal } from './PackDialogs';
import { WRITES_LABEL, downloadJson, limitsLabel, modelLabel, toolsLabel } from './packLabels';
import './packs.css';

/** Role packs: the table of eight ready-made roles and the project's own, and one pack's detail. */
export function PackLibrary({ projectId }: { projectId: string }) {
  const q = usePacks(projectId);
  const del = useDeletePack(projectId);
  const [sel, setSel] = useState<string | null>(null);
  const [edit, setEdit] = useState<Pack | null>(null);
  const [importing, setImporting] = useState(false);
  const [making, setMaking] = useState<Pack | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  if (q.isLoading)
    return <div className="ai-skel" style={{ height: 120 }} aria-busy="true" aria-label="Loading packs" />;
  if (q.error || !q.data) return <LoadError what="the role packs" error={q.error} onRetry={() => void q.refetch()} />;
  const packs = q.data;
  const open = packs.find((p) => p.key === sel) ?? null;

  const doExport = async (p: Pack) => {
    setExportError(null);
    try {
      const data = await packsApi.export(projectId, p.key);
      downloadJson(`${p.key}-v${data.version}.pack.json`, data);
    } catch (e) {
      setExportError(extractError(e));
    }
  };

  return (
    <div className="pk-wrap" data-testid="pack-library">
      <div className="pk-head">
        <h3>Role packs: eight AIs you do not have to invent</h3>
        <span className="pk-grow" />
        <button className="ai-btn ai-btn-sm" onClick={() => setImporting(true)}>
          Import
        </button>
      </div>
      <div className="ai-sub">
        A pack is everything that makes an AI a role, in one object you can export, import and version.
      </div>
      {note && (
        <div className="ai-notice ai-notice-info" role="status">
          {note}
        </div>
      )}
      {packs.length === 0 ? (
        <div className="ai-notice ai-notice-slate">No packs yet.</div>
      ) : (
        <div className="pk-cards" data-testid="pack-table">
          {packs.map((p) => (
            <div
              key={p.id}
              className={`pk-card${sel === p.key ? ' pk-card-on' : ''}`}
              data-testid={`pack-row-${p.key}`}
              onClick={() => setSel(p.key)}
            >
              <div className="pk-role">
                <span className="pk-glyph" aria-hidden="true">
                  {p.glyph}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <button
                    type="button"
                    className="pk-name"
                    aria-pressed={sel === p.key}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSel(p.key);
                    }}
                  >
                    {p.name}
                  </button>
                  <div className="pk-tag">{p.tagline}</div>
                </div>
                {!p.builtin && <span className="ai-chip pk-own">Project copy v{p.version}</span>}
              </div>
              <dl className="pk-fields">
                <dt>Model</dt>
                <dd>{modelLabel(p)}</dd>
                <dt>Writes</dt>
                <dd>{WRITES_LABEL[p.writes] ?? p.writes}</dd>
                <dt>Hands in</dt>
                <dd>{p.handsIn}</dd>
                <dt>Ceiling</dt>
                <dd>
                  <CeilingChip ceiling={p.ceiling} />
                </dd>
                <dt>Tools</dt>
                <dd>{toolsLabel(p)}</dd>
              </dl>
            </div>
          ))}
        </div>
      )}

      {open && (
        <div className="pk-detail" data-testid="pack-detail">
          <h4>{open.name} — what is in the pack</h4>
          <div className="ai-sub">Everything here travels together when the pack is exported.</div>
          <dl className="pk-dl">
            <dt>Who it is</dt>
            <dd>{open.persona}</dd>
            <dt>Model and effort</dt>
            <dd>{modelLabel(open)}</dd>
            <dt>Tools</dt>
            <dd>
              {toolsLabel(open)}
              {open.allow.length > 0 && <div className="pk-tag pk-cmd">{open.allow.join(' · ')}</div>}
            </dd>
            <dt>Permissions and ceiling</dt>
            <dd>
              The {open.template} template; <CeilingChip ceiling={open.ceiling} />{' '}
              {open.ceiling === 'none'
                ? 'It may not move a ticket.'
                : `It may move a ticket as far as ${STATUS_NAMES[open.ceiling] ?? open.ceiling} and no further.`}{' '}
              Changing an assignee needs approval; deleting a ticket is never allowed.
            </dd>
            <dt>Where it may write</dt>
            <dd>{WRITES_LABEL[open.writes] ?? open.writes}</dd>
            <dt>What it must hand in</dt>
            <dd>{open.handsIn}</dd>
            <dt>Limits</dt>
            <dd>{limitsLabel(open)}, and the project’s own per-account ceiling above that.</dd>
            {open.personas && open.personas.length > 0 && (
              <>
                <dt>Plays</dt>
                <dd>A persona you pick: {open.personas.join(', ')}…</dd>
              </>
            )}
            <dt>Version</dt>
            <dd>
              {open.builtin ? 'Ready-made' : `v${open.version}`}
              {open.updatedBy ? ` · changed by ${open.updatedBy}` : ''}
            </dd>
            <dt>Which member does it</dt>
            <dd>
              The step names the role. With two on the project, it goes to the one that is free, and when both are free
              to the one that already worked on this ticket.
            </dd>
          </dl>
          <div className="pk-actions">
            <button className="ai-btn ai-btn-sm" onClick={() => void doExport(open)}>
              Export
            </button>
            <button className="ai-btn ai-btn-sm" onClick={() => setEdit(open)}>
              Edit
            </button>
            <button className="ai-btn ai-btn-primary ai-btn-sm" onClick={() => setMaking(open)}>
              Make a member from it
            </button>
            {!open.builtin && (
              <button
                className="ai-btn ai-btn-sm ai-btn-danger-outline"
                disabled={del.isPending}
                onClick={() =>
                  del.mutate(open.key, { onSuccess: () => setNote(`${open.name} is back to the ready-made pack.`) })
                }
              >
                Back to ready-made
              </button>
            )}
            {(exportError || del.error) && (
              <span className="ai-error-text" role="alert">
                {exportError ?? extractError(del.error)}
              </span>
            )}
          </div>
        </div>
      )}

      {edit && (
        <EditPackModal
          projectId={projectId}
          pack={edit}
          onClose={() => setEdit(null)}
          onSaved={(p) => {
            setEdit(null);
            setSel(p.key);
            setNote(`${p.name} saved as version ${p.version}.`);
          }}
        />
      )}
      {importing && (
        <ImportPackModal
          projectId={projectId}
          onClose={() => setImporting(false)}
          onDone={(r) => {
            setImporting(false);
            setSel(r.pack.key);
          }}
        />
      )}
      {making && (
        <MakeMemberModal
          projectId={projectId}
          pack={making}
          onClose={() => setMaking(null)}
          onDone={(name) => {
            setMaking(null);
            setNote(`${name} is on the team.`);
          }}
        />
      )}
    </div>
  );
}
