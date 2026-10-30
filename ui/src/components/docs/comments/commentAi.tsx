import { useMemo } from 'react';
import type { AiProvider } from '../../../types/ai';
import type { DocsCommentsResult } from '../../../types/docs';
import { mentionRows } from '../../../utils/docsThreadAiRules';
import { AiAvatar, useAiBoardState } from '../../ai/aiUi';
import { getAvatarColors } from '../../MemberAvatar';
import type { SuggestMember } from '../RefSuggester';

/**
 * Rows of the @ list in a Docs comment box: the project's people, then, while Docs AI is on, its AI members in an
 * "AI" group with their status (ones that cannot answer now are greyed and cannot be picked).
 * @param data - The page's comments result.
 */
export function useCommentSuggest(data: DocsCommentsResult | undefined): SuggestMember[] {
  const { members: board } = useAiBoardState();
  return useMemo(
    () =>
      mentionRows(data?.members ?? [], !!data?.docsAi).map<SuggestMember>((r) => {
        if (r.kind === 'human') return { id: r.id, name: r.name, group: r.group, ...getAvatarColors(r.color) };
        const m = board.get(r.id);
        const provider = (m?.provider ??
          data?.members.find((x) => x.id === r.id)?.ai?.provider ??
          'custom') as AiProvider;
        return {
          id: r.id,
          name: r.name,
          group: 'AI',
          ai: {
            avatar: <AiAvatar provider={provider} color={m?.color ?? r.color} glyph={m?.glyph} size={22} />,
            status: r.status ?? '',
            note: r.note ?? '',
            tone: r.tone ?? 'off',
            usable: r.usable,
          },
        };
      }),
    [data, board],
  );
}
