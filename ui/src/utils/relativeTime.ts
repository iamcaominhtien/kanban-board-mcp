/** Format a past time as "5m ago" or a short date. */
export function relativeTime(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Format as "Oct 8, 2026, 3:04 PM". */
export function absoluteTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** "user" and "agent" are the two actors the server knows about. */
export function actorName(actor: string): string {
  return actor === 'agent' ? 'AI agent' : actor === 'user' ? 'You' : actor;
}

/** Return avatar initials for an actor. */
export function actorInitials(actor: string): string {
  return actor === 'agent' ? 'AI' : actor === 'user' ? 'ME' : actor.slice(0, 2).toUpperCase();
}
