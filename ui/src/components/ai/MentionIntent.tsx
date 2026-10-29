import { useCallback, useRef, useState } from 'react';
import type { AiMember } from '../../types/ai';
import { AiAvatar, useAiBoardState } from './aiUi';

export type MentionIntent = 'ask' | 'work' | 'notify';

/** How the composer sends a comment: the chosen meaning of its mentions, or a question for one AI (the Ask button). */
export interface SendOpts {
  /** Meaning of the mentions, chosen in the Send menu (skips the “What does the mention mean?” dialog). */
  intent?: MentionIntent;
  /** Ask this AI member the text as a question: a comment that mentions it, plus a short answer run. */
  askMemberId?: string;
  /** The comment this one answers; under an AI's comment it asks that AI again. */
  replyTo?: string;
}

const MENTION = /@\[([^\][\n]{1,100})\]\(member:([\w.-]{1,64})\)/g;

/** AI members mentioned in a text, in order. */
export function mentionedAi(text: string, members: Map<string, AiMember>): AiMember[] {
  const out: AiMember[] = [];
  for (const m of text.matchAll(MENTION)) {
    const ai = members.get(m[2]);
    if (ai && ai.kind === 'ai' && !out.includes(ai)) out.push(ai);
  }
  return out;
}

/**
 * “What does the mention mean?” (B3): asked when a comment mentions an AI member. Returns a function that resolves
 * to the chosen meaning (or null when the person goes back), and the dialog to render.
 */
export function useMentionIntent(ticketId: string) {
  const { members } = useAiBoardState();
  const [state, setState] = useState<{ ais: AiMember[]; resolve: (v: MentionIntent | null) => void } | null>(null);
  const remembered = useRef<MentionIntent | null>(null);
  const key = `kanban.ai.mentionIntent.${ticketId}`;

  const choose = useCallback(
    (text: string): Promise<MentionIntent | null | undefined> => {
      const ais = mentionedAi(text, members);
      if (!ais.length) return Promise.resolve(undefined);
      try {
        const saved = localStorage.getItem(key) as MentionIntent | null;
        if (saved) return Promise.resolve(saved);
      } catch {
        /* storage unavailable */
      }
      if (remembered.current) return Promise.resolve(remembered.current);
      return new Promise((resolve) => setState({ ais, resolve }));
    },
    [members, key],
  );

  const dialog = state ? (
    <MentionDialog
      ais={state.ais}
      onDone={(intent, remember) => {
        if (intent && remember) {
          remembered.current = intent;
          try {
            localStorage.setItem(key, intent);
          } catch {
            /* storage unavailable */
          }
        }
        state.resolve(intent);
        setState(null);
      }}
    />
  ) : null;
  return { choose, dialog };
}

function MentionDialog({
  ais,
  onDone,
}: {
  ais: AiMember[];
  onDone: (i: MentionIntent | null, remember: boolean) => void;
}) {
  const [intent, setIntent] = useState<MentionIntent>('ask');
  const [remember, setRemember] = useState(false);
  const names = ais.map((a) => a.name).join(', ');
  const opts: { id: MentionIntent; title: string; sub: string; tag?: string }[] = [
    {
      id: 'ask',
      title: 'Ask (answer in a comment)',
      sub: 'It reads the ticket and replies below, as one short run. No files or fields change.',
      tag: 'Default',
    },
    {
      id: 'work',
      title: 'Do the work (assign + run)',
      sub: 'Assigns this ticket to it and starts a run with this comment as the instruction. Moves up to its ceiling at most.',
    },
    {
      id: 'notify',
      title: 'Just notify',
      sub: 'Same as mentioning a person. It gets a notification and nothing runs.',
    },
  ];
  return (
    <div className="ai-overlay" onClick={() => onDone(null, false)}>
      <div
        className="ai-modal"
        style={{ width: 480 }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="What does the mention mean"
        data-testid="mention-intent"
      >
        <div className="ai-modal-head" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {ais.map((a) => (
            <AiAvatar key={a.id} provider={a.provider} color={a.color} glyph={a.glyph} size={28} />
          ))}
          <div>
            <h2 className="ai-modal-title" style={{ fontSize: 15 }}>
              You mentioned {names}
            </h2>
            <div className="ai-hint">What should happen when you send this comment?</div>
          </div>
        </div>
        <div className="ai-modal-body" style={{ gap: 8 }}>
          {opts.map((o) => (
            <button
              key={o.id}
              type="button"
              className={`ai-option ${intent === o.id ? 'ai-option-active' : ''}`}
              onClick={() => setIntent(o.id)}
              data-testid={`mention-${o.id}`}
            >
              <span className={`ai-radio ${intent === o.id ? 'ai-radio-on' : ''}`} />
              <span>
                <b style={{ fontSize: 13 }}>{o.title}</b>
                {o.tag && (
                  <span
                    className="ai-chip"
                    style={{ marginLeft: 6, height: 18, background: '#F1F8F3', color: '#2E6F40' }}
                  >
                    {o.tag}
                  </span>
                )}
                <div className="ai-muted">{o.sub}</div>
              </span>
            </button>
          ))}
          <label style={{ display: 'flex', gap: 8, fontSize: 12.5, alignItems: 'center' }}>
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember my
            choice for comments on this ticket
          </label>
        </div>
        <div className="ai-modal-foot">
          <span style={{ flex: 1 }} />
          <button type="button" className="ai-btn" onClick={() => onDone(null, false)}>
            Back
          </button>
          <button
            type="button"
            className="ai-btn ai-btn-primary"
            onClick={() => onDone(intent, remember)}
            data-testid="mention-send"
          >
            Send comment
          </button>
        </div>
      </div>
    </div>
  );
}
