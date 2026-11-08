import { useEffect, useRef, useState } from 'react';
import { LineIcon } from '../../ui/LineIcon';
import { aiPluginsApi, usePluginMutation } from '../../../api/aiPlugins';
import { extractError } from '../../../api/extractError';
import type { Plugin, PluginAction, PluginChanges, UpdateCheck } from '../../../types/aiPlugins';
import { ago, Toggle, useAiBoardState } from '../aiUi';
import { ROLES, applyFilter, buildRows, countOf, mb, roleName, type Filter } from './pluginLogic';
import { BoardSkillsCard } from './BoardSkillsCard';

export const TAKES_EFFECT = 'Every change takes effect from the next run.';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'plugins', label: 'Plugins' },
  { key: 'never', label: 'Never used' },
];

function sourceLabel(p: Plugin) {
  return { git: 'Git URL', marketplace: 'Marketplace', folder: 'Imported from a folder' }[p.sourceKind];
}

function PluginRow({ p, projectId }: { p: Plugin; projectId: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [update, setUpdate] = useState<UpdateCheck | null>(null);
  const [changes, setChanges] = useState<PluginChanges | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!menu) return;
    const away = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [menu]);
  const pick = (fn: () => Promise<unknown> | void) => {
    setMenu(false);
    void fn();
  };
  const act = usePluginMutation(projectId, (a: PluginAction) => aiPluginsApi.act(p.id, a));
  const patch = usePluginMutation(projectId, (b: { defaultOn?: boolean; roles?: string[] }) =>
    aiPluginsApi.patch(p.id, b),
  );
  const del = usePluginMutation(projectId, (_: void) => aiPluginsApi.remove(p.id));

  const guard = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(extractError(e));
    } finally {
      setBusy(null);
    }
  };
  const doAct = (a: PluginAction) =>
    guard(a, async () => {
      await act.mutateAsync(a);
      setUpdate(null);
      setChanges(null);
    });
  const { members } = useAiBoardState();
  const uses = p.used?.uses ?? 0;
  const usedBy = (p.used?.byMember ?? [])
    .map((m) => members.get(m.memberId)?.name)
    .filter((n): n is string => !!n)
    .join(', ');

  return (
    <div className="ai-card" data-testid={`plugin-${p.name}`} style={{ padding: 12, display: 'grid', gap: 6 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <b style={{ fontSize: 13.5 }}>{p.name}</b>
        <span className="ai-chip">Plugin</span>
        {p.pinned && (
          <span className="ai-chip" style={{ background: '#E6EEF8', color: '#3B5A8A' }}>
            Pinned
          </span>
        )}
        {busy === 'check' && (
          <span className="ai-chip" role="status">
            <span className="ai-spin" aria-hidden="true" /> Checking…
          </span>
        )}
        <span className="ai-hint" style={{ flex: 1 }}>
          {sourceLabel(p)} · {p.skills.length} skills
          {p.description ? ` · ${p.description}` : ''}
        </span>
      </div>
      <div className="ai-hint" style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <span>{p.source}</span>
        <span data-testid="version">
          {p.version ? `v${p.version.replace(/^v/, '')}` : ''}
          {p.commit ? ` · ${p.commit.slice(0, 8)}` : ''}
          {p.pinned ? ' · pinned' : ''}
          {update?.update && update.latest ? ` → ${update.latest}` : ''}
        </span>
        <span data-testid="used">
          {uses === 0 ? 'never used' : `used ${uses} times${usedBy ? ` by ${usedBy}` : ''}`}
        </span>
        <span>
          On by default: {p.defaultOn ? 'every team' : p.roles.length ? p.roles.map(roleName).join(', ') : 'nobody'}
        </span>
        {p.updatedAt && <span>updated {ago(p.updatedAt)}</span>}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {update?.update && (
          <>
            <button className="ai-btn ai-btn-sm ai-btn-primary" disabled={!!busy} onClick={() => void doAct('update')}>
              {busy === 'update' ? 'Updating…' : 'Update'}
            </button>
            <button
              className="ai-btn ai-btn-sm"
              disabled={!!busy}
              onClick={() => void guard('changes', async () => setChanges(await aiPluginsApi.changes(p.id)))}
            >
              See what changed
            </button>
          </>
        )}
        <button className="ai-btn ai-btn-sm" aria-expanded={open} onClick={() => setOpen(!open)}>
          Open
        </button>
        {p.pinned && (
          <button className="ai-btn ai-btn-sm" disabled={!!busy} onClick={() => void doAct('unpin')}>
            Unpin
          </button>
        )}
        {p.sourceKind === 'folder' && !p.pinned && (
          <>
            <button className="ai-btn ai-btn-sm" disabled={!!busy} onClick={() => void doAct('reload')}>
              {busy === 'reload' ? 'Reloading…' : 'Reload'}
            </button>
            <button
              className="ai-btn ai-btn-sm"
              disabled={!!busy}
              onClick={() => void guard('check', async () => setUpdate(await aiPluginsApi.checkUpdate(p.id)))}
            >
              Check for update
            </button>
          </>
        )}
        <span style={{ position: 'relative' }} ref={menuRef}>
          <button
            className="ai-btn ai-btn-sm"
            aria-label={`More actions for ${p.name}`}
            aria-haspopup="menu"
            aria-expanded={menu}
            disabled={!!busy}
            onClick={() => setMenu(!menu)}
            data-testid="plugin-more"
          >
            ⋯
          </button>
          {menu && (
            <div className="ai-menu" role="menu" style={{ left: 0, top: 30 }}>
              {p.sourceKind !== 'folder' && (
                <button role="menuitem" className="ai-mi" onClick={() => pick(() => doAct('reload'))}>
                  Reload
                </button>
              )}
              <button role="menuitem" className="ai-mi" onClick={() => pick(() => doAct('reset'))}>
                Reset
              </button>
              {(p.sourceKind !== 'folder' || p.pinned) && (
                <button
                  role="menuitem"
                  className="ai-mi"
                  onClick={() =>
                    pick(() => guard('check', async () => setUpdate(await aiPluginsApi.checkUpdate(p.id))))
                  }
                >
                  Check for update
                </button>
              )}
              {!p.pinned && (
                <button role="menuitem" className="ai-mi" onClick={() => pick(() => doAct('pin'))}>
                  Pin{p.version ? ` v${p.version.replace(/^v/, '')}` : ''}
                </button>
              )}
              {p.hasPrevious && (
                <button role="menuitem" className="ai-mi" onClick={() => pick(() => doAct('rollback'))}>
                  Roll back
                </button>
              )}
              <button
                role="menuitem"
                className="ai-mi"
                style={{ color: '#c4432a' }}
                onClick={() => pick(async () => setConfirmRemove(true))}
              >
                Remove
              </button>
            </div>
          )}
        </span>
        {update && !update.update && <span className="ai-hint">Up to date.</span>}
        {confirmRemove && (
          <>
            <span className="ai-hint">Remove {p.name}?</span>
            <button
              className="ai-btn ai-btn-sm ai-btn-danger"
              data-testid="confirm-remove"
              disabled={!!busy}
              onClick={() => void guard('remove', () => del.mutateAsync())}
            >
              Remove
            </button>
            <button className="ai-btn ai-btn-sm" onClick={() => setConfirmRemove(false)}>
              Keep
            </button>
          </>
        )}
        {busy && busy !== 'check' && <span className="ai-spin" role="status" aria-label="Working" />}
      </div>
      {error && (
        <div className="ai-notice ai-notice-error" role="alert" data-testid="plugin-error">
          {error}
        </div>
      )}
      {changes && (
        <div className="ai-notice ai-notice-info" data-testid="plugin-changes" style={{ display: 'grid', gap: 2 }}>
          <b>Changes{changes.commit ? ` in ${changes.commit.slice(0, 8)}` : ''}</b>
          {changes.added.length + changes.removed.length + changes.changed.length === 0 && (
            <span>No file changed.</span>
          )}
          {changes.added.map((f) => (
            <span key={`a${f}`}>+ {f}</span>
          ))}
          {changes.removed.map((f) => (
            <span key={`r${f}`}>− {f}</span>
          ))}
          {changes.changed.map((f) => (
            <span key={`c${f}`}>~ {f}</span>
          ))}
        </div>
      )}
      {open && (
        <div style={{ display: 'grid', gap: 6, fontSize: 12.5 }} data-testid="plugin-detail">
          <div>
            {p.skills.length} skills{p.skills.length ? `: ${p.skills.join(', ')}` : ''} · {countOf(p.hooks)} hooks ·{' '}
            {countOf(p.mcp)} MCP servers{p.sizeBytes ? ` · ${mb(p.sizeBytes)}` : ''}
          </div>
          <Toggle
            label="On for every team"
            on={p.defaultOn}
            disabled={patch.isPending}
            onChange={(v) => void guard('patch', () => patch.mutateAsync({ defaultOn: v }))}
          />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            <span className="ai-label">Suggested for</span>
            {Object.entries(ROLES).map(([k, name]) => {
              const on = p.roles.includes(k);
              return (
                <button
                  key={k}
                  type="button"
                  aria-pressed={on}
                  className={`tw-chipbtn ${on ? 'tw-chipbtn-on' : ''}`}
                  disabled={patch.isPending}
                  onClick={() =>
                    void guard('patch', () =>
                      patch.mutateAsync({ roles: on ? p.roles.filter((r) => r !== k) : [...p.roles, k] }),
                    )
                  }
                >
                  {name}
                </button>
              );
            })}
          </div>
          {(p.used?.byMember ?? []).length > 0 && (
            <div className="ai-hint">
              Used by {p.used.byMember.length} {p.used.byMember.length === 1 ? 'team' : 'teams'}.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The installed list with its filters (B1). */
export function InstalledTab({ projectId, plugins }: { projectId: string; plugins: Plugin[] }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const rows = buildRows(plugins);
  const needle = q.trim().toLowerCase();
  const shown = applyFilter(rows, filter).filter((r) => !needle || r.name.toLowerCase().includes(needle));
  return (
    <div style={{ display: 'grid', gap: 10 }} data-testid="installed-tab">
      <BoardSkillsCard projectId={projectId} />
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {/* B: a search field beside the filter chips */}
        <label className="ai-search-field" style={{ width: 220 }}>
          <LineIcon name="search" size={14} color="#9AA8A0" />
          <input
            placeholder="Search skills and plugins…"
            aria-label="Search installed"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            data-testid="installed-search"
          />
        </label>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }} role="group" aria-label="Filter">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              className={`ai-btn ai-btn-sm${filter === f.key ? ' ai-btn-primary' : ''}`}
              aria-pressed={filter === f.key}
              onClick={() => setFilter(f.key)}
            >
              {f.label} {applyFilter(rows, f.key).length}
            </button>
          ))}
        </div>
      </div>
      {shown.length === 0 ? (
        <div className="ai-hint" data-testid="installed-empty">
          {rows.length === 0
            ? 'Nothing installed yet. Pick one from the suggestions, or add one from a source.'
            : needle
              ? 'Nothing matches this search.'
              : 'Nothing matches this filter.'}
        </div>
      ) : (
        shown.map((r) => <PluginRow key={r.id} p={r.plugin} projectId={projectId} />)
      )}
      {/* B: the two notes as cards (green, amber) */}
      <div className="tl-callouts">
        <div className="tl-callout tl-callout-amber">
          <b>Nothing checks it for you, and no pretending otherwise.</b> Installing from the internet runs other
          people’s code on your machine. The board records the source and the commit, shows the diff before an update,
          and keeps one button back to the version that worked.
        </div>
      </div>
    </div>
  );
}
