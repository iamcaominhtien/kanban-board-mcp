import { useState } from 'react';
import { useMemberPack, useMemberPackChange, useMemberPackDiff, usePacks } from '../../../api/aiPacks';
import { extractError } from '../../../api/extractError';
import type { MemberPackDiff } from '../../../types/aiPacks';
import { Dialog } from '../config/parts';
import { Ico } from '../settings/settingsUi';
import { roleLook } from '../roleLook';
import './packs.css';

const time = (iso?: string | null) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
};

type Line = { kind: 'same' | 'out' | 'in'; text: string };

/** The lines of `before` and `after`, each kept, dropped or added, in order (a longest-common-subsequence diff). */
export function lineDiff(before: string, after: string): Line[] {
  const split = (s: string) =>
    s
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  const a = split(before);
  const b = split(after);
  // lcs[i][j]: the longest common run of a[i:] and b[j:]
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: Line[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] });
      i++;
      j++;
    } else if (j >= b.length || (i < a.length && lcs[i + 1][j] >= lcs[i][j + 1])) {
      out.push({ kind: 'out', text: a[i] });
      i++;
    } else {
      out.push({ kind: 'in', text: b[j] });
      j++;
    }
  }
  return out;
}

/** "Update Designer Dao to Designer v3": what the update changes, what stays, then Update. */
function DiffDialog({
  memberName,
  packName,
  diff,
  loading,
  error,
  busy,
  onClose,
  onUpdate,
}: {
  memberName: string;
  packName: string;
  diff: MemberPackDiff | undefined;
  loading: boolean;
  error: string | null;
  busy: boolean;
  onClose: () => void;
  onUpdate: () => void;
}) {
  const to = diff?.to;
  return (
    <Dialog
      title={`Update ${memberName} to ${packName}${to ? ` v${to}` : ''}`}
      sub="The pack changed since this member was made. Read what is different before you take it."
      width={640}
      testId="pack-diff"
      onClose={onClose}
      foot={
        <>
          <span className="ai-hint" style={{ flex: 1, fontSize: 11.5 }}>
            It takes effect from the next run, in a new conversation.
          </span>
          <button type="button" className="ai-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="ai-btn ai-btn-primary"
            disabled={!diff || busy}
            data-testid="pack-diff-update"
            onClick={onUpdate}
          >
            <Ico name="update" />
            Update{to ? ` to v${to}` : ''}
          </button>
        </>
      }
    >
      {loading && <div className="ai-skel" style={{ height: 120 }} aria-busy="true" aria-label="Loading the changes" />}
      {diff && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="pk-h">What changes</span>
            <span className="ai-hint" style={{ fontSize: 11.5 }}>
              pack v{diff.version} → v{diff.to}
            </span>
          </div>
          {diff.changes.length === 0 && (
            <div className="ai-hint" data-testid="pack-diff-none">
              Nothing in the pack changes this member.
            </div>
          )}
          {diff.changes.map((c) => (
            <div key={c.field} className="pk-diff" data-testid={`pack-diff-${c.field}`}>
              <div className="pk-diff-label">{c.label}</div>
              {lineDiff(c.before, c.after).map((l, i) => (
                <div key={i} className={`pk-diff-line pk-diff-${l.kind}`}>
                  <b aria-hidden="true">{l.kind === 'out' ? '−' : l.kind === 'in' ? '+' : ''}</b>
                  <span>{l.text}</span>
                </div>
              ))}
            </div>
          ))}
          <div className="ai-divider" />
          {diff.kept.length > 0 && (
            <div className="pk-kept" data-testid="pack-diff-kept">
              <span className="pk-kept-box" aria-hidden="true">
                <Ico name="tick" size={11} color="#fff" />
              </span>
              <span>
                <b>Stays as it is:</b> {diff.kept.join(', ').replace(/, ([^,]*)$/, ', and $1')}.
              </span>
            </div>
          )}
          {diff.edited && (
            <div className="pk-warn" role="note" data-testid="pack-diff-edited">
              <Ico name="warn" />
              <span>
                <b>You edited this member’s instructions.</b> The update replaces them with the pack’s. They stay in the
                version you can go back to.
              </span>
            </div>
          )}
        </>
      )}
      {error && (
        <div className="ai-notice ai-notice-error" role="alert">
          {error}
        </div>
      )}
    </Dialog>
  );
}

/**
 * Role pack on a member made from one (design/screens/ai-story-flow.md, Q1): a newer version is out, what it changes,
 * Update, and the way back for 30 days. Nothing is drawn for a member not made from a pack.
 */
export function MemberPackCard({
  memberId,
  memberName,
  projectId,
}: {
  memberId: string;
  memberName: string;
  projectId: string;
}) {
  const q = useMemberPack(memberId);
  const packs = usePacks(projectId);
  const change = useMemberPackChange(memberId);
  const [open, setOpen] = useState(false);
  const diff = useMemberPackDiff(memberId, open);
  const [error, setError] = useState<string | null>(null);
  const mp = q.data;
  if (!mp) return null;
  const pack = packs.data?.find((p) => p.key === mp.key);
  const name = mp.name ?? pack?.name ?? mp.key;
  const look = roleLook(mp.key);
  const history = mp.history ?? [];
  const back = history[0];

  const run = (action: 'update' | 'revert') => {
    setError(null);
    change.mutate(action, {
      onSuccess: () => setOpen(false),
      onError: (e) => setError(extractError(e)),
    });
  };

  return (
    <div className="ai-card pk-member" data-testid="member-pack" data-member={memberId}>
      <div className="pk-member-box">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <b style={{ fontSize: 13.5 }}>Role pack</b>
          <span style={{ flex: 1 }} />
          {mp.outdated && mp.latest != null ? (
            <span className="ai-chip" style={{ background: '#FEF3D9', color: '#7A5A06' }} data-testid="pack-out">
              <Ico name="update" size={12} />v{mp.latest} is out
            </span>
          ) : mp.latest == null ? (
            <span className="ai-chip" style={{ background: '#F1F3F1', color: '#5B6B60' }}>
              The pack is gone
            </span>
          ) : (
            <span className="ai-chip" style={{ background: '#E6F2EA', color: '#1F5A31' }}>
              Up to date
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span
            className="pk-member-glyph"
            style={{ background: look.bg, color: look.fg, borderColor: look.border }}
            aria-hidden="true"
          >
            {pack?.glyph ?? look.glyph}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <b style={{ fontSize: 13 }}>{name}</b>{' '}
            <span className="ai-hint">
              {pack?.builtin ? 'ready-made · ' : ''}
              {history.length ? `v${mp.version}` : `made from v${mp.version}`}
            </span>
            {pack?.tagline && <div className="ai-hint">{pack.tagline}</div>}
          </div>
        </div>
        {mp.outdated && mp.latest != null && (
          <>
            <div style={{ fontSize: 12.5, lineHeight: 1.5, color: '#3A4A3E' }}>
              v{mp.latest} of the pack is out. A member keeps the version it was made from until you update it.
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="ai-btn ai-btn-sm" data-testid="pack-see" onClick={() => setOpen(true)}>
                <Ico name="eye" />
                See what changes
              </button>
              <button
                type="button"
                className="ai-btn ai-btn-sm ai-btn-primary"
                data-testid="pack-update"
                disabled={change.isPending}
                onClick={() => run('update')}
              >
                <Ico name="update" />
                Update to v{mp.latest}
              </button>
            </div>
          </>
        )}
      </div>
      {back && (
        <div className="pk-member-box pk-member-done" data-testid="pack-updated">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <b style={{ fontSize: 13 }}>Updated to v{mp.version}</b>
            <span style={{ flex: 1 }} />
            <span className="ai-chip" style={{ background: '#E6F2EA', color: '#1F5A31' }}>
              <Ico name="tick" size={12} />
              Done
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 200, fontSize: 12.5, lineHeight: 1.5 }}>
              <b>
                {name} v{mp.version}
              </b>{' '}
              · updated{back.by ? ` by ${back.by}` : ''}
              {time(back.at) ? `, ${time(back.at)}` : ''}. The next run starts a new conversation.
            </div>
            <button
              type="button"
              className="ai-btn ai-btn-sm"
              data-testid="pack-revert"
              disabled={change.isPending}
              onClick={() => run('revert')}
            >
              <Ico name="back" />
              Go back to v{back.version}
            </button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }} data-testid="pack-history">
            <span className="ai-hint" style={{ fontSize: 11.5 }}>
              Version history of this member:
            </span>
            <span className="ai-chip" style={{ background: '#E6F2EA', color: '#1F5A31' }}>
              v{mp.version} now
            </span>
            {history.map((h, i) => (
              <span key={`${h.version}-${i}`} className="ai-chip" style={{ background: '#F1F3F1', color: '#3A4A3E' }}>
                v{h.version} {i === history.length - 1 ? 'made from' : 'earlier'}, kept 30 days
              </span>
            ))}
          </div>
        </div>
      )}
      {error && !open && (
        <div className="ai-error-text" role="alert">
          {error}
        </div>
      )}
      {open && (
        <DiffDialog
          memberName={memberName}
          packName={name}
          diff={diff.data}
          loading={diff.isLoading}
          error={error ?? (diff.error ? extractError(diff.error) : null)}
          busy={change.isPending}
          onClose={() => {
            setOpen(false);
            setError(null);
          }}
          onUpdate={() => run('update')}
        />
      )}
    </div>
  );
}
