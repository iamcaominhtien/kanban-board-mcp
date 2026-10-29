import { useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { extractError } from '../../../api/extractError';
import { PROVIDERS } from '../aiUi';
import { configApi, type PromptPreview } from './configApi';
import { adapterOf, useCfg } from './configCtx';
import {
  CfgCard,
  Chip,
  CodeEditor,
  CopyButton,
  Dialog,
  IssueText,
  ModeChip,
  TickRow,
  estimateTokens,
  tok,
} from './parts';

const VARS = ['ticket', 'project', 'docs', 'comments'];
const PROMPT_BUDGET = 8000;

/** Text with the library snippets expanded the way the board writes them (kanban:include markers). */
function expanded(text: string, snippets: { name: string; version: number; content: string }[]): string {
  return text.replace(/<!--\s*kanban:include\s+([A-Za-z0-9_-]+)@v(\d+)\s*-->/g, (m, name: string, v: string) => {
    const s = snippets.find((x) => x.name === name && x.version === Number(v));
    return s ? `${m}\n${s.content.trimEnd()}` : m;
  });
}

/** Library snippets attached to the instructions (“Library · commit-conventions v3”). */
function SnippetChips() {
  const { cfg, setCfg, pickLibrary } = useCfg();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span className="ai-label">Library snippets</span>
      {cfg.snippets.map((s) => (
        <Chip key={s.libraryId} tone="lib">
          Library · {s.name} v{s.version}
          <button
            type="button"
            aria-label={`Detach ${s.name}`}
            style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0, color: 'inherit' }}
            onClick={() =>
              setCfg({
                snippets: cfg.snippets.filter((x) => x.libraryId !== s.libraryId),
                instructions: cfg.instructions.replace(
                  new RegExp(`\\n*<!--\\s*kanban:include\\s+${s.name}@v\\d+\\s*-->`, 'g'),
                  '',
                ),
              })
            }
          >
            ×
          </button>
        </Chip>
      ))}
      <button type="button" className="ai-link" onClick={() => pickLibrary(['snippet'])}>
        Attach snippet
      </button>
    </div>
  );
}

/** Instructions of a Claude Code member: CLAUDE.md between the board's markers, user scope documented (design B1). */
function ClaudeInstructions() {
  const { cfg, setCfg, draft, setDraft, issues, status, tick } = useCfg();
  const [scope, setScope] = useState<'project' | 'user'>('project');
  const tokens = estimateTokens(expanded(cfg.instructions, cfg.snippets));
  const userItem = status?.documented.find((d) => d.key === 'user_instructions');
  return (
    <CfgCard
      id="cfg-instructions"
      testId="card-instructions"
      title="Instructions"
      mode="synced"
      right={<span className="ai-muted">≈ {tok(tokens)} tokens</span>}
      sub="Becomes CLAUDE.md. Kanban writes only between its own markers."
    >
      <div className="cfg-pills">
        <button
          type="button"
          className={`cfg-pill ${scope === 'project' ? 'cfg-pill-on' : ''}`}
          onClick={() => setScope('project')}
        >
          Project · CLAUDE.md
        </button>
        <button
          type="button"
          className={`cfg-pill ${scope === 'user' ? 'cfg-pill-on' : ''}`}
          onClick={() => setScope('user')}
        >
          User · ~/.claude/CLAUDE.md
        </button>
      </div>
      {scope === 'project' ? (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="ai-mono" style={{ fontSize: 12, fontWeight: 700 }}>
              CLAUDE.md
            </span>
            <ModeChip mode="synced" />
          </div>
          <CodeEditor
            testId="cfg-instructions-editor"
            ariaLabel="CLAUDE.md"
            path="instructions"
            rows={10}
            value={cfg.instructions}
            onChange={(v) => setCfg({ instructions: v })}
            placeholder={
              '# Backend rules\n\n## Working agreements\n- Work inside /server unless the ticket says otherwise.\n- Post a summary comment on the ticket when you finish.'
            }
          />
          <IssueText issues={issues} path="instructions" />
          <SnippetChips />
        </>
      ) : (
        <>
          <div className="ai-notice ai-notice-slate">
            User scope is always Documented: the board never writes into your home folder, it shows copy-able text and
            an “I’ve done this” tick.
          </div>
          <CodeEditor
            testId="cfg-user-instructions"
            ariaLabel="User CLAUDE.md"
            rows={7}
            value={cfg.userInstructions}
            onChange={(v) => setCfg({ userInstructions: v })}
            placeholder="# Notes for every project on this computer"
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <CopyButton text={cfg.userInstructions} />
            <span className="ai-muted" style={{ alignSelf: 'center' }}>
              Paste it into ~/.claude/CLAUDE.md on the computer where the runner lives.
            </span>
          </div>
          {userItem && !userItem.empty && <TickRow item={userItem} onTick={(d) => void tick('user_instructions', d)} />}
        </>
      )}
      <div className="ai-field">
        <span className="ai-label ai-label-dark">Role / persona</span>
        <textarea
          className="ai-textarea"
          value={draft.persona}
          onChange={(e) => setDraft({ persona: e.target.value })}
        />
        <span className="ai-hint">
          {draft.persona.length} / 1000 · added to the system prompt of every run; visible to members.
        </span>
      </div>
    </CfgCard>
  );
}

/** Rules of an Antigravity member: Documented, copy and tick (design C2). */
function AntigravityRules() {
  const { cfg, setCfg, draft, setDraft, member, status, tick, issues } = useCfg();
  const text = expanded(cfg.instructions, cfg.snippets);
  const item = status?.documented.find((d) => d.key === 'instructions');
  const lib = cfg.snippets.map((s) => `${s.name} v${s.version}`).join(', ');
  return (
    <CfgCard
      id="cfg-instructions"
      testId="card-instructions"
      title="Rules — setup instructions"
      mode="documented"
      sub={`Do this once on the computer where the runner lives.`}
    >
      <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.7 }}>
        <li>
          Open the working folder <span className="ai-code">{member.workingDir || '(not set)'}</span> in Antigravity.
        </li>
        <li>
          Open its rules settings (exact menu name: TODO verify) and paste the text below, then tick “I’ve done this”.
        </li>
      </ol>
      <div className="ai-field">
        <span className="ai-label ai-label-dark">Rules text{lib ? ` · from library ${lib}` : ''}</span>
        <CodeEditor
          testId="cfg-instructions-editor"
          ariaLabel="Rules text"
          path="instructions"
          rows={8}
          value={cfg.instructions}
          onChange={(v) => setCfg({ instructions: v })}
          placeholder={
            '# UI rules\n- React + TypeScript, components in /ui/src/components.\n- Use the existing design tokens; no new colors.'
          }
        />
        <IssueText issues={issues} path="instructions" />
      </div>
      <SnippetChips />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <CopyButton text={text} />
        <span className="ai-muted">The copy includes attached library snippets.</span>
      </div>
      <TickRow item={item} onTick={(d) => void tick('instructions', d)} />
      <div className="ai-hint">
        If the rules text changes later, the tick is cleared and you are asked to copy it again. Kanban cannot look
        inside Antigravity, so the tick is a reminder, not a check.
      </div>
      <div className="ai-field">
        <span className="ai-label ai-label-dark">Role / persona</span>
        <textarea
          className="ai-textarea"
          value={draft.persona}
          onChange={(e) => setDraft({ persona: e.target.value })}
        />
      </div>
    </CfgCard>
  );
}

/** The rendered prompt for a sample ticket, with the token sources (design D1 “Preview with KAN-142”). */
function PromptPreviewDialog({ ticketId, onClose }: { ticketId: string; onClose: () => void }) {
  const { member, cfg } = useCfg();
  const q = useQuery<PromptPreview>({
    queryKey: [
      'ai',
      'prompt-preview',
      member.id,
      ticketId,
      JSON.stringify([cfg.instructions, cfg.context, cfg.snippets, cfg.output]),
    ],
    queryFn: () => configApi.promptPreview(member.id, cfg, ticketId),
    retry: false,
  });
  return (
    <Dialog
      title={`Prompt preview · ${ticketId}`}
      sub="Exactly what the model gets for a run on this ticket, with your unsaved settings."
      width={760}
      onClose={onClose}
      foot={
        <>
          <span style={{ flex: 1 }} />
          <button type="button" className="ai-btn" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      {q.isLoading && <div className="ai-skel" style={{ height: 200 }} />}
      {q.isError && <div className="ai-notice ai-notice-error">{extractError(q.error)}</div>}
      {q.data && (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Chip>System ≈ {tok(q.data.systemTokens)}</Chip>
            <Chip>Message ≈ {tok(q.data.userTokens)}</Chip>
            <Chip>Ticket ≈ {tok(q.data.sources.ticket)}</Chip>
            <Chip>Docs ≈ {tok(q.data.sources.docs)}</Chip>
            <Chip>Comments ≈ {tok(q.data.sources.comments)}</Chip>
            {q.data.used.length > 0 && <Chip tone="lib">Variables used: {q.data.used.join(', ')}</Chip>}
          </div>
          <span className="ai-label">System message</span>
          <div
            className="cfg-mono-box"
            data-testid="prompt-preview-system"
            style={{ maxHeight: 260, overflow: 'auto' }}
          >
            {q.data.system}
          </div>
          <span className="ai-label">First user message</span>
          <div className="cfg-mono-box" data-testid="prompt-preview-user" style={{ maxHeight: 200, overflow: 'auto' }}>
            {q.data.user}
          </div>
        </>
      )}
    </Dialog>
  );
}

/** System prompt of an API agent: variables, preview, token budget, unknown-variable error (design D1). */
function ApiPrompt() {
  const { member, cfg, setCfg, draft, setDraft, issues } = useCfg();
  const insertRef = useRef<((t: string) => void) | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const tickets = useQuery({
    queryKey: ['ai', 'sample-tickets', member.projectId],
    queryFn: () => configApi.sampleTickets(member.projectId),
  });
  const models = useQuery({
    queryKey: ['ai', 'models', member.id],
    queryFn: () => configApi.models(member.id),
    staleTime: 60_000,
  });
  const text = expanded(cfg.instructions, cfg.snippets);
  const tokens = estimateTokens(text);
  const lineIssues = issues.filter((i) => i.path === 'instructions' && i.line);
  const bad = lineIssues.map((i) => i.line as number);
  const mark = useMemo(
    () =>
      cfg.instructions
        .split('\n')
        .map((l, i) => (VARS.some((v) => l.includes(`{{${v}}}`)) ? i + 1 : 0))
        .filter(Boolean),
    [cfg.instructions],
  );
  const first = tickets.data?.[0]?.id;
  const options = models.data?.models ?? [];
  const known = options.some((m) => m.id === draft.model);
  return (
    <CfgCard
      id="cfg-instructions"
      testId="card-instructions"
      title="System prompt"
      mode="direct"
      sub="The board sends this as the system message on every run."
    >
      <div className="cfg-three">
        <div className="ai-field">
          <span className="ai-label ai-label-dark">Provider</span>
          <input className="ai-input" disabled value={PROVIDERS[member.provider].label} />
        </div>
        <div className="ai-field">
          <span className="ai-label ai-label-dark">Model</span>
          {options.length ? (
            <select
              id="cfg-model"
              data-path="model"
              className="ai-select"
              value={draft.model}
              onChange={(e) => setDraft({ model: e.target.value })}
            >
              {!known && <option value={draft.model}>{draft.model || 'Choose a model'}</option>}
              {options.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              id="cfg-model"
              data-path="model"
              className="ai-input ai-mono"
              value={draft.model}
              onChange={(e) => setDraft({ model: e.target.value })}
            />
          )}
          {models.data && (
            <span className="ai-muted">
              {models.data.source === 'provider' ? 'List from the provider' : (models.data.error ?? 'Built-in list')}
            </span>
          )}
        </div>
        <div className="ai-field">
          <span className="ai-label ai-label-dark">Key</span>
          <input className="ai-input ai-mono" disabled value={member.keyLast4 ? `••••${member.keyLast4}` : '—'} />
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span className="ai-label">Insert variable</span>
        {VARS.map((v) => (
          <button
            key={v}
            type="button"
            className="ai-chip cfg-chip-lib ai-mono"
            style={{ border: 'none', cursor: 'pointer' }}
            onClick={() => insertRef.current?.(`{{${v}}}`)}
          >
            {`{{${v}}}`}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button type="button" className="ai-link" disabled={!first} onClick={() => first && setPreviewing(first)}>
          Preview with {first ?? 'a ticket'}
        </button>
      </div>
      <div className="ai-field">
        <div style={{ display: 'flex' }}>
          <span className="ai-label ai-label-dark" style={{ flex: 1 }}>
            System prompt
          </span>
          <span
            className="ai-muted"
            style={{ color: tokens > PROMPT_BUDGET ? '#c4432a' : undefined }}
            data-testid="prompt-tokens"
          >
            ≈ {tokens.toLocaleString()} / {PROMPT_BUDGET.toLocaleString()} tokens
          </span>
        </div>
        <CodeEditor
          testId="cfg-instructions-editor"
          ariaLabel="System prompt"
          path="instructions"
          rows={10}
          value={cfg.instructions}
          insertRef={insertRef}
          bad={bad}
          mark={mark}
          onChange={(v) => setCfg({ instructions: v })}
          placeholder={'You are Reviewer, an AI member of the project {{project}}.\n\nTicket\n{{ticket}}'}
        />
        <IssueText issues={issues} path="instructions" />
      </div>
      <SnippetChips />
      <div className="ai-field">
        <span className="ai-label ai-label-dark">Role / persona</span>
        <textarea
          className="ai-textarea"
          value={draft.persona}
          onChange={(e) => setDraft({ persona: e.target.value })}
        />
        <span className="ai-hint">
          {draft.persona.length} / 1000 · added to the system prompt of every run; visible to members.
        </span>
      </div>
      {previewing && <PromptPreviewDialog ticketId={previewing} onClose={() => setPreviewing(null)} />}
    </CfgCard>
  );
}

/** The instructions card for the member's adapter. */
export function InstructionsCard() {
  const { member } = useCfg();
  const kind = adapterOf(member);
  if (kind === 'claude-code') return <ClaudeInstructions />;
  if (kind === 'antigravity') return <AntigravityRules />;
  return <ApiPrompt />;
}
