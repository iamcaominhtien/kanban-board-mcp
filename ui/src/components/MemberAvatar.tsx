import type { Member } from '../types/ticket';

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0] ?? '')
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

interface MemberAvatarProps {
  member: Member;
  size?: number;
  title?: string;
}

export function MemberAvatar({ member, size = 24, title }: MemberAvatarProps) {
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
        background: member.color,
        color: '#fff',
        fontSize: size * 0.38,
        fontWeight: 700,
        fontFamily: "'DM Sans', sans-serif",
        letterSpacing: '0.02em',
        flexShrink: 0,
        userSelect: 'none',
      }}
    >
      {initials(member.name)}
    </span>
  );
}
