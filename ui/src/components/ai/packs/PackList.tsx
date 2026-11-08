import { useEffect, useRef, useState } from 'react';
import type { RolePack } from '../../../types/aiPacks';
import { LineIcon } from '../../ui/LineIcon';
import { roleLook } from '../roleLook';
import { modelEffort, packState, READY_MADE_KEYS, toolsOf, writesLabel } from './packLogic';

/** The two-letter chip of a role, in the colours of its role. */
export function PackGlyph({ pack, large }: { pack: Pick<RolePack, 'key' | 'glyph'>; large?: boolean }) {
  const look = roleLook(pack.key);
  return (
    <span
      className={`rp-glyph ${large ? 'rp-glyph-lg' : ''}`}
      style={{ background: look.bg, color: look.fg, borderColor: look.border + '55' }}
      aria-hidden="true"
    >
      {pack.glyph || look.glyph}
    </span>
  );
}

/** Ready-made, Edited · v3 or This project's own · v1. */
export function PackStateChip({ pack }: { pack: RolePack }) {
  const s = packState(pack);
  return (
    <span className={`rp-state rp-state-${s.kind}`} data-testid={`pack-state-${pack.key}`}>
      {s.label}
    </span>
  );
}

export interface PackActions {
  onEdit: (p: RolePack) => void;
  onExport: (p: RolePack) => void;
  onReset: (p: RolePack) => void;
  onRemove: (p: RolePack) => void;
}

/** The ⋯ of a row: edit, export, and put back (an edited ready-made role) or remove (the project's own). */
function RowMenu({ pack, actions }: { pack: RolePack; actions: PackActions }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  const edited = !pack.builtin && READY_MADE_KEYS.includes(pack.key);
  const own = !pack.builtin && !READY_MADE_KEYS.includes(pack.key);
  const pick = (fn: (p: RolePack) => void) => () => {
    setOpen(false);
    fn(pack);
  };
  return (
    <span className="rp-more" ref={ref} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="ai-icobtn"
        aria-label={`More for ${pack.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        data-testid={`pack-more-${pack.key}`}
      >
        <LineIcon name="more" size={16} />
      </button>
      {open && (
        <div className="ai-menu" role="menu">
          <button type="button" role="menuitem" className="ai-mi" onClick={pick(actions.onEdit)}>
            <LineIcon name="edit" size={14} />
            Edit
          </button>
          <button type="button" role="menuitem" className="ai-mi" onClick={pick(actions.onExport)}>
            <LineIcon name="download" size={14} />
            Export
          </button>
          {edited && (
            <button type="button" role="menuitem" className="ai-mi ai-mi-danger" onClick={pick(actions.onReset)}>
              <LineIcon name="undo" size={14} />
              Reset to ready-made
            </button>
          )}
          {own && (
            <button type="button" role="menuitem" className="ai-mi ai-mi-danger" onClick={pick(actions.onRemove)}>
              <LineIcon name="trash" size={14} />
              Remove
            </button>
          )}
        </div>
      )}
    </span>
  );
}

/** The packs: one row per role. */
export function PackList({ packs, actions }: { packs: RolePack[]; actions: PackActions }) {
  return (
    <div className="rp-list" data-testid="pack-list">
      <table className="ai-table">
        <thead>
          <tr>
            <th>Role</th>
            <th>Model</th>
            <th>Writes</th>
            <th className="rp-col-tools">Plugins</th>
            <th>State</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {packs.map((p) => {
            const tools = toolsOf(p);
            return (
              <tr
                key={p.key}
                className={`rp-row ${packState(p).kind === 'edited' ? 'rp-row-edited' : ''}`}
                data-testid={`pack-row-${p.key}`}
                onClick={() => actions.onEdit(p)}
              >
                <td>
                  <div className="rp-role">
                    <PackGlyph pack={p} />
                    <div className="rp-role-text">
                      <button
                        type="button"
                        className="rp-role-name"
                        onClick={(e) => {
                          e.stopPropagation();
                          actions.onEdit(p);
                        }}
                      >
                        {p.name}
                      </button>
                      <span className="rp-role-tag" title={p.tagline}>
                        {p.tagline}
                      </span>
                      {tools.length > 0 && <span className="rp-role-tools rp-mono">{tools.join(', ')}</span>}
                    </div>
                  </div>
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>{modelEffort(p)}</td>
                <td>{writesLabel(p.writes)}</td>
                <td className="rp-col-tools">
                  {tools.length ? <span className="rp-mono">{tools.join(', ')}</span> : '—'}
                </td>
                <td>
                  <PackStateChip pack={p} />
                </td>
                <td style={{ textAlign: 'right' }}>
                  <RowMenu pack={p} actions={actions} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
