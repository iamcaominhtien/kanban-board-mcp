import { useCallback, useMemo } from 'react';
import { useMembers } from '../../api/members';
import { toStored } from '../../utils/mentionText';
import type { SuggestMember } from '../docs/RefSuggester';
import { getAvatarColors } from '../MemberAvatar';

/**
 * What the `@` picker of a Canvas comment offers: the people of the canvas's project (not AI teams: a team cannot
 * answer a Canvas comment yet), and the way to save the text with each picked name linked to its member.
 * @param projectId - The canvas's project; nothing is offered without one.
 * @param me - Who is writing, marked "You" in the list.
 * @returns `suggest` for the picker, and `store` to run the text through before it is sent.
 */
export function useCanvasMentions(projectId: string | null | undefined, me: string) {
  const members = useMembers(projectId ?? '');
  const people = useMemo(
    () => (members.data ?? []).filter((m) => m.kind !== 'ai' && m.kind !== 'ai_removed'),
    [members.data],
  );
  const suggest = useMemo<SuggestMember[]>(
    () =>
      people.map((m) => ({
        id: m.id,
        name: m.name,
        group: 'People',
        note: m.name.toLowerCase() === me.toLowerCase() ? 'You' : '',
        ...getAvatarColors(m.color),
      })),
    [people, me],
  );
  const store = useCallback(
    (text: string) =>
      toStored(
        text,
        people.map((m) => ({ id: m.id, name: m.name })),
      ),
    [people],
  );
  return { suggest, store };
}
