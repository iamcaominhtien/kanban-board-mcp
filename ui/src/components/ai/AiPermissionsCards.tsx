import { useState } from 'react';
import { useAiMutation } from '../../api/ai';
import { safetyApi, useAiBlocks, useAiPermissions, useAlwaysGrants } from '../../api/aiSafety';
import type { BlockGroup } from '../../api/aiSafety';
import { extractError } from '../../api/extractError';
import { useToast } from '../Toast';
import { Toggle } from './aiUi';
import { ACTION_LABEL, ChipChoice, Pill, RadioRow, SafetyCard, dateTime } from './aiSafetyUi';
import { LineIcon } from '../ui/LineIcon';

/** Issue #275: how much the AIs do on their own (presets, web search, what each role may run), and what stopped them. */

const ROLE_NAMES: Record<string, string> = {
  triage: 'Triage',
  pm: 'PM',
  ba: 'BA',
  designer: 'Designer',
  dev: 'Dev',
  reviewer: 'Reviewer',
  qa: 'QA',
  user_tester: 'User tester',
  tech_writer: 'Technical writer',
  devops: 'DevOps',
  security: 'Security reviewer',
  data_analyst: 'Data analyst',
};

/** A role pack key in words ("user_tester" → "User tester"). */
export const roleName = (r: string | null | undefined) => (r ? (ROLE_NAMES[r] ?? r) : 'no role');

const VERDICT: Record<BlockGroup['verdict'], { bg: string; color: string; label: string }> = {
  fixed: { bg: '#F1F8F3', color: '#2E6F40', label: 'Fixed' },
  setting: { bg: '#EEF2F6', color: '#34455A', label: 'A setting' },
  kept: { bg: '#FDF5E6', color: '#8A5A12', label: 'Kept on purpose' },
  open: { bg: '#FBEEEA', color: '#C4432A', label: 'Open' },
};

/** Presets (Careful, Normal, Trusted), web search, Bypass, asking once; and what each role runs without asking. */
export function PermissionsCard({ projectId }: { projectId: string }) {
  const q = useAiPermissions(projectId);
  const toast = useToast();
  const [showRoles, setShowRoles] = useState(false);
  const save = useAiMutation((body: Parameters<typeof safetyApi.savePermissions>[1]) =>
    safetyApi.savePermissions(projectId, body),
  );
  const p = q.data;
  if (!p) return <SafetyCard title="How much the AIs do on their own">{q.isError ? 'Couldn’t load.' : '…'}</SafetyCard>;
  const set = (body: Parameters<typeof safetyApi.savePermissions>[1], done?: string) =>
    save.mutate(body, {
      onSuccess: () => done && toast.success('Saved', done),
      onError: (err) => toast.error("Couldn't save", extractError(err)),
    });
  const locked = !p.canEdit || save.isPending;
  return (
    <SafetyCard
      id="ai-permissions"
      title="How much the AIs do on their own"
      sub="What an AI may run without stopping. The risky things stay with a person whatever you pick: deleting, Done past the ceiling, pushing, and safe mode."
      right={
        p.preset === 'custom' ? (
          <Pill bg="#EEF2F6" color="#34455A">
            Custom
          </Pill>
        ) : null
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="ai-presets">
        {p.presets.map((x) => (
          <RadioRow
            key={x.key}
            on={p.preset === x.key}
            disabled={locked || (x.key === 'trusted' && !p.canTrust && p.preset !== 'trusted')}
            onClick={() => set({ preset: x.key }, `${x.label}: ${x.line}`)}
            title={
              <>
                {x.label}
                {x.key === 'normal' && <span className="ai-muted"> · default</span>}
              </>
            }
            hint={x.line}
          />
        ))}
      </div>
      {!p.canEdit && (
        <div className="ai-muted" style={{ marginTop: 6 }}>
          Owners and admins change this; Trusted is the owner’s.
        </div>
      )}
      <div className="ai-grid2" style={{ marginTop: 12 }}>
        <div>
          <div className="ai-label ai-label-dark">Web search</div>
          <div className="ai-muted" style={{ marginBottom: 4 }}>
            Search results only; web pages stay limited to the allowed domains outside Bypass.
          </div>
          <ChipChoice
            value={p.webSearch}
            disabled={locked}
            onChange={(v) => set({ webSearch: v })}
            options={[
              ['off', 'Off'],
              ['roles', `By role (${p.webSearchRoles.map(roleName).join(', ')})`],
              ['on', 'Every role'],
            ]}
          />
        </div>
        <div>
          <div className="ai-label ai-label-dark">Bypass permissions</div>
          <div className="ai-muted" style={{ marginBottom: 4 }}>
            Bypass runs any tool except what a deny rule stops. Board rules still apply.
          </div>
          <ChipChoice
            value={p.bypass}
            disabled={locked}
            onChange={(v) => set({ bypass: v })}
            options={[
              ['never', 'Never'],
              ['member', 'Each member’s choice'],
              ['always', 'Every work run'],
            ]}
          />
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ flex: 1, fontSize: 12.5 }}>
            <b>Ask once, then remember</b>
            <span className="ai-muted">
              {' '}
              · a tool the CLI refused becomes one request: you answer for this ticket, the project or the role, and the
              answer is kept
            </span>
          </span>
          <Toggle
            on={p.askCli}
            label="Ask once, then remember"
            testId="ai-ask-cli"
            onChange={(v) => !locked && set({ askCli: v })}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ flex: 1, fontSize: 12.5 }}>
            <b>Ask before Docs edits</b>
            <span className="ai-muted"> · every AI edit of a page waits for you, with a diff</span>
          </span>
          <Toggle
            on={p.docsAsk}
            label="Ask before Docs edits"
            testId="ai-docs-ask"
            onChange={(v) => !locked && set({ docsAsk: v })}
          />
        </div>
      </div>
      <div style={{ marginTop: 10 }}>
        <button
          type="button"
          className="ai-link"
          onClick={() => setShowRoles(!showRoles)}
          data-testid="ai-role-tools-toggle"
        >
          {showRoles ? 'Hide' : 'Show'} what each role runs without asking
        </button>
        {showRoles && (
          <table className="ai-table" style={{ marginTop: 6 }} data-testid="ai-role-tools">
            <thead>
              <tr>
                <th>Role</th>
                <th>Without asking</th>
                <th>Web search</th>
              </tr>
            </thead>
            <tbody>
              {p.roles.map((r) => (
                <tr key={r.role}>
                  <td>
                    <b>{roleName(r.role)}</b>
                  </td>
                  <td>
                    {r.words}
                    <div className="ai-muted ai-mono" style={{ fontSize: 11 }} title={r.tools.join('\n')}>
                      {r.tools.length} rules
                    </div>
                  </td>
                  <td>{r.webSearch ? <LineIcon name="check" size={13} /> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </SafetyCard>
  );
}

/** What the AIs may do without asking because a person said so once: one line each, with Revoke. */
export function RememberedCard({ projectId }: { projectId: string }) {
  const grants = useAlwaysGrants(projectId);
  const toast = useToast();
  const revoke = useAiMutation((id: string) => safetyApi.revokeGrant(id));
  const items = grants.data ?? [];
  return (
    <SafetyCard
      title={`Remembered answers${items.length ? ` · ${items.length}` : ''}`}
      sub="What you allowed once and asked the board to keep, for the project or for a role. Answers for one ticket are listed on the ticket and end when it is Done."
    >
      {!items.length ? (
        <div className="ai-muted">Nothing yet. When you answer a request with “remember”, it shows here.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="ai-remembered">
          {items.map((g) => (
            <div key={g.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
              <span style={{ flex: 1 }}>
                <b>{g.role ? `Every ${roleName(g.role)}` : (g.memberName ?? 'An AI')}</b> may{' '}
                {g.kind === 'tool' ? (
                  <>
                    run <span className="ai-mono">{g.action}</span>
                  </>
                ) : (
                  (ACTION_LABEL[g.action] ?? g.action).toLowerCase()
                )}{' '}
                without asking{' '}
                <span className="ai-muted">
                  · {g.createdBy}, {dateTime(g.createdAt)}
                </span>
              </span>
              <button
                type="button"
                className="ai-btn ai-btn-sm"
                disabled={revoke.isPending}
                onClick={() =>
                  revoke.mutate(g.id, {
                    onSuccess: () => toast.success('Revoked', 'It asks again next time.'),
                    onError: (err) => toast.error("Couldn't revoke", extractError(err)),
                  })
                }
              >
                Revoke
              </button>
            </div>
          ))}
        </div>
      )}
    </SafetyCard>
  );
}

/** The list of blocks (issue #275, task 1): grouped, with the role, what it was doing and the verdict. */
export function BlocksCard({ projectId }: { projectId: string }) {
  const [days, setDays] = useState(30);
  const [filter, setFilter] = useState<'all' | BlockGroup['verdict']>('all');
  const q = useAiBlocks(projectId, days);
  const r = q.data;
  const groups = (r?.groups ?? []).filter((g) => filter === 'all' || g.verdict === filter);
  return (
    <SafetyCard
      id="ai-blocks"
      title="What stopped the AIs"
      sub="Every refused action, refused tool, permission question and “I cannot” in the runs, grouped, with what the board does about it now."
      right={
        <ChipChoice
          value={days}
          onChange={setDays}
          options={[
            [7, '7 days'],
            [30, '30 days'],
            [90, '90 days'],
          ]}
        />
      }
    >
      {q.isLoading && <span className="ai-spin" />}
      {q.isError && (
        <div className="ai-error-text">Couldn’t load the list. The runs are safe; only this view failed.</div>
      )}
      {r && (
        <>
          <div className="ai-chips" style={{ marginBottom: 8 }} data-testid="ai-blocks-summary">
            <button
              type="button"
              className={`ai-choice ${filter === 'all' ? 'ai-choice-on' : ''}`}
              onClick={() => setFilter('all')}
            >
              All · {r.total}
            </button>
            {(['fixed', 'setting', 'kept', 'open'] as const).map((v) =>
              r.byVerdict[v] ? (
                <button
                  key={v}
                  type="button"
                  className={`ai-choice ${filter === v ? 'ai-choice-on' : ''}`}
                  onClick={() => setFilter(v)}
                >
                  {VERDICT[v].label} · {r.byVerdict[v]}
                </button>
              ) : null,
            )}
          </div>
          {!r.groups.length ? (
            <div className="ai-muted">Nothing stopped an AI in the last {r.days} days.</div>
          ) : (
            <table className="ai-table" data-testid="ai-blocks">
              <thead>
                <tr>
                  <th style={{ width: '34%' }}>What</th>
                  <th>Who</th>
                  <th style={{ width: 52 }}>Times</th>
                  <th style={{ width: '36%' }}>Now</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <tr key={g.key} data-testid={`ai-block-${g.key}`}>
                    <td>
                      <b>{g.title}</b>
                      {g.trying && <div className="ai-muted ai-mono">{g.trying}</div>}
                      <div className="ai-muted" style={{ fontSize: 11.5 }}>
                        {g.example}
                      </div>
                    </td>
                    <td style={{ fontSize: 12 }}>
                      {g.roles.length ? g.roles.map(roleName).join(', ') : '—'}
                      {g.members.length > 0 && <div className="ai-muted">{g.members.join(', ')}</div>}
                    </td>
                    <td>
                      <b>{g.count}</b>
                      <div className="ai-muted" style={{ fontSize: 11 }}>
                        {dateTime(g.lastAt)}
                      </div>
                    </td>
                    <td>
                      <Pill bg={VERDICT[g.verdict].bg} color={VERDICT[g.verdict].color}>
                        {VERDICT[g.verdict].label}
                      </Pill>
                      <div style={{ fontSize: 12, marginTop: 3 }}>{g.verdictText}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </SafetyCard>
  );
}
