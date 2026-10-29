import { useEffect, useMemo, useRef, useState } from 'react';
import { aiApi, useAiMutation, type RevertRow } from '../../api/ai';
import { extractError } from '../../api/extractError';
import { useMembers } from '../../api/members';
import type { AiRun } from '../../types/ai';
import { MemberAvatar } from '../MemberAvatar';
import { useToast } from '../Toast';
import { currentPerson } from '../assist/assistUi';
import { FloatMenu } from './ComposerAi';
import { STATUS_NAMES, hhmm, useAiBoardState } from './aiUi';
import './ticketWork.css';

/** A small popover anchored under its button; closes on an outside click or Escape. */
function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as Element).closest?.('.tw-menu'))
        setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key, true);
    };
  }, [open]);
  return { open, setOpen, ref };
}

/**
 * Take over: the AI's run ends and the ticket goes to a person (the design's review gate and failed states). It asks
 * who takes it, preselecting the person using the board, instead of leaving the ticket without an assignee.
 */
export function TakeOverButton({
  ticketId,
  projectId,
  label = 'Take over',
  primary,
  onDone,
}: {
  ticketId: string;
  projectId: string;
  label?: string;
  primary?: boolean;
  onDone?: () => void;
}) {
  const { open, setOpen, ref } = usePopover();
  const btn = useRef<HTMLButtonElement>(null);
  const people = (useMembers(projectId).data ?? []).filter((m) => (m.kind ?? 'human') === 'human');
  const me = currentPerson();
  const [pick, setPick] = useState<string | null>(null);
  const chosen = pick ?? people.find((p) => p.name === me)?.id ?? people[0]?.id ?? null;
  const toast = useToast();
  const takeOver = useAiMutation((memberId: string) => aiApi.takeOver(ticketId, memberId));
  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        ref={btn}
        type="button"
        className={`ai-btn ai-btn-sm ${primary ? 'ai-btn-primary' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="take-over"
        onClick={() => setOpen(!open)}
      >
        ✋ {label}
      </button>
      {open && (
        <FloatMenu anchor={btn.current} onClose={() => setOpen(false)} width={300}>
          <div role="dialog" aria-label="Take over" data-testid="take-over-pop" style={{ padding: 8 }}>
            <b style={{ fontSize: 13.5 }}>Who takes {ticketId}?</b>
            <div className="ai-hint" style={{ margin: '2px 0 8px' }}>
              The AI’s run ends and the ticket is assigned to them. Files stay on the branch.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 220, overflow: 'auto' }}>
              {people.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`ai-mi ${chosen === p.id ? 'tw-mi-on' : ''}`}
                  aria-pressed={chosen === p.id}
                  onClick={() => setPick(p.id)}
                >
                  <MemberAvatar member={p} size={22} />
                  {p.name}
                  {p.name === me && <span className="ai-muted"> you</span>}
                  {chosen === p.id && <span style={{ marginLeft: 'auto', color: '#2E6F40' }}>✓</span>}
                </button>
              ))}
              {people.length === 0 && <span className="ai-muted">No people in this project.</span>}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
              <button type="button" className="ai-btn ai-btn-sm" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="ai-btn ai-btn-sm ai-btn-primary"
                disabled={!chosen || takeOver.isPending}
                data-testid="take-over-confirm"
                onClick={async () => {
                  if (!chosen) return;
                  try {
                    await takeOver.mutateAsync(chosen);
                    setOpen(false);
                    toast.success(
                      'You took over',
                      `${ticketId} is now ${people.find((p) => p.id === chosen)?.name}’s.`,
                    );
                    onDone?.();
                  } catch (err) {
                    toast.error("Couldn't take over", extractError(err));
                  }
                }}
              >
                Take over
              </button>
            </div>
          </div>
        </FloatMenu>
      )}
    </span>
  );
}

/** Raise limit: run again with a longer time limit (a run that timed out). */
export function RaiseLimitButton({ run }: { run: AiRun }) {
  const { open, setOpen, ref } = usePopover();
  const btn = useRef<HTMLButtonElement>(null);
  const toast = useToast();
  const retry = useAiMutation((minutes: number) => aiApi.retry(run.id, minutes));
  const base = run.limitMin ?? 30;
  const choices = [base * 2, base * 4, 8 * 60].filter((m, i, all) => all.indexOf(m) === i && m <= 24 * 60);
  const words = (m: number) => (m % 60 === 0 ? `${m / 60} h` : `${m} min`);
  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        ref={btn}
        type="button"
        className="ai-btn ai-btn-sm"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="raise-limit"
        onClick={() => setOpen(!open)}
      >
        ⏱ Raise limit
      </button>
      {open && (
        <FloatMenu anchor={btn.current} onClose={() => setOpen(false)} width={260}>
          <b style={{ fontSize: 13.5 }}>Run again with a longer limit</b>
          <div className="ai-hint" style={{ margin: '2px 0 8px' }}>
            It starts a new run (#{run.number + 1}). The limit is for that run only.
          </div>
          {choices.map((m) => (
            <button
              key={m}
              type="button"
              role="menuitem"
              className="ai-mi"
              disabled={retry.isPending}
              onClick={async () => {
                try {
                  await retry.mutateAsync(m);
                  setOpen(false);
                  toast.success(`Run #${run.number + 1} queued`, `It may take up to ${words(m)}.`);
                } catch (err) {
                  toast.error("Couldn't start a new run", extractError(err));
                }
              }}
            >
              Up to {words(m)}
            </button>
          ))}
        </FloatMenu>
      )}
    </span>
  );
}

const FIELD_LABEL: Record<string, string> = { status: 'Status', estimate: 'Estimate', priority: 'Priority' };

/** “estimate” → “Estimate”. */
export function fieldLabel(field: string): string {
  return FIELD_LABEL[field] ?? field.charAt(0).toUpperCase() + field.slice(1).replace(/_/g, ' ');
}

/** A field value in words: “2 pt”, “In Progress”, “none”. */
export function fmtValue(field: string, v: unknown): string {
  if (v == null || v === '') return 'none';
  if (field === 'status') return STATUS_NAMES[String(v)] ?? String(v);
  if (field === 'estimate') return `${v} pt`;
  if (Array.isArray(v)) return v.join(', ') || 'none';
  const s = String(v);
  return s.length > 60 ? `${s.slice(0, 59)}…` : s;
}

/**
 * Undo run's changes (G3): a row per change with a checkbox, who edited a field after the AI (skipped, unchecked),
 * and what stays (files, branch). Comments and the run log stay as history; git is never touched.
 */
export function UndoRunDialog({ run, onClose }: { run: AiRun; onClose: () => void }) {
  const toast = useToast();
  const { members } = useAiBoardState();
  const [rows, setRows] = useState<RevertRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const undo = useAiMutation((ids: string[]) => aiApi.revertEntries(ids));
  useEffect(() => {
    let live = true;
    aiApi
      .revertPreview(run.id)
      .then((r) => live && setRows(r))
      .catch((e) => live && setError(extractError(e)));
    return () => {
      live = false;
    };
  }, [run.id]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  const fields = useMemo(() => (rows ?? []).filter((r) => r.kind === 'field'), [rows]);
  const keep = useMemo(() => (rows ?? []).filter((r) => r.kind !== 'field'), [rows]);
  const conflicts = fields.filter((r) => r.conflict);
  const selected = fields.filter((r) => !r.conflict && !off.has(r.entryId ?? ''));
  const ai = members.get(run.memberId);
  const total = fields.length + keep.length;
  const doneCount = selected.length;
  return (
    <div className="ai-overlay" onClick={onClose}>
      <div
        className="ai-modal tw-undo"
        role="dialog"
        aria-label={`Undo run ${run.number}’s changes`}
        data-testid="undo-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ai-modal-head" style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <h2 className="ai-modal-title" style={{ fontSize: 17 }}>
              Undo run #{run.number}’s changes
            </h2>
            <div className="ai-hint">
              {rows ? `${total} change${total === 1 ? '' : 's'}` : 'Reading the changes'} by{' '}
              {ai?.name ?? run.memberName}, on behalf of {run.startedBy}
            </div>
          </div>
          <button type="button" className="ai-icobtn" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="ai-modal-body" style={{ gap: 0 }}>
          {!rows && !error && <span className="ai-spin" />}
          {error && <div className="ai-notice ai-notice-error">{error}</div>}
          {rows && rows.length === 0 && <div className="ai-hint">This run changed nothing that can be undone.</div>}
          {[...fields, ...keep].map((r, i) => {
            const isField = r.kind === 'field';
            const checked = isField ? !r.conflict && !off.has(r.entryId ?? '') : true;
            return (
              <label
                key={`${r.kind}-${r.entryId ?? ''}-${r.field}-${i}`}
                className="tw-undo-row"
                data-testid="undo-row"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!isField || r.conflict}
                  aria-label={fieldLabel(r.field)}
                  onChange={() => {
                    const id = r.entryId ?? '';
                    setOff((cur) => {
                      const next = new Set(cur);
                      if (next.has(id)) next.delete(id);
                      else next.add(id);
                      return next;
                    });
                  }}
                />
                <span className="ai-label" style={{ width: 70 }}>
                  {fieldLabel(r.field)}
                </span>
                <span style={{ flex: 1 }}>
                  {isField
                    ? `${fmtValue(r.field, r.from)} → ${fmtValue(r.field, r.to)}`
                    : r.kind === 'files'
                      ? `${r.count} file${r.count === 1 ? '' : 's'} on the branch`
                      : `Unlink ${r.name}`}
                </span>
                <span
                  className="ai-muted"
                  style={{
                    fontSize: 12.5,
                    color: r.conflict ? '#B4571F' : '#5B6B60',
                    fontWeight: r.conflict ? 600 : 500,
                  }}
                >
                  {isField
                    ? r.conflict
                      ? `${r.editedBy ?? 'A person'} set ${fmtValue(r.field, r.current)}${r.editedAt ? ` at ${hhmm(r.editedAt)}` : ''}`
                      : 'will revert'
                    : r.note}
                </span>
              </label>
            );
          })}
          {conflicts.length > 0 && (
            <div className="ai-notice ai-notice-warn" style={{ marginTop: 12 }} data-testid="undo-conflict">
              <div>
                <b>
                  {conflicts.length === 1 ? 'One change was' : `${conflicts.length} changes were`} edited by a person
                </b>
                <div>
                  {conflicts.map((c) => fieldLabel(c.field)).join(' and ')} {conflicts.length === 1 ? 'was' : 'were'}{' '}
                  changed again after the AI. {conflicts.length === 1 ? 'It is' : 'They are'} skipped and left as{' '}
                  {conflicts[0].editedBy ?? 'the person'} set {conflicts.length === 1 ? 'it' : 'them'}.
                </div>
              </div>
            </div>
          )}
        </div>
        <div className="ai-modal-foot">
          <span className="ai-hint" style={{ flex: 1 }}>
            Comments and the run log stay as history.
          </span>
          <button type="button" className="ai-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="ai-btn ai-btn-danger"
            disabled={busy || doneCount === 0}
            data-testid="undo-confirm"
            onClick={async () => {
              setBusy(true);
              try {
                const ids = [...new Set(selected.map((r) => r.entryId as string))];
                const out = await undo.mutateAsync(ids);
                const n = out.filter((x) => x.result === 'reverted').length;
                toast.success(`Undid ${n} change${n === 1 ? '' : 's'}`, `Recorded in Activity under your name.`);
                onClose();
              } catch (err) {
                toast.error("Couldn't undo", extractError(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            ↶ Undo {doneCount} of {total}
          </button>
        </div>
      </div>
    </div>
  );
}
