import type { DocsCommentsResult } from '../../../types/docs';
import { getAvatarColors } from '../../MemberAvatar';

export interface CommentPerson {
  name: string;
  initials: string;
  bg: string;
  color: string;
}

/**
 * Display info for a comment author: the board user is "You", members get their own colour.
 * @param author - Actor name (`user`, `agent` or a member name).
 * @param members - Members of the page's project.
 * @param me - The caller's actor name.
 */
export function personOf(author: string, members: DocsCommentsResult['members'], me: string): CommentPerson {
  if (author === 'user')
    return { name: author === me ? 'You' : 'Board owner', initials: 'ME', bg: '#1E2A22', color: '#FFFFFF' };
  if (author === 'agent') return { name: 'AI agent', initials: 'AI', bg: '#E6E9F5', color: '#5B5FA8' };
  const m = members.find((x) => x.name.toLowerCase() === author.toLowerCase());
  const parts = author.trim().split(/\s+/);
  const initials = (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : author.slice(0, 2)).toUpperCase();
  const c = getAvatarColors(m?.color ?? '#5B6B60');
  return { name: author === me ? 'You' : author, initials, ...c };
}

/** Link that opens a thread when pasted: the page URL with `#comment-<id>`. */
export function threadLink(threadId: string): string {
  const { origin, pathname, search } = window.location;
  return `${origin}${pathname}${search}#comment-${threadId}`;
}
