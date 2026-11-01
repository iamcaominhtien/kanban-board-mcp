import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useFollow, useSetFollow, type FollowLevel, type FollowScope } from '../../api/notificationSettings';
import styles from './FollowBell.module.css';

/** The bell on a ticket or a Docs page (design/screens/notifications.md, K): follow, mute, or forget. */

const BELL = 'M6 17V11a6 6 0 0 1 12 0v6l1.5 2h-15L6 17zM10 21h4';

function Svg({
  size,
  color,
  children,
  fill,
}: Readonly<{ size: number; color?: string; children: ReactNode; fill?: string }>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill ?? 'none'}
      stroke={color ?? 'currentColor'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      {children}
    </svg>
  );
}

const REASON: Record<string, string> = {
  ticket: 'Because you started a run on it, commented on it or it is assigned to you',
  page: 'Because you wrote it or commented on it',
};

interface Props {
  scope: Extract<FollowScope, 'ticket' | 'page'>;
  /** Ticket key (KAN-215) or Docs page id. */
  scopeId: string;
  /** Project of the thing, for the server's labels. */
  projectId?: string;
  className?: string;
}

/** Bell button with the follow menu; filled when following, struck through when muted. */
export function FollowBell({ scope, scopeId, projectId, className }: Readonly<Props>) {
  const q = useFollow(scope, scopeId);
  const set = useSetFollow(scope, scopeId);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const level = q.data?.level ?? null;
  const timed = level === 'mute' && !!q.data?.until;
  const muted = level === 'mute';
  const following = level !== null && !muted;
  const noun = scope === 'ticket' ? 'ticket' : 'page';
  let bellLabel = `Follow this ${noun}`;
  let bellTitle = bellLabel;
  if (muted) {
    bellLabel = `Muted: notifications of this ${noun}`;
    bellTitle = 'Muted';
  } else if (following) {
    bellLabel = `Following this ${noun}`;
    bellTitle = 'Following';
  }

  function choose(next: FollowLevel | null, minutes?: number) {
    setError(null);
    set.mutate(
      { level: next, minutes, projectId },
      {
        onSuccess: () => setOpen(false),
        onError: () => setError('Could not change this. Try again.'),
      },
    );
  }

  const isOn = (l: FollowLevel) => level === l && !(l === 'mute' && timed);
  const items: {
    key: string;
    level: FollowLevel;
    minutes?: number;
    name: string;
    hint?: string;
    on: boolean;
    icon: ReactNode;
  }[] = [
    {
      key: 'follow',
      level: 'follow',
      name: level === 'follow' ? 'Following' : 'Follow',
      hint: level === 'follow' ? REASON[scope] : undefined,
      on: isOn('follow'),
      icon: (
        <Svg size={15} color={isOn('follow') ? '#2E6F40' : '#3A4A3E'}>
          <path d={BELL} />
        </Svg>
      ),
    },
    {
      key: 'everything',
      level: 'everything',
      name: 'Everything',
      hint: `Every comment and run on this ${noun}`,
      on: isOn('everything'),
      icon: (
        <Svg size={15} color="#3A4A3E">
          <path d={BELL} />
        </Svg>
      ),
    },
    {
      key: 'mentions',
      level: 'mentions',
      name: 'Only mentions and questions',
      on: isOn('mentions'),
      icon: (
        <Svg size={15} color="#3A4A3E">
          <circle cx="12" cy="12" r="3.5" />
          <path d="M15.5 12v1.2a2.3 2.3 0 0 0 4.5 0V12a8 8 0 1 0-3.2 6.4" />
        </Svg>
      ),
    },
    {
      key: 'mute',
      level: 'mute',
      name: 'Muted',
      hint: 'Nothing, not even mentions',
      on: isOn('mute'),
      icon: (
        <Svg size={15} color="#3A4A3E">
          <path d="M3 3l18 18M10.6 6.2A9 9 0 0 1 12 6c5 0 8.5 4 9.5 6a13 13 0 0 1-2.6 3.4M6.2 7.6A13 13 0 0 0 2.5 12c1 2 4.5 6 9.5 6a9 9 0 0 0 3.2-.6" />
        </Svg>
      ),
    },
  ];

  return (
    <div className={styles.wrap} ref={ref}>
      <button
        type="button"
        className={`${styles.bell} ${following ? styles.bellOn : ''} ${className ?? ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={bellLabel}
        title={bellTitle}
        data-testid="follow-bell"
        onClick={() => setOpen((v) => !v)}
      >
        <Svg size={15} fill={following ? 'currentColor' : 'none'}>
          <path d={BELL} />
          {muted && <path d="M3 3l18 18" />}
        </Svg>
      </button>
      {open && (
        <div className={styles.menu} role="menu">
          <div className={styles.heading}>This {noun}</div>
          {items.map((it) => (
            <button
              key={it.key}
              type="button"
              role="menuitem"
              className={`${styles.item} ${it.on ? styles.itemOn : ''}`}
              disabled={set.isPending}
              onClick={() => choose(it.on ? null : it.level)}
            >
              {it.icon}
              <span className={styles.itemText}>
                <div className={styles.itemName}>{it.name}</div>
                {it.hint && <div className={styles.itemHint}>{it.hint}</div>}
              </span>
            </button>
          ))}
          <div className={styles.sep} />
          <button
            type="button"
            role="menuitem"
            className={`${styles.item} ${timed ? styles.itemOn : ''}`}
            disabled={set.isPending}
            onClick={() => choose(timed ? null : 'mute', timed ? undefined : 60)}
          >
            <Svg size={15} color="#3A4A3E">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3.5 2" />
            </Svg>
            <span className={styles.itemText}>
              <div className={styles.itemName}>Mute for 1 hour</div>
              {timed && q.data?.until && (
                <div className={styles.itemHint}>
                  Until {new Date(q.data.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </div>
              )}
            </span>
          </button>
          {error && <div className={styles.error}>{error}</div>}
        </div>
      )}
    </div>
  );
}
