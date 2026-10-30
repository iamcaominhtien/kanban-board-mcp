import { useEffect, useState } from 'react';
import { assistApi, assistError, useDraft } from '../../api/assist';
import { extractError } from '../../api/extractError';
import type { AssistDraft, ProposedMember } from '../../types/assist';
import { hhmm } from '../ai/aiUi';
import { DraftTag } from './assistUi';

const TEMPLATES: { id: ProposedMember['template']; label: string; hint: string }[] = [
  { id: 'developer', label: 'Developer', hint: 'Works on tickets and may change code' },
  { id: 'reviewer', label: 'Reviewer', hint: 'Reads and comments; edits wait for approval' },
  { id: 'read_only', label: 'Read-only', hint: 'Reads and comments only' },
];
const CEILINGS: { id: ProposedMember['ceiling']; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'backlog', label: 'Backlog' },
  { id: 'todo', label: 'To Do' },
  { id: 'in-progress', label: 'In Progress' },
  { id: 'review', label: 'Review' },
];

/** The Board AI's proposal to create AI members: every field is editable, nothing exists until Create, and the
 * members are made as the person who presses it (an admin). */
export function DraftAiMembers({ draftId, initial }: { draftId: string; initial?: AssistDraft | null }) {
  const q = useDraft(draftId);
  const d = q.data ?? initial ?? null;
  const [members, setMembers] = useState<ProposedMember[] | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [open, setOpen] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const proposed = d?.payload.members;
  useEffect(() => {
    if (members === null && proposed?.length) {
      setMembers(proposed.map((m) => ({ ...m })));
      setPicked(new Set(proposed.map((_, i) => i)));
    }
  }, [members, proposed]);

  if (!d) return <div className="as-skel" style={{ height: 80 }} />;
  const list = members ?? proposed ?? [];
  const edit = (i: number, patch: Partial<ProposedMember>) =>
    setMembers((cur) => (cur ?? list).map((m, k) => (k === i ? { ...m, ...patch } : m)));

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await q.refetch();
    } catch (e) {
      setError(assistError(e)?.detail ?? extractError(e));
    } finally {
      setBusy(false);
    }
  };

  if (d.status === 'applied' || d.status === 'undone') {
    const created = (d.result.created ?? []).map((c) => (typeof c === 'string' ? c : c.name));
    return (
      <div className="as-tile" data-testid="draft-result" style={{ gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: '#2E6F40', fontWeight: 700 }}>✓</span>
          <span style={{ flex: 1, fontSize: 13 }}>
            {d.status === 'undone' ? (
              <>Undone · the members this draft created were removed.</>
            ) : (
              <>
                <b>Created {created.join(', ')}</b> <span className="ai-muted">at {hhmm(d.appliedAt)}</span>
              </>
            )}
          </span>
          {d.status === 'applied' && (
            <button
              type="button"
              className="ai-btn ai-btn-sm"
              disabled={busy}
              onClick={() => void act(() => assistApi.undo(d.id))}
            >
              Undo
            </button>
          )}
        </div>
        {d.status === 'applied' && (
          <div className="ai-hint">Find them in Members → AI. They start idle; assign a ticket or @mention them.</div>
        )}
        {d.result.failed?.length ? (
          <div className="ai-error-text">
            Not created: {d.result.failed.map((f) => `${f.name} (${f.message})`).join('; ')}
          </div>
        ) : null}
        {error && <div className="ai-error-text">{error}</div>}
      </div>
    );
  }
  if (d.status === 'discarded' || d.status === 'expired')
    return <div className="ai-muted">Proposal {d.status}. Nothing was created.</div>;

  const n = [...picked].filter((i) => i < list.length).length;
  const refusal = d.payload.refusal;

  return (
    <div className="as-draft" data-testid="draft-ai-members">
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <DraftTag>AI members · {list.length}</DraftTag>
        <span style={{ flex: 1 }} />
        <span className="ai-muted" style={{ fontSize: 12 }}>
          Not created yet
        </span>
      </div>
      {list.map((m, i) => (
        <div key={i} className="as-member" data-testid={`proposed-member-${i}`}>
          <div className="as-member-head">
            <input
              type="checkbox"
              className="as-check"
              checked={picked.has(i)}
              aria-label={`Create ${m.name}`}
              onChange={() => {
                const next = new Set(picked);
                if (next.has(i)) next.delete(i);
                else next.add(i);
                setPicked(next);
              }}
            />
            <input
              className="ai-input as-member-name"
              value={m.name}
              aria-label="Name"
              onChange={(e) => edit(i, { name: e.target.value })}
            />
            <span className="ai-chip as-member-tpl">{TEMPLATES.find((t) => t.id === m.template)?.label}</span>
            <button type="button" className="ai-link" onClick={() => setOpen(open === i ? null : i)}>
              {open === i ? 'Hide details' : 'Edit details'}
            </button>
          </div>
          <input
            className="ai-input"
            value={m.description}
            aria-label="Short description"
            placeholder="Short description"
            onChange={(e) => edit(i, { description: e.target.value })}
          />
          {m.why && <div className="ai-hint">{m.why}</div>}
          {open === i && (
            <div className="as-member-more">
              <label className="ai-field">
                <span className="ai-label ai-label-dark">
                  Role / persona <span style={{ fontWeight: 500 }}>{m.persona.length} / 1000</span>
                </span>
                <textarea
                  className="ai-textarea"
                  rows={6}
                  value={m.persona}
                  maxLength={1000}
                  onChange={(e) => edit(i, { persona: e.target.value })}
                />
              </label>
              <div className="as-member-grid">
                <label className="ai-field">
                  <span className="ai-label ai-label-dark">Role template</span>
                  <select
                    className="ai-input"
                    value={m.template}
                    onChange={(e) => edit(i, { template: e.target.value as ProposedMember['template'] })}
                  >
                    {TEMPLATES.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label} · {t.hint}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="ai-field">
                  <span className="ai-label ai-label-dark">May move tickets up to</span>
                  <select
                    className="ai-input"
                    value={m.ceiling}
                    onChange={(e) => edit(i, { ceiling: e.target.value as ProposedMember['ceiling'] })}
                  >
                    {CEILINGS.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="ai-field">
                  <span className="ai-label ai-label-dark">Max parallel runs</span>
                  <input
                    className="ai-input"
                    type="number"
                    min={1}
                    max={10}
                    value={m.maxParallel}
                    onChange={(e) => edit(i, { maxParallel: Number(e.target.value) })}
                  />
                </label>
                <label className="ai-field">
                  <span className="ai-label ai-label-dark">Scheduled runs per day</span>
                  <input
                    className="ai-input"
                    type="number"
                    min={1}
                    max={500}
                    value={m.maxRunsPerDay}
                    onChange={(e) => edit(i, { maxRunsPerDay: Number(e.target.value) })}
                  />
                </label>
              </div>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={m.readOnlyCli}
                  onChange={(e) => edit(i, { readOnlyCli: e.target.checked })}
                />
                Never edit files (the CLI may only read, use git read commands
                {m.template === 'reviewer' ? ' and run tests' : ''})
              </label>
            </div>
          )}
        </div>
      ))}
      {d.payload.problems?.length ? (
        <div className="ai-muted">Changed or left out: {d.payload.problems.join(' ')}</div>
      ) : null}
      <div className="ai-hint">
        The connection (Claude Code, folder, model) is copied from {d.memberName || 'the AI that wrote this'}. No key,
        no Bypass permissions and nothing past Review can be set here. You can change everything later in Members.
      </div>
      {refusal && <div className="ai-notice ai-notice-warn">{refusal}</div>}
      {error && (
        <div className="ai-error-text" data-testid="draft-error">
          {error}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          className="ai-btn ai-btn-primary ai-btn-sm"
          disabled={busy || n === 0 || !!refusal}
          data-testid="create-ai-members"
          onClick={() =>
            void act(() => assistApi.apply(d.id, { selected: [...picked].sort(), fields: { members: list } }))
          }
        >
          {busy ? <span className="ai-spin" /> : null} Create {n} AI member{n !== 1 ? 's' : ''}
        </button>
        <button
          type="button"
          className="ai-btn ai-btn-sm"
          disabled={busy}
          onClick={() => void act(() => assistApi.discard(d.id))}
        >
          Discard
        </button>
      </div>
    </div>
  );
}
