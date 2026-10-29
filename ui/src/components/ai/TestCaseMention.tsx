import { useState } from 'react';
import { aiApi, useAiMutation } from '../../api/ai';
import { extractError } from '../../api/extractError';
import { useToast } from '../Toast';
import { mentionedAi } from './MentionIntent';
import { useAiBoardState } from './aiUi';
import './ticketWork.css';

/**
 * A mention of an AI member in a test case note (design B4). A test case is not a ticket: the mention can only Ask
 * or Just notify, and the answer lands as a ticket comment linking to the case. Saving the note never starts a run;
 * Ask is its own button.
 */
export function TestCaseMention({ ticketId, code, notes }: { ticketId: string; code?: string; notes: string }) {
  const { members } = useAiBoardState();
  const toast = useToast();
  const [intent, setIntent] = useState<'ask' | 'notify'>('ask');
  const [sent, setSent] = useState<string | null>(null);
  const ask = useAiMutation((v: { memberId: string; question: string }) =>
    aiApi.ask(ticketId, { memberId: v.memberId, question: v.question, source: 'test_case', ref: code }),
  );
  const ais = mentionedAi(notes, members);
  if (!ais.length) return null;
  const target = ais[0];
  const question = notes.replace(/@\[([^\][\n]{1,100})\]\(member:[\w.-]{1,64}\)/g, '@$1').trim();
  return (
    <div className="tw-tcm" data-testid="tc-mention">
      <span className="ai-label">{target.name} is mentioned</span>
      <span className="tw-seg" role="radiogroup" aria-label="What the mention means">
        {(
          [
            ['ask', 'Ask'],
            ['notify', 'Just notify'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={intent === id}
            className={intent === id ? 'tw-seg-on' : ''}
            onClick={() => setIntent(id)}
            data-testid={`tc-mention-${id}`}
          >
            {label}
          </button>
        ))}
      </span>
      {intent === 'ask' ? (
        <button
          type="button"
          className="ai-btn ai-btn-sm ai-btn-primary"
          disabled={ask.isPending || sent === notes}
          data-testid="tc-mention-send"
          onClick={async () => {
            try {
              await ask.mutateAsync({ memberId: target.id, question });
              setSent(notes);
              toast.success(`Asked ${target.name}`, `The answer lands as a comment linking to ${code ?? 'this case'}.`);
            } catch (err) {
              toast.error("Couldn't ask", extractError(err));
            }
          }}
        >
          {sent === notes ? 'Asked' : `Ask ${target.name}`}
        </button>
      ) : (
        <span className="ai-muted">Nothing runs; it is the same as mentioning a person.</span>
      )}
      <div className="ai-hint" style={{ flexBasis: '100%' }}>
        A test case is not a ticket: a mention here can only <b>Ask</b> or <b>Just notify</b>, and the answer lands as a
        ticket comment linking to {code ?? 'this case'}.
      </div>
    </div>
  );
}
