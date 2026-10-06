/** Small helpers shared by the Docs page, tree and chips. */

const PASTELS: [string, string][] = [
  ['#E6E9F5', '#5B5FA8'],
  ['#DCEEE1', '#2E6F40'],
  ['#F3E7DC', '#B4791E'],
  ['#E1EEFB', '#2F6FB0'],
  ['#F5E3EA', '#A8456B'],
  ['#E4F1EE', '#2A7A6B'],
];

/** Per-user pastel avatar colours (stable for a name). */
export function avatarColors(name: string): { background: string; color: string } {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const [background, color] = PASTELS[h % PASTELS.length];
  return { background, color };
}

export const TICKET_STATUS: Record<string, { label: string; color: string }> = {
  backlog: { label: 'Backlog', color: '#9AA8A0' },
  todo: { label: 'To Do', color: '#9AA8A0' },
  'in-progress': { label: 'In Progress', color: '#2F6FB0' },
  in_progress: { label: 'In Progress', color: '#2F6FB0' },
  review: { label: 'Review', color: '#6D5DD3' },
  testing: { label: 'Testing', color: '#B4571F' },
  done: { label: 'Done', color: '#2E6F40' },
  wont_do: { label: "Won't Do", color: '#C4432A' },
  blocked: { label: 'Blocked', color: '#C4432A' },
};

export function ticketStatus(status?: string | null) {
  return TICKET_STATUS[status ?? ''] ?? { label: status ?? 'Backlog', color: '#9AA8A0' };
}

export function pageFullTime(iso: string, author: string, version: number): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${date} at ${time} · ${author}${version > 0 ? ` · v${version}` : ''}`;
}
