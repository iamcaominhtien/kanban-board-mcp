import { useState } from 'react';
import { useBoardAi, useUpdateBoardAi } from '../../../api/aiBoard';
import { extractError } from '../../../api/extractError';
import { LoadError, Toggle } from '../aiUi';
import { OP_WORDS } from './tierWords';

/** What the Board AI may do by itself (design/screens/ai-board-wave3.md, A–C): three tiers, the locked set. */
export function BoardAiSection({ projectId }: { projectId: string }) {
  const q = useBoardAi(projectId);
  const save = useUpdateBoardAi(projectId);
  const [error, setError] = useState<string | null>(null);

  const patch = (body: Parameters<typeof save.mutate>[0]) => {
    setError(null);
    save.mutate(body, { onError: (e) => setError(extractError(e)) });
  };

  if (q.isError) return <LoadError what="the Board AI settings" error={q.error} onRetry={() => void q.refetch()} />;
  if (!q.data) return <div className="as-skel" style={{ height: 120 }} data-testid="board-ai-loading" />;
  const view = q.data;
  // setting up the AI team follows its own switch (below)
  const team = view.tiers.filter((r) => r.team);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }} data-testid="board-ai-section">
      <div className="ai-card" style={{ padding: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Acts as you</div>
          <div className="ai-hint">
            The Board AI does the small, reversible things itself and keeps an Undo. Anything that cannot be walked back
            asks first. The audit says &ldquo;you (through the Board AI)&rdquo;, never the AI alone.
          </div>
        </div>
        <Toggle
          on={view.acts}
          label="Acts as you"
          testId="board-ai-acts"
          disabled={save.isPending}
          onChange={(next) => patch({ acts: next })}
        />
      </div>

      <div
        className="ai-card"
        style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}
        data-testid="board-ai-team"
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>Manages the AI team</div>
            <div className="ai-hint">
              Sets up the AI members without asking: makes them from role packs, gives them a role, installs plugins and
              skills, adds MCP servers and hooks, and says what each one could use. Every change keeps an Undo and is in
              the audit log. Off: each one asks you first. Only the project owner can turn it on.
            </div>
          </div>
          <Toggle
            on={view.managesTeam}
            label="Manages the AI team"
            testId="board-ai-manages-team"
            disabled={save.isPending}
            onChange={(next) => patch({ managesTeam: next })}
          />
        </div>
        {view.managesTeam && (
          <div className="ai-notice ai-notice-warn" role="note" data-testid="board-ai-team-warning">
            An MCP server or a hook runs a command on this computer. The Board AI says the command on each change and
            the audit log keeps it; text in tickets and Docs that tries to make it add one is treated as data, not as
            your words.
          </div>
        )}
        <ul style={{ margin: 0, paddingLeft: 17, fontSize: 12, lineHeight: 1.55, color: '#3A4A3E' }}>
          {team.map((r) => (
            <li key={r.op} data-testid={`team-op-${r.op}`}>
              {OP_WORDS[r.op] ?? r.op}
            </li>
          ))}
        </ul>
      </div>

      {error && (
        <div className="ai-notice ai-notice-error" role="alert" data-testid="board-ai-error">
          {error}
        </div>
      )}
    </div>
  );
}
