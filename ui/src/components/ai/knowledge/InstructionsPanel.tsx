import { useState } from 'react';
import { useSaveInstructions } from '../../../api/aiKnowledge';
import { extractError } from '../../../api/extractError';
import type { Knowledge } from '../../../types/aiKnowledge';
import { shortDate } from '../aiUi';

export const INSTRUCTIONS_MAX = 40000;

/** Instructions for every AI on the project: shown, edited in place, and the earlier versions. */
export function InstructionsPanel({ projectId, data }: { projectId: string; data: Knowledge }) {
  const save = useSaveInstructions(projectId);
  const [draft, setDraft] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [viewing, setViewing] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const editing = draft !== null;
  const tooLong = (draft?.length ?? 0) > INSTRUCTIONS_MAX;

  const commit = async () => {
    if (draft === null) return;
    setError(null);
    try {
      await save.mutateAsync(draft);
      setDraft(null);
    } catch (e) {
      setError(extractError(e));
    }
  };

  return (
    <div className="ai-card" data-testid="instructions-panel" style={{ padding: 12, display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <b style={{ fontSize: 13.5, flex: 1 }}>Instructions for every AI on this project</b>
        <span className="ai-tab-count" data-testid="instructions-tokens">
          {data.instructionsTokens.toLocaleString('en-US')} tokens
        </span>
      </div>
      {editing ? (
        <>
          <textarea
            className={`ai-textarea${tooLong ? ' ai-input-error' : ''}`}
            style={{ minHeight: 200, fontFamily: "'JetBrains Mono', monospace" }}
            aria-label="Instructions"
            data-testid="instructions-editor"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="ai-hint" style={tooLong ? { color: '#c4432a' } : undefined}>
            {draft.length.toLocaleString('en-US')} / {INSTRUCTIONS_MAX.toLocaleString('en-US')} characters
          </div>
        </>
      ) : data.instructions.trim() ? (
        <pre
          data-testid="instructions-text"
          style={{
            margin: 0,
            whiteSpace: 'pre-wrap',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 12.5,
            lineHeight: 1.55,
            background: '#f6faf7',
            borderRadius: 8,
            padding: 12,
            maxHeight: 320,
            overflow: 'auto',
          }}
        >
          {data.instructions}
        </pre>
      ) : (
        <div className="ai-hint" data-testid="instructions-empty">
          Nothing written yet. Conventions, commands and what not to touch go here, once, for every member.
        </div>
      )}
      {error && (
        <div className="ai-error-text" role="alert">
          {error}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {editing ? (
          <>
            <button
              className="ai-btn ai-btn-primary ai-btn-sm"
              data-testid="instructions-save"
              disabled={save.isPending || tooLong || draft === data.instructions}
              onClick={() => void commit()}
            >
              Save
            </button>
            <button
              className="ai-btn ai-btn-sm"
              disabled={save.isPending}
              onClick={() => {
                setDraft(null);
                setError(null);
              }}
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <button
              className="ai-btn ai-btn-sm"
              data-testid="instructions-edit"
              onClick={() => setDraft(data.instructions)}
            >
              Edit
            </button>
            <button
              className="ai-btn ai-btn-sm"
              data-testid="instructions-history"
              aria-expanded={showHistory}
              onClick={() => setShowHistory((v) => !v)}
            >
              History{data.history.length ? ` · ${data.history.length}` : ''}
            </button>
          </>
        )}
        <span className="ai-hint" style={{ marginLeft: 'auto' }}>
          {data.updatedBy ? `Written by ${data.updatedBy}` : 'Written by you'}
          {data.updatedAt ? ` · ${shortDate(data.updatedAt)}` : ''}.
        </span>
      </div>
      <div className="ai-hint">
        It goes into the system prompt of every run on this project, before the member&rsquo;s own persona. A change
        takes effect on the next run; a conversation already running keeps its prompt.
      </div>
      {showHistory && (
        <div data-testid="instructions-history-list" style={{ borderTop: '1px solid #eef3ef', paddingTop: 8 }}>
          {data.history.length === 0 ? (
            <div className="ai-hint">No earlier versions yet.</div>
          ) : (
            data.history.map((h, i) => (
              <div key={`${h.at}-${i}`} style={{ padding: '4px 0' }}>
                <button
                  className="ai-btn ai-btn-sm"
                  aria-expanded={viewing === i}
                  onClick={() => setViewing(viewing === i ? null : i)}
                >
                  {shortDate(h.at)} · {h.by ?? 'unknown'}
                </button>
                {viewing === i && (
                  <pre
                    data-testid="instructions-version"
                    style={{ whiteSpace: 'pre-wrap', fontSize: 12, margin: '6px 0 0', color: '#5b6b60' }}
                  >
                    {h.text || '(empty)'}
                  </pre>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
