import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { extractError } from '../../../api/extractError';
import { Stepper } from '../AddAiMemberModal';
import { Toggle, money } from '../aiUi';
import { configApi, type DryRunResult } from './configApi';
import { useCfg } from './configCtx';
import { CfgCard, Chip, CopyButton, IssueText, NumField, tok, useDebounced } from './parts';

/** Context sources: what the board puts in front of the model before step 1, with token estimates (design D5). */
export function ContextCard() {
  const { member, cfg, setCfg, issues } = useCfg();
  const ctx = cfg.context;
  const set = (patch: Partial<typeof ctx>) => setCfg({ context: { ...ctx, ...patch } });
  const tickets = useQuery({
    queryKey: ['ai', 'sample-tickets', member.projectId],
    queryFn: () => configApi.sampleTickets(member.projectId),
  });
  const probe = useDebounced(JSON.stringify([ctx, cfg.instructions, cfg.snippets]), 400);
  const sample = tickets.data?.[0]?.id;
  const est = useQuery({
    queryKey: ['ai', 'context-estimate', member.id, sample, probe],
    queryFn: () => configApi.promptPreview(member.id, cfg, sample),
    enabled: !!sample,
    retry: false,
  });
  const s = est.data?.sources;
  const total = est.data ? est.data.systemTokens + est.data.userTokens : null;
  return (
    <CfgCard
      id="cfg-context"
      testId="card-context"
      title="Context sources"
      mode="direct"
      right={
        <span className="ai-muted" data-testid="context-total">
          {total != null ? `≈ ${tok(total)} tokens per run` : '—'}
        </span>
      }
      sub={`What the board puts in front of the model before step 1${sample ? `, estimated on ${sample}` : ''}.`}
    >
      <div className="cfg-row">
        <input type="checkbox" checked disabled aria-label="Ticket" />
        <div className="cfg-row-main">
          <div className="cfg-row-title">Ticket</div>
          <div className="ai-muted">Title, description, fields, acceptance criteria</div>
        </div>
        <span className="ai-muted">{s ? `≈ ${tok(s.ticket)}` : ''}</span>
        <Chip>locked on</Chip>
      </div>
      <div className="cfg-row">
        <input
          type="checkbox"
          aria-label="Acceptance criteria"
          checked={ctx.criteria}
          onChange={(e) => set({ criteria: e.target.checked })}
        />
        <div className="cfg-row-main">
          <div className="cfg-row-title">Acceptance criteria</div>
          <div className="ai-muted">Part of the ticket block</div>
        </div>
      </div>
      <div className="cfg-row">
        <input
          type="checkbox"
          aria-label="Linked docs"
          checked={ctx.linkedDocs}
          onChange={(e) => set({ linkedDocs: e.target.checked })}
        />
        <div className="cfg-row-main">
          <div className="cfg-row-title">Linked docs</div>
          <div className="ai-muted" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            Up to
            <input
              aria-label="Docs limit"
              data-path="context.doc_limit"
              className="ai-input"
              style={{ width: 54, padding: '3px 6px' }}
              type="number"
              value={ctx.docLimit}
              onChange={(e) => set({ docLimit: Number(e.target.value) })}
            />
            docs, first
            <input
              aria-label="Tokens per doc"
              data-path="context.doc_tokens"
              className="ai-input"
              style={{ width: 70, padding: '3px 6px' }}
              type="number"
              step={500}
              value={ctx.docTokens}
              onChange={(e) => set({ docTokens: Number(e.target.value) })}
            />
            tokens each
          </div>
        </div>
        <span className="ai-muted">{ctx.linkedDocs && s ? `≈ ${tok(s.docs)}` : '—'}</span>
      </div>
      <div className="cfg-row">
        <input
          type="checkbox"
          aria-label="Comments"
          checked={ctx.comments}
          onChange={(e) => set({ comments: e.target.checked })}
        />
        <div className="cfg-row-main">
          <div className="cfg-row-title">Comments</div>
          <div className="ai-muted" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            Last
            <input
              aria-label="Comments limit"
              data-path="context.comment_limit"
              className="ai-input"
              style={{ width: 54, padding: '3px 6px' }}
              type="number"
              value={ctx.commentLimit}
              onChange={(e) => set({ commentLimit: Number(e.target.value) })}
            />
            comments
          </div>
        </div>
        <span className="ai-muted">{ctx.comments && s ? `≈ ${tok(s.comments)}` : '—'}</span>
      </div>
      <div className="cfg-row">
        <input
          type="checkbox"
          aria-label="Sub-tickets"
          checked={ctx.subTickets}
          onChange={(e) => set({ subTickets: e.target.checked })}
        />
        <div className="cfg-row-main">
          <div className="cfg-row-title">Sub-tickets</div>
          <div className="ai-muted">Titles and status only</div>
        </div>
        <span className="ai-muted">{ctx.subTickets && s ? `≈ ${tok(s.subTickets)}` : '—'}</span>
      </div>
      {est.data && est.data.docs.some((d) => d.cut) && (
        <div className="ai-hint">A doc over its limit is cut and marked “[…cut]”.</div>
      )}
      <IssueText issues={issues} path="context" prefix />
    </CfgCard>
  );
}

/** Agent loop limits, retry backoff, temperature, budgets and the key (design D6). */
export function LimitsCard() {
  const { member, cfg, setCfg, draft, setDraft, issues, newKey, setNewKey } = useCfg();
  return (
    <CfgCard
      id="cfg-limits"
      testId="card-limits"
      title="Agent loop limits"
      mode="direct"
      sub="A run stops at the first limit it reaches and says which one."
    >
      <div className="cfg-three">
        <NumField
          label="Max steps"
          value={cfg.maxSteps}
          onChange={(v) => setCfg({ maxSteps: v })}
          path="max_steps"
          issues={issues}
          hint="1 to 50"
        />
        <NumField
          label="Max tokens per run (in + out)"
          value={cfg.maxTokensPerRun}
          step={1000}
          onChange={(v) => setCfg({ maxTokensPerRun: v })}
          path="max_tokens_per_run"
          issues={issues}
        />
        <NumField
          label="Timeout (wall clock)"
          unit="min"
          value={cfg.runTimeoutMin}
          onChange={(v) => setCfg({ runTimeoutMin: v })}
          path="run_timeout_min"
          issues={issues}
        />
      </div>
      <div className="cfg-three">
        <NumField
          label="Retry on 429 and 5xx"
          unit="attempts"
          value={cfg.retries}
          onChange={(v) => setCfg({ retries: v })}
          path="retries"
          issues={issues}
        />
        <NumField
          label="Backoff start"
          unit="s"
          step={0.5}
          value={cfg.retryBaseS}
          onChange={(v) => setCfg({ retryBaseS: v })}
          path="retry_base_s"
          issues={issues}
        />
        <NumField
          label="Backoff factor"
          unit="×"
          step={0.5}
          value={cfg.retryFactor}
          onChange={(v) => setCfg({ retryFactor: v })}
          path="retry_factor"
          issues={issues}
        />
      </div>
      <div className="cfg-three">
        <NumField
          label="Backoff maximum"
          unit="s"
          value={cfg.retryMaxS}
          onChange={(v) => setCfg({ retryMaxS: v })}
          path="retry_max_s"
          issues={issues}
        />
        <div className="ai-field" style={{ gridColumn: 'span 2' }}>
          <span className="ai-label ai-label-dark">Backoff (exponential)</span>
          <div className="ai-hint" data-testid="backoff-summary">
            {cfg.retryBaseS} s × {cfg.retryFactor}, max {cfg.retryMaxS} s · waits{' '}
            {Array.from(
              { length: Math.min(cfg.retries, 5) },
              (_, i) => `${Math.min(cfg.retryMaxS, cfg.retryBaseS * cfg.retryFactor ** i)} s`,
            ).join(', ') || 'none'}
          </div>
        </div>
      </div>
      <div className="ai-field">
        <span className="ai-label ai-label-dark">Temperature {cfg.temperature}</span>
        <input
          aria-label="Temperature"
          type="range"
          min={0}
          max={1}
          step={0.1}
          value={cfg.temperature}
          onChange={(e) => setCfg({ temperature: Number(e.target.value) })}
        />
        <div className="ai-muted" style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>0 precise</span>
          <span>1 varied</span>
        </div>
        <IssueText issues={issues} path="temperature" />
      </div>
      <div className="ai-divider" />
      <div className="cfg-three">
        <NumField
          id="cfg-budget"
          label="Daily budget ($)"
          step={0.5}
          value={draft.dailyBudget}
          onChange={(v) => setDraft({ dailyBudget: v })}
          path="daily_budget"
          issues={issues}
        />
        <NumField
          label="Monthly cap ($)"
          value={draft.monthlyCap}
          onChange={(v) => setDraft({ monthlyCap: v })}
          path="monthly_cap"
          issues={issues}
        />
        <div className="ai-field">
          <span className="ai-label ai-label-dark">Parallel runs</span>
          <Stepper value={draft.maxParallel} min={1} max={10} onChange={(v) => setDraft({ maxParallel: v })} />
        </div>
      </div>
      <div className="ai-field">
        <span className="ai-label ai-label-dark">Replace key (••••{member.keyLast4})</span>
        <input
          id="cfg-key"
          className="ai-input ai-mono"
          type="password"
          autoComplete="off"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          placeholder="Enter a new key to replace it"
        />
      </div>
    </CfgCard>
  );
}

/** Output rules: what the board does with the result (design D7). */
export function OutputCard() {
  const { cfg, setCfg } = useCfg();
  const o = cfg.output;
  const set = (patch: Partial<typeof o>) => setCfg({ output: { ...o, ...patch } });
  return (
    <CfgCard
      id="cfg-output"
      testId="card-output"
      title="Output rules"
      mode="direct"
      sub="What the board does with the result."
    >
      <label className="cfg-row" style={{ alignItems: 'flex-start' }}>
        <input type="checkbox" checked disabled aria-label="Always post a summary comment" />
        <span className="cfg-row-main">
          <span className="cfg-row-title">Always post a summary comment</span>
          <span className="ai-muted">Even when the run fails or hits a limit. Locked on.</span>
        </span>
      </label>
      <label className="cfg-row" style={{ alignItems: 'flex-start' }}>
        <input
          type="checkbox"
          checked={o.includeUsage}
          aria-label="Include steps and tokens in the comment"
          onChange={(e) => set({ includeUsage: e.target.checked })}
        />
        <span className="cfg-row-main">
          <span className="cfg-row-title">Include steps and tokens in the comment</span>
          <span className="ai-muted">One line at the end, e.g. “6 steps · 14.2k tokens”</span>
        </span>
      </label>
      <label className="cfg-row" style={{ alignItems: 'flex-start' }}>
        <input
          type="checkbox"
          checked={o.moveBackOnFailure}
          aria-label="Move the ticket back when a run fails"
          onChange={(e) => set({ moveBackOnFailure: e.target.checked })}
        />
        <span className="cfg-row-main">
          <span className="cfg-row-title">Move the ticket back when a run fails</span>
          <span className="ai-muted">Back to the previous status; off by default</span>
        </span>
      </label>
      <div className="ai-field">
        <span className="ai-label ai-label-dark">Comment format</span>
        <select
          aria-label="Comment format"
          className="ai-select"
          value={o.commentFormat}
          onChange={(e) => set({ commentFormat: e.target.value as typeof o.commentFormat })}
        >
          <option value="short">Short — verdict first, 5 lines max</option>
          <option value="detailed">Detailed — verdict, reasoning and next steps</option>
          <option value="plain">Plain text — no Markdown</option>
        </select>
      </div>
    </CfgCard>
  );
}

/** Dry run on a sample ticket with the unsaved configuration (design D8). */
export function DryRunCard() {
  const { member, cfg, issues } = useCfg();
  const tickets = useQuery({
    queryKey: ['ai', 'sample-tickets', member.projectId],
    queryFn: () => configApi.sampleTickets(member.projectId),
  });
  const [pick, setPick] = useState('');
  const [res, setRes] = useState<DryRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ticket = pick || tickets.data?.[0]?.id || '';
  const blocked = issues.some((i) => i.severity === 'error');
  const maxCost =
    Math.round(((cfg.maxTokensPerRun * 0.9) / 1e6) * 3 * 100 + ((cfg.maxTokensPerRun * 0.1) / 1e6) * 15 * 100) / 100;
  async function run() {
    setBusy(true);
    setError(null);
    setRes(null);
    try {
      setRes(await configApi.dryRun(member.id, ticket, cfg));
    } catch (e) {
      setError(extractError(e));
    } finally {
      setBusy(false);
    }
  }
  const trace = res
    ? res.rows
        .map((r) => `${r.step}\t${r.name}\t${r.detail}\t${tok(r.tokensIn)}\t${tok(r.tokensOut)}\t${r.seconds} s`)
        .join('\n')
    : '';
  const stateText = res
    ? {
        finished: 'Finished',
        step_limit: 'Stopped at the step limit',
        token_limit: 'Stopped at the token limit',
        timed_out: 'Timed out',
        error: 'Provider error',
      }[res.state]
    : '';
  return (
    <CfgCard
      id="cfg-dryrun"
      testId="card-dryrun"
      title="Dry run"
      mode="direct"
      right={<span className="ai-muted">Runs against {ticket || '—'}</span>}
      sub="Simulates a run on a sample ticket with the current unsaved config."
    >
      <div className="cfg-two">
        <div className="ai-field">
          <span className="ai-label ai-label-dark">Sample ticket</span>
          <select
            aria-label="Sample ticket"
            className="ai-select"
            value={ticket}
            onChange={(e) => setPick(e.target.value)}
          >
            {(tickets.data ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.id} · {t.title}
              </option>
            ))}
          </select>
        </div>
        <div className="ai-field">
          <span className="ai-label ai-label-dark">Simulate side effects</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Toggle on disabled label="Simulate side effects" onChange={() => undefined} />
            <span className="ai-hint">Writes are shown, never applied. Reads hit real data.</span>
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button
          type="button"
          className="ai-btn ai-btn-primary"
          data-testid="run-dry"
          disabled={busy || !ticket || blocked}
          title={blocked ? 'Fix the errors in the configuration first' : undefined}
          onClick={() => void run()}
        >
          {busy ? 'Running…' : 'Run dry run'}
        </button>
        <span className="ai-muted">
          Uses real model calls, so it costs tokens. Estimated max for this config:{' '}
          {money(res?.estimateMaxUsd ?? maxCost)}.
        </span>
      </div>
      {error && <div className="ai-notice ai-notice-error">{error}</div>}
      {res && (
        <div data-testid="dry-result" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <b style={{ fontSize: 12.5 }}>Step trace</b>
            <Chip tone={res.state === 'finished' ? 'synced' : 'warn'}>{stateText}</Chip>
            <span className="ai-muted">
              {res.stepsUsed} of {res.maxSteps} steps · {res.seconds} s
            </span>
            <span style={{ flex: 1 }} />
            <CopyButton text={trace} label="Copy trace" />
            <button
              type="button"
              className="ai-btn ai-btn-sm"
              onClick={() => {
                const a = document.createElement('a');
                a.href = URL.createObjectURL(new Blob([JSON.stringify(res, null, 2)], { type: 'application/json' }));
                a.download = `dry-run-${res.ticketId}.json`;
                a.click();
              }}
            >
              Export JSON
            </button>
          </div>
          <table className="ai-table cfg-trace" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>Step</th>
                <th>Name</th>
                <th>Detail</th>
                <th>In</th>
                <th>Out</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {res.rows.map((r) => (
                <tr
                  key={r.step}
                  className={r.tone === 'blocked' ? 'cfg-trace-blocked' : r.tone === 'simulated' ? 'cfg-trace-sim' : ''}
                >
                  <td>{r.step}</td>
                  <td style={{ fontWeight: 600, color: r.tone === 'blocked' ? '#C4432A' : undefined }}>{r.name}</td>
                  <td className="ai-mono" style={{ fontSize: 11.5 }}>
                    {r.detail}
                  </td>
                  <td>{tok(r.tokensIn)}</td>
                  <td>{tok(r.tokensOut)}</td>
                  <td>{r.seconds.toFixed(1)} s</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="cfg-three">
            <div className="ai-card" style={{ padding: 10 }}>
              <div className="ai-label">Input</div>
              <b>{res.tokensIn.toLocaleString()} tokens</b>
              <div className="ai-muted">of {res.maxTokens.toLocaleString()} per run</div>
            </div>
            <div className="ai-card" style={{ padding: 10 }}>
              <div className="ai-label">Output</div>
              <b>{res.tokensOut.toLocaleString()} tokens</b>
            </div>
            <div className="ai-card" style={{ padding: 10 }}>
              <div className="ai-label">Cost</div>
              <b>≈ {money(res.costUsd)}</b>
              <div className="ai-muted">from the sample price table</div>
            </div>
          </div>
          {res.finalText && <div className="cfg-mono-box">{res.finalText}</div>}
          {res.notes.map((n) => (
            <div key={n} className="ai-hint">
              {n}
            </div>
          ))}
        </div>
      )}
    </CfgCard>
  );
}
