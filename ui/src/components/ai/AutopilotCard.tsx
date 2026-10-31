import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { safetyApi, useAutopilot } from '../../api/aiSafety';
import { extractError } from '../../api/extractError';
import type { AiAutopilot, AiMember } from '../../types/ai';
import { useToast } from '../Toast';
import { Toggle } from './aiUi';
import { ChipChoice, SafetyCard } from './aiSafetyUi';

const RISKS = [
  ['low', 'Low'],
  ['medium', 'Low and medium'],
  ['high', 'Everything'],
] as const;

type Save = (body: Record<string, unknown>) => Promise<boolean>;

/**
 * Autopilot (Safety): one AI of the project answers for the owner. It is off by default; turning it on, giving the AI
 * full rights or raising the risk to High is confirmed here and again by the server (`acceptRisks`).
 */
export function AutopilotCard({
  projectId,
  members,
  isOwner,
}: {
  projectId: string;
  members: AiMember[];
  isOwner: boolean;
}) {
  const { data: a } = useAutopilot(projectId);
  const qc = useQueryClient();
  const toast = useToast();
  const [setup, setSetup] = useState(false);
  const [delegate, setDelegate] = useState('');
  const [rights, setRights] = useState(false);
  const [agree, setAgree] = useState(false);
  const candidates = members.filter((m) => m.kind === 'ai' && m.connection !== 'inbox' && !m.paused);
  if (!a) return null;

  const save: Save = async (body) => {
    try {
      const next = await safetyApi.saveAutopilot(projectId, body);
      qc.setQueryData(['ai', 'autopilot', projectId], next);
      return true;
    } catch (err) {
      toast.error("Couldn't save Autopilot", extractError(err));
      return false;
    }
  };

  const turnOn = async () => {
    const ok = await save({ enabled: true, delegateId: delegate, fullRights: rights, acceptRisks: agree });
    if (ok) {
      setSetup(false);
      setAgree(false);
    }
  };

  return (
    <SafetyCard
      id="autopilot"
      title="Autopilot"
      sub="While you are away, one AI of this project decides the permission requests and answers the questions other AIs leave waiting. You can still decide first, and everything it decides is in the audit log, marked Autopilot."
      right={
        <Toggle
          on={a.enabled || setup}
          label="Autopilot"
          testId="autopilot"
          disabled={!isOwner}
          onChange={(v) => {
            if (v) {
              setDelegate(a.delegateId ?? candidates[0]?.id ?? '');
              setSetup(true);
            } else {
              setSetup(false);
              if (a.enabled) void save({ enabled: false });
            }
          }}
        />
      }
    >
      {!isOwner && (
        <div className="ai-muted">Only the project owner sets up Autopilot.{a.enabled ? '' : ' It is off.'}</div>
      )}
      {setup && !a.enabled && (
        <div data-testid="autopilot-setup" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label className="ai-muted">
            Who decides for you
            <select
              className="ai-input"
              style={{ display: 'block', marginTop: 4, minWidth: 220 }}
              value={delegate}
              onChange={(e) => setDelegate(e.target.value)}
            >
              {candidates.length === 0 && <option value="">No AI member can run right now</option>}
              {candidates.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label className="at-check" style={{ alignItems: 'flex-start' }}>
            <input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)} />
            <span>
              <b>Give it your rights in this project.</b> It then works without the usual limits (status up to Done, no
              approvals for its own edits). Deleting tickets or pages and managing the project and its members stay with
              people.
            </span>
          </label>
          <div className="ai-notice ai-notice-warn" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
            <span>
              The AI reads what other AIs write to decide. A request could be worded to steer it, so Autopilot only
              decides up to <b>medium</b> risk, never its own requests, never the budget, and at most 20 an hour. What
              it leaves undecided stays for you.
            </span>
          </div>
          <label className="at-check">
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />I understand what this
            AI may decide for me
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              className="ai-btn ai-btn-sm ai-btn-primary"
              disabled={!agree || !delegate}
              onClick={() => void turnOn()}
              data-testid="autopilot-turn-on"
            >
              Turn on Autopilot
            </button>
            <button type="button" className="ai-btn ai-btn-sm" onClick={() => setSetup(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {a.enabled && <AutopilotOn a={a} candidates={candidates} save={save} isOwner={isOwner} />}
    </SafetyCard>
  );
}

function AutopilotOn({
  a,
  candidates,
  save,
  isOwner,
}: {
  a: AiAutopilot;
  candidates: AiMember[];
  save: Save;
  isOwner: boolean;
}) {
  const [grace, setGrace] = useState(String(a.graceMin));
  const [limit, setLimit] = useState(String(a.perHourLimit));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }} data-testid="autopilot-on">
      <div className="ai-muted">
        <b>{a.delegateName ?? 'The delegate'}</b> decides for{' '}
        {a.enabledBy && a.enabledBy !== 'user' ? a.enabledBy : 'you'}.{' '}
        <span data-testid="autopilot-used">
          {a.usedLastHour} of {a.perHourLimit} used this hour.
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ flex: 1 }}>
          <b style={{ fontSize: 13 }}>Who decides</b>
        </span>
        <select
          className="ai-input"
          disabled={!isOwner}
          value={a.delegateId ?? ''}
          onChange={(e) => void save({ delegateId: e.target.value })}
        >
          {candidates.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ flex: 1 }}>
          <b style={{ fontSize: 13 }}>Risk it may decide</b>
          <div className="ai-muted">Deleting a ticket is high risk. The budget is never decided by an AI</div>
        </span>
        <ChipChoice
          value={a.maxRisk}
          options={RISKS}
          disabled={!isOwner}
          onChange={(v) => {
            if (v === 'high' && !window.confirm('Let the delegate decide high-risk requests too?')) return;
            void save({ maxRisk: v, acceptRisks: v === 'high' });
          }}
        />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ flex: 1 }}>
          <b style={{ fontSize: 13 }}>It decides</b>
        </span>
        <label className="at-check">
          <input
            type="checkbox"
            checked={a.approvals}
            disabled={!isOwner}
            onChange={(e) => void save({ approvals: e.target.checked })}
          />
          Permission requests
        </label>
        <label className="at-check">
          <input
            type="checkbox"
            checked={a.questions}
            disabled={!isOwner}
            onChange={(e) => void save({ questions: e.target.checked })}
          />
          Questions
        </label>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ flex: 1 }}>
          <b style={{ fontSize: 13 }}>Wait for you first</b>
          <div className="ai-muted">A request is yours until it has waited this long</div>
        </span>
        <input
          className="ai-input"
          type="number"
          min={0}
          max={240}
          style={{ width: 80, height: 32 }}
          disabled={!isOwner}
          value={grace}
          onChange={(e) => setGrace(e.target.value)}
          onBlur={() => Number(grace) !== a.graceMin && void save({ graceMin: Number(grace) })}
          data-testid="autopilot-grace"
        />
        <span className="ai-muted">min</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ flex: 1 }}>
          <b style={{ fontSize: 13 }}>At most per hour</b>
        </span>
        <input
          className="ai-input"
          type="number"
          min={1}
          max={200}
          style={{ width: 80, height: 32 }}
          disabled={!isOwner}
          value={limit}
          onChange={(e) => setLimit(e.target.value)}
          onBlur={() => Number(limit) !== a.perHourLimit && void save({ perHourLimit: Number(limit) })}
          data-testid="autopilot-limit"
        />
        <span className="ai-muted">decisions</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ flex: 1 }}>
          <b style={{ fontSize: 13 }}>Your rights in this project</b>
          <div className="ai-muted">
            The delegate works without the usual limits. Deleting tickets or pages stays with people
          </div>
        </span>
        <Toggle
          on={a.fullRights}
          label="Full rights"
          testId="autopilot-rights"
          disabled={!isOwner}
          onChange={(v) => {
            if (v && !window.confirm(`Give ${a.delegateName ?? 'the delegate'} your rights in this project?`)) return;
            void save({ fullRights: v, acceptRisks: v });
          }}
        />
      </div>
    </div>
  );
}
