import { useState } from 'react';
import { aiApi, useAiMutation } from '../../api/ai';
import { extractError } from '../../api/extractError';
import { useToast } from '../Toast';
import { mentionedAi } from './ComposerAi';
import { useAiBoardState } from './aiUi';
import './ticketWork.css';

/**
 * A mention of an AI team in a test case note (design B4). A test case is not a ticket: the note goes to the team as
 * a message, and the answer lands as a ticket comment linking to the case. Saving the note never starts a run; the one
 * button, "Send to {team}", does.
 */
export function TestCaseMention({ ticketId, code, notes }: { ticketId: string; code?: string; notes: string }) {
  const { members } = useAiBoardState();
  const toast = useToast();
  const [sent, setSent] = useState<string | null>(null);
  const send = useAiMutation((v: { memberId: string; question: string }) =>
    aiApi.run(ticketId, { teamId: v.memberId, instruction: code ? `Test case ${code}: ${v.question}` : v.question }),
  );
  const ais = mentionedAi(notes, members);
  if (!ais.length) return null;
  const target = ais[0];
  const question = notes.replace(/@\[([^\][\n]{1,100})\]\(member:[\w.-]{1,64}\)/g, '@$1').trim();
  return (
    <div className="tw-tcm" data-testid="tc-mention">
      <span className="ai-label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12, fontWeight: 600 }}>
        {target.name} is mentioned
      </span>
      <span style={{ flex: 1 }} />
      <button
        type="button"
        className="ai-btn ai-btn-sm ai-btn-primary"
        disabled={send.isPending || sent === notes}
        data-testid="tc-mention-send"
        onClick={async () => {
          try {
            await send.mutateAsync({ memberId: target.id, question });
            setSent(notes);
            toast.success(`Sent to ${target.name}`, `The answer lands as a comment linking to ${code ?? 'this case'}.`);
          } catch (err) {
            toast.error("Couldn't send the note", extractError(err));
          }
        }}
      >
        {sent === notes ? 'Sent' : `Send to ${target.name}`}
      </button>
      <div className="ai-hint" style={{ flexBasis: '100%' }}>
        A test case is not a ticket: the note goes to the team as a message, and the answer lands as a ticket comment
        linking to {code ?? 'this case'}.
      </div>
    </div>
  );
}
