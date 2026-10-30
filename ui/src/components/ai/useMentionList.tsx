import { useMemo } from 'react';
import type { Member } from '../../types/ticket';
import type { SuggestMember } from '../docs/RefSuggester';
import { getAvatarColors } from '../MemberAvatar';
import { aiAvailability, aiPickerLine } from './aiAvailability';
import { AiAvatar, useAiBoardState } from './aiUi';

/** The project's AI members as rows of the @ list: avatar, status in words, greyed when they cannot be used now. */
export function useAiSuggest(): SuggestMember[] {
  const { members, settings } = useAiBoardState();
  const on = settings?.aiEnabled !== false; // AI turned off for the project: no AI in the @ list
  return useMemo(
    () =>
      on
        ? [...members.values()]
            .filter((m) => m.kind === 'ai')
            .map((m) => {
              const av = aiAvailability(m);
              const pick = aiPickerLine(m);
              return {
                id: m.id,
                name: m.name,
                group: 'AI members',
                ai: {
                  avatar: <AiAvatar provider={m.provider} color={m.color} glyph={m.glyph} size={22} />,
                  status: av.label,
                  note: av.note,
                  tone: av.tone,
                  usable: av.usable,
                  sub: pick.line,
                  chip: pick.chip,
                },
              };
            })
            // usable first, then the ones that cannot be mentioned now
            .sort((a, b) => Number(b.ai.usable) - Number(a.ai.usable))
        : [],
    [members, on],
  );
}

/**
 * People and AI members for the @ list of a field without ticket context (a description, a test case note): the
 * project's people first under People, then the AI members under AI.
 */
export function usePeopleAndAiSuggest(people: Member[]): SuggestMember[] {
  const ai = useAiSuggest();
  return useMemo(() => {
    const humans = people
      .filter((m) => (m.kind ?? 'human') === 'human')
      .map<SuggestMember>((m) => ({ id: m.id, name: m.name, group: 'People', ...getAvatarColors(m.color) }));
    return [...humans, ...ai];
  }, [people, ai]);
}
