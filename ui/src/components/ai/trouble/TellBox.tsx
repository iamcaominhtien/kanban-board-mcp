import { useState } from 'react';
import { aiOpsApi, deliveredWords } from '../../../api/aiOps';
import { extractError } from '../../../api/extractError';
import type { AiRun } from '../../../types/ai';
import './trouble.css';

/**
 * "Send to the AI" (design/screens/ai-team-process.md, J): one sentence to an AI that is working right now. The box
 * says which way it went, so it never looks like it worked when it was only held for the next turn.
 */
export function TellBox({ run }: Readonly<{ run: AiRun }>) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (run.state !== 'running') return null;
  const send = async () => {
    setBusy(true);
    setError(null);
    setSaid(null);
    try {
      const r = await aiOpsApi.tell(run.id, text.trim());
      setSaid(deliveredWords(r.delivered));
      setText('');
    } catch (err) {
      setError(extractError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="tc-tell" data-testid="tell-box">
      <b style={{ fontSize: 12.5 }}>Send to the AI</b>
      <div className="tc-tellrow">
        <textarea
          className="ai-input"
          rows={1}
          value={text}
          placeholder={`A sentence to ${run.memberName}. The run carries on.`}
          aria-label="Send to the AI"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && text.trim() && !busy) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button
          type="button"
          className="ai-btn ai-btn-sm ai-btn-primary"
          disabled={busy || !text.trim()}
          onClick={() => void send()}
        >
          Send
        </button>
      </div>
      {said && (
        <div className="ai-hint" role="status">
          {said}
        </div>
      )}
      {error && (
        <div className="ai-error-text" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
