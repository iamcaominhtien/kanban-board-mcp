import { useEffect, useRef, useState } from 'react';
import { extractError } from '../../../api/extractError';
import { keepAwakeApi, useKeepAwake, usePowerActive, useSetKeepAwake } from '../../../api/aiPower';
import { openRun } from '../../aiteam/runLink';
import { Toggle, useAiBoardState } from '../aiUi';
import '../ai.css';
import './keepAwake.css';

const GOING = new Set(['queued', 'starting', 'running']);

function Eye({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.8" />
    </svg>
  );
}

function Clock() {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <path d="M3.5 12a8.5 8.5 0 1 0 2.5-6M3.5 4v4h4M12 8v4.5l3 2" />
    </svg>
  );
}

/** "Dev Khoa on KAN-305, Reviewer Binh on KAN-304". */
const listRuns = (runs: { memberName: string | null; ticketId: string }[]) =>
  runs.map((r) => `${r.memberName ?? 'A team'} on ${r.ticketId}`).join(', ');

/**
 * Keep awake (design/screens/ai-story-flow.md, R2): in the desktop app, while an AI run is starting or running, a
 * quiet green "Awake · N runs" (the switch is on) or an amber "Keep awake is off"; nothing when nothing runs or in the
 * web build. Clicking it opens what is keeping the computer awake and the same switch as View › Keep awake while AI
 * runs.
 */
export function KeepAwakeChip({ onSeeRunHistory }: { onSeeRunHistory?: () => void }) {
  const desktop = !!keepAwakeApi();
  const power = usePowerActive(desktop);
  const awake = useKeepAwake();
  const set = useSetKeepAwake();
  const { runsByTicket, members } = useAiBoardState();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const active = power.data?.active ?? 0;
  if (!desktop || active <= 0 || awake.data == null) return null;
  const on = awake.data;
  const runs = [...runsByTicket.values()].filter((r) => GOING.has(r.state));
  const count = `${active} AI run${active === 1 ? ' is' : 's are'} going`;
  const seeHistory = onSeeRunHistory ?? (runs[0] ? () => openRun(runs[0].runId) : undefined);

  return (
    <div className="ka-wrap" ref={wrap}>
      <button
        type="button"
        className={`ka-chip ${on ? 'ka-on' : 'ka-off'}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-testid="keep-awake-chip"
        onClick={() => setOpen(!open)}
      >
        <Eye />
        {on ? `Awake · ${active} run${active === 1 ? '' : 's'}` : 'Keep awake is off'}
      </button>
      {open && (
        <div className="ka-pop" role="dialog" aria-label="Keep awake" data-testid="keep-awake-pop">
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <span className={`ka-icon${on ? '' : ' ka-icon-off'}`}>
              <Eye size={15} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <b style={{ fontSize: 14 }}>{on ? 'Keeping this computer awake' : 'This computer may sleep'}</b>
              <div className="ai-hint">
                {count}
                {runs.length
                  ? `: ${listRuns(runs.map((r) => ({ ticketId: r.ticketId, memberName: members.get(r.memberId)?.name ?? null })))}`
                  : ''}
                .
              </div>
            </div>
          </div>
          <div className="ka-text">
            {on
              ? 'The screen may turn off; the computer will not sleep until they finish. A run that waits for you, for a limit or for another ticket does not keep it awake.'
              : 'If the computer sleeps now, the runs stop with it. Turn the switch on to keep it awake until they finish.'}
          </div>
          <div className="ka-rule" />
          <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>Keep awake while AI runs</div>
              <div className="ai-hint">
                Same as View › Keep awake while AI runs. Turning it off lets the computer sleep at once.
              </div>
            </div>
            <Toggle
              on={on}
              label="Keep awake while AI runs"
              testId="keep-awake-switch"
              disabled={set.isPending}
              onChange={(v) => set.mutate(v)}
            />
          </div>
          <div className="ka-note">
            <Clock />
            <span>
              If it sleeps anyway, the board checks every run when it wakes, ends the ones whose CLI did not survive,
              and the retry takes over. It is in Run history as <i>Waiting</i>.
            </span>
          </div>
          {set.error && (
            <div className="ai-error-text" role="alert">
              {extractError(set.error)}
            </div>
          )}
          {seeHistory && (
            <div>
              <button
                type="button"
                className="ai-btn ai-btn-sm"
                onClick={() => {
                  setOpen(false);
                  seeHistory();
                }}
              >
                <Clock />
                See Run history
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
