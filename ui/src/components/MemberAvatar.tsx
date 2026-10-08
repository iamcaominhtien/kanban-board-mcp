import type { Member } from '../types/ticket';

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0] ?? '')
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

/** Return background and text colors for a member color. */
export function getAvatarColors(color: string): { bg: string; color: string } {
  const normalized = color.toUpperCase();
  const pairs: Record<string, { bg: string; color: string }> = {
    '#2E6F40': { bg: '#DCEEE1', color: '#2E6F40' },
    '#2F6FB0': { bg: '#E1EEFB', color: '#2F6FB0' },
    '#6D5DD3': { bg: '#E6E9F5', color: '#5B5FA8' },
    '#B4791E': { bg: '#F3E7DC', color: '#B4791E' },
    '#B0446E': { bg: '#FBE4E9', color: '#B0446E' },
    '#C4432A': { bg: '#FBE7E4', color: '#C4432A' },
    '#5B6B60': { bg: '#EEF1EE', color: '#5B6B60' },
  };
  if (pairs[normalized]) return pairs[normalized];
  if (color.startsWith('#') && color.length === 7) {
    return { bg: `${color}22`, color: color };
  }
  return { bg: '#EEF1EE', color: '#5B6B60' };
}

interface MemberAvatarProps {
  member: Member;
  size?: number;
  title?: string;
}

/** Round avatar with the member's initials. */
export function MemberAvatar({ member, size = 20, title }: MemberAvatarProps) {
  const { bg, color } = getAvatarColors(member.color);
  return (
    <span
      title={title ?? member.name}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        borderRadius: '50%',
        background: bg,
        color: color,
        fontSize: Math.max(9, Math.round(size * 0.48)),
        fontWeight: 700,
        fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
        flexShrink: 0,
        userSelect: 'none',
      }}
    >
      {initials(member.name)}
    </span>
  );
}
