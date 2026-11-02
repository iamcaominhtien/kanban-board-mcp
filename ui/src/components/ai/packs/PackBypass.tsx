import { useState } from 'react';
import { extractError } from '../../../api/extractError';
import type { AiMember } from '../../../types/ai';
import type { Pack, PackDraft, PackPermissionMode } from '../../../types/aiPacks';
import { BYPASS_PHRASE, Dialog } from '../config/parts';
import { Ico } from '../settings/settingsUi';
import './packs.css';

/** How a member made from the pack runs: its own mode, else Bypass permissions, except Triage (it only reads and
 * sorts, so the allow list). */
export function packMode(p: Pick<Pack, 'key' | 'permissionMode'>): PackPermissionMode {
  return p.permissionMode ?? (p.key === 'triage' ? 'allowlist' : 'bypass');
}

/** The pack as a body for PUT /packs/{key}, with another permission mode. */
export function packBody(p: Pack, mode: PackPermissionMode): PackDraft {
  return {
    name: p.name,
    glyph: p.glyph,
    tagline: p.tagline,
    model: p.model,
    retryModel: p.retryModel ?? null,
    effort: p.effort,
    depthModels: p.depthModels ?? null,
    template: p.template,
    ceiling: p.ceiling,
    writes: p.writes,
    handsIn: p.handsIn,
    allow: p.allow,
    plugins: p.plugins,
    mcp: p.mcp,
    personas: p.personas ?? null,
    limits: p.limits,
    persona: p.persona,
    permissionMode: mode,
  };
}

/** The permission mode of a pack, as a chip; a button when it can be changed. */
export function ModeChip({ pack, locked, onClick }: { pack: Pack; locked: boolean; onClick: () => void }) {
  const bypass = packMode(pack) === 'bypass';
  return (
    <button
      type="button"
      className={`pk-mode ${bypass ? 'pk-mode-bypass' : 'pk-mode-allow'}`}
      data-testid={`pack-mode-${pack.key}`}
      disabled={locked && !bypass}
      title={
        bypass
          ? 'Back to the allow list'
          : locked
            ? 'Only the project owner can turn on Bypass permissions.'
            : 'Turn on Bypass permissions'
      }
      onClick={onClick}
    >
      <Ico name={bypass ? 'shield' : 'tick'} size={12} />
      {bypass ? 'Bypass permissions' : 'Allow list only'}
    </button>
  );
}

/** "Turn on Bypass permissions for the Reviewer pack": the same warning and typed phrase as on a member. */
export function PackBypassDialog({
  pack,
  members,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  pack: Pack;
  /** The AI members made from this pack. */
  members: AiMember[];
  busy: boolean;
  error: unknown;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState('');
  const ok = typed.trim().toLowerCase() === BYPASS_PHRASE;
  const narrow = pack.writes === 'nothing' || pack.writes === 'ticket';
  const onAllow = members.filter((m) => (m.config as { permissionMode?: string })?.permissionMode !== 'bypass');
  return (
    <Dialog
      title={`Turn on Bypass permissions for the ${pack.name} pack`}
      sub={narrow ? `${pack.name} does not change the code. It does not need this to do its job.` : undefined}
      width={470}
      testId="pack-bypass"
      onClose={onClose}
      foot={
        <>
          <button type="button" className="ai-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="ai-btn ai-btn-danger-outline"
            disabled={!ok || busy}
            data-testid="pack-bypass-on"
            onClick={onConfirm}
          >
            <Ico name="shield" />
            Turn on Bypass
          </button>
        </>
      }
    >
      <div className="pk-danger" data-testid="pack-bypass-warning">
        <Ico name="shield" />
        <span>
          <b>Bypass permissions runs shell commands and edits files on this computer without asking.</b> Still in force:
          the Deny rules, the board’s own ceiling and approvals, and Safe mode (it overrides Bypass). The web is open,
          as in your own Claude Code; a site you denied stays denied, and Safe mode still blocks the web. Use it in a
          folder you can restore from git.
        </span>
      </div>
      <div className="pk-kept">
        <span className="pk-kept-box" aria-hidden="true">
          <Ico name="tick" size={11} color="#fff" />
        </span>
        <span>
          <b>Members made from this pack follow it</b> after you update them.
          {onAllow.length > 0 &&
            ` ${onAllow.map((m) => m.name).join(', ')} ${onAllow.length === 1 ? 'is' : 'are'} on the allow list now and ${
              onAllow.length === 1 ? 'stays' : 'stay'
            } there until you do.`}
        </span>
      </div>
      <div className="ai-hint">Only for work runs. A run that only answers a question never uses it.</div>
      <label className="ai-field">
        <span className="ai-label ai-label-dark">Type “{BYPASS_PHRASE}” to confirm</span>
        <input
          className="ai-input"
          style={{ fontFamily: "'JetBrains Mono', monospace" }}
          value={typed}
          placeholder={BYPASS_PHRASE}
          data-testid="pack-bypass-confirm"
          onChange={(e) => setTyped(e.target.value)}
        />
        <span className="ai-hint" style={{ fontSize: 11.5 }}>
          Only the project owner can turn it on. The setting applies to the member in every project it is in.
        </span>
      </label>
      {!!error && (
        <div className="ai-notice ai-notice-error" role="alert">
          {extractError(error)}
        </div>
      )}
    </Dialog>
  );
}
