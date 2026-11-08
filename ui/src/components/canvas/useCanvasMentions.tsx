import { useCallback, useMemo } from 'react';
import { useCanvasMembers } from '../../api/canvases';
import type { AiProvider } from '../../types/ai';
import { toStored } from '../../utils/mentionText';
import { AiAvatar } from '../ai/aiUi';
import type { SuggestMember } from '../docs/RefSuggester';
import { getAvatarColors } from '../MemberAvatar';

const STATUS = {
  ready: { label: 'Ready', tone: 'ok' as const },
  paused: { label: 'Paused', tone: 'warn' as const },
  unavailable: { label: 'Unavailable', tone: 'off' as const },
};

/**
 * What the `@` picker of a Canvas comment offers: the people of the canvas's project, then its AI teams in an "AI"
 * group (greyed and not pickable when the team cannot be asked on this canvas now: paused, not on the ticket), and the
 * way to save the text with each picked name linked to its member.
 * @param canvasId - The canvas; the server says who can be asked on it.
 * @param me - Who is writing, marked "You" in the list.
 * @returns `suggest` for the picker, and `store` to run the text through before it is sent.
 */
export function useCanvasMentions(canvasId: string | null | undefined, me: string) {
  const members = useCanvasMembers(canvasId);
  const list = useMemo(() => (Array.isArray(members.data) ? members.data : []), [members.data]);
  const suggest = useMemo<SuggestMember[]>(
    () =>
      list.map<SuggestMember>((m) => {
        if (m.kind !== 'ai' || !m.ai) {
          return {
            id: m.id,
            name: m.name,
            group: 'People',
            note: m.name.toLowerCase() === me.toLowerCase() ? 'You' : '',
            ...getAvatarColors(m.color),
          };
        }
        const st = STATUS[m.ai.status] ?? STATUS.unavailable;
        return {
          id: m.id,
          name: m.name,
          group: 'AI',
          ai: {
            avatar: <AiAvatar provider={m.ai.provider as AiProvider} color={m.color} size={22} />,
            status: st.label,
            note: m.ai.note,
            tone: st.tone,
            usable: m.ai.usable,
          },
        };
      }),
    [list, me],
  );
  // people first, then the AI teams (usable ones first): the picker draws a header at every change of group
  const ordered = useMemo(
    () =>
      [...suggest].sort(
        (a, b) => Number(!!a.ai) - Number(!!b.ai) || Number(b.ai?.usable ?? true) - Number(a.ai?.usable ?? true),
      ),
    [suggest],
  );
  const store = useCallback(
    (text: string) =>
      toStored(
        text,
        list.map((m) => ({ id: m.id, name: m.name })),
      ),
    [list],
  );
  return { suggest: ordered, store };
}
