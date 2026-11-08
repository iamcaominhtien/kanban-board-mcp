import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useIdeaAiStatus } from '../../api/ideaAi';
import type { Idea } from '../../types/idea';
import { useAiBoardState } from '../ai/aiUi';
import { ScopedChat } from '../assist/ScopedChat';
import { LineIcon } from '../ui/LineIcon';

/**
 * The "Ask AI" button of the idea page header. Nothing is drawn while AI help is off for the project, like
 * "Shape with AI"; with no team or a reached cap the chat opens and says why it cannot answer.
 * @param props.projectId - The idea's project (null for an idea with no project).
 * @param props.active - The chat is open.
 * @param props.onClick - Open or close the chat.
 */
export function AskAiButton({
  projectId,
  active,
  onClick,
}: {
  projectId: string | null;
  active: boolean;
  onClick: () => void;
}): ReactNode {
  const status = useIdeaAiStatus(projectId).data;
  if (!status || status.state === 'off') return null;
  return (
    <button
      type="button"
      className="is-btn"
      aria-pressed={active}
      title="Ask AI about this idea (Ctrl+J)"
      onClick={onClick}
      data-testid="ask-ai-button"
    >
      <span aria-hidden="true">
        <LineIcon name="chat" size={13} />
      </span>{' '}
      Ask AI
    </button>
  );
}

/**
 * Ctrl+J on the idea page opens and closes the Ask AI chat, as it does on a ticket. Inside an editor the key belongs
 * to that editor's /ai menu, so it is left alone there.
 * @param props.projectId - The idea's project (null for an idea with no project).
 * @param props.onToggle - Open or close the chat.
 */
export function AskAiShortcut({ projectId, onToggle }: { projectId: string | null; onToggle: () => void }): ReactNode {
  const on = (useIdeaAiStatus(projectId).data?.state ?? 'off') !== 'off';
  const toggle = useRef(onToggle);
  toggle.current = onToggle;
  useEffect(() => {
    if (!on) return undefined;
    // capture phase: this runs before the board-wide Ctrl+J
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'j') return;
      if ((e.target as Element | null)?.closest?.('[data-ai-editor]')) return;
      e.preventDefault();
      e.stopPropagation();
      toggle.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [on]);
  return null;
}

/**
 * "Ask AI" on the idea page (design/screens/ai-where-you-work.md, B, for ideas): the shared chat panel docked on the
 * right, scoped to the idea. It shows what it reads (the page, assumptions, evidence, comments, research log), keeps
 * the conversation private to the asker and picks it up again when the idea is reopened. It answers or drafts new
 * assumptions and a paragraph for the page; it never moves, merges, archives or promotes an idea.
 * @param props.idea - The idea the chat is about.
 * @param props.onClose - Close the dock.
 */
export function IdeaChat({ idea, onClose }: { idea: Idea; onClose: () => void }) {
  const { openAiPage, openAiTab } = useAiBoardState();
  const scope = useMemo(() => ({ kind: 'idea' as const, id: idea.id }), [idea.id]);
  return (
    <div className="is-chat-dock" data-testid="idea-chat">
      <ScopedChat
        scope={scope}
        title="Ask AI about this idea"
        onClose={onClose}
        onOpenAiMembers={() => openAiPage?.()}
        onOpenUsage={() => openAiTab?.('usage')}
      />
    </div>
  );
}
