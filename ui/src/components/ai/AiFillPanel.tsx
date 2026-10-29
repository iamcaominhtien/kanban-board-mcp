import { useEffect, useRef, useState } from 'react';
import { assistApi, assistError, useAssistState, useChat } from '../../api/assist';
import { extractError } from '../../api/extractError';

/** One member as the Board AI proposes it for the dialog's form (already checked by the server). */
export interface AiFilled {
  name: string;
  description: string;
  persona: string;
  template: 'developer' | 'reviewer' | 'read_only';
  ceiling: string;
  maxParallel: number;
  maxRunsPerDay: number;
  readOnlyCli: boolean;
  model: string;
}

interface Props {
  projectId: string;
  /** The form as the person has it now; sent with every message so hand edits are kept. */
  form: Record<string, unknown>;
  onFill: (m: AiFilled) => void;
}

/**
 * "Ask AI to fill this in": the person describes the member, the Board AI (or an AI member standing in) fills the
 * form, and they keep prompting to refine it. It only fills fields; the person still presses Create.
 */
export function AiFillPanel({ projectId, form, onFill }: Props) {
  const assist = useAssistState(projectId);
  const board = assist.data?.boardAi;
  const ready = board?.state === 'ready' || !!board?.fallback;
  const [open, setOpen] = useState(false);
  const [chatId, setChatId] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; filled: boolean; problems: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const chat = useChat(chatId);
  const handled = useRef<string | null>(null);

  useEffect(() => {
    if (!pending) return;
    const m = chat.data?.messages.find((x) => x.id === pending);
    if (!m || ['queued', 'thinking', 'streaming', 'rate_limited'].includes(m.state)) return;
    if (handled.current === m.id) return;
    handled.current = m.id;
    setPending(null);
    if (m.state !== 'done') {
      setError(m.error?.message || 'The AI could not answer. Try again, or fill the form by hand.');
      return;
    }
    const ctx = m.context as { memberForm?: AiFilled; memberFormNotes?: string[] };
    if (ctx.memberForm) onFill(ctx.memberForm);
    setNote({ text: m.text.replace(/\*\*|`/g, ''), filled: !!ctx.memberForm, problems: ctx.memberFormNotes ?? [] });
    setText('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.data, pending]);

  async function ask() {
    const q = text.trim();
    if (!q || pending) return;
    setError(null);
    try {
      let id = chatId;
      if (!id) {
        id = (await assistApi.createChat(projectId, { scope: 'project' })).id;
        setChatId(id);
      }
      const r = await assistApi.send(id, { text: q, memberForm: form });
      setPending(r.ai.id);
    } catch (err) {
      setError(String(assistError(err)?.message ?? extractError(err)));
    }
  }

  if (assist.isLoading) return null;
  const busy = !!pending;
  return (
    <div className="ai-fill" data-testid="ai-fill">
      <div className="ai-fill-head">
        <button
          type="button"
          className="ai-btn"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          data-testid="ai-fill-toggle"
        >
          ✦ Ask AI to fill this in
        </button>
        <span className="ai-hint">
          {ready
            ? `${board?.name ?? board?.fallback?.name} drafts the fields from your description. You review and create.`
            : 'Choose a Board AI (Members → Board AI) to get help here.'}
        </span>
      </div>
      {open && ready && (
        <div className="ai-fill-body">
          <textarea
            className="ai-textarea"
            rows={3}
            value={text}
            disabled={busy}
            placeholder={
              note
                ? 'Ask for a change, e.g. “stricter, and use Sonnet”'
                : 'Describe the member, e.g. “a reviewer that never lets a ticket pass without tests”'
            }
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void ask();
            }}
            data-testid="ai-fill-input"
          />
          <div className="ai-fill-actions">
            <button
              type="button"
              className="ai-btn ai-btn-primary"
              onClick={() => void ask()}
              disabled={busy || !text.trim()}
              data-testid="ai-fill-send"
            >
              {busy ? (
                <>
                  <span className="ai-spin" /> Thinking…
                </>
              ) : note ? (
                'Refine'
              ) : (
                'Suggest'
              )}
            </button>
            <span className="ai-hint">Ctrl+Enter sends. Edit any field by hand at any time.</span>
          </div>
          {error && <span className="ai-error-text">{error}</span>}
          {note && (
            <div className="ai-notice ai-notice-info" data-testid="ai-fill-note">
              <span>
                {note.text}
                {note.filled && (
                  <em style={{ display: 'block' }} data-testid="ai-fill-filled">
                    The fields below are filled in. Check each one before you continue.
                  </em>
                )}
                {note.problems.map((p) => (
                  <em key={p} style={{ display: 'block' }}>
                    {p}
                  </em>
                ))}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
