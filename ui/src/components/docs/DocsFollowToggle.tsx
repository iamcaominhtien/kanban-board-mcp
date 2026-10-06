import './docs.css';
import { Icon } from './Icon';
import { useDocsFollow } from './useDocsNotifications';

/** Small "Follow space" chip for the tree header. Persists per project in localStorage (`docsFollow:<projectId>`). */
export function DocsFollowToggle({ projectId }: { projectId: string }) {
  const [on, setOn] = useDocsFollow(projectId);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => setOn(!on)}
      title={on ? 'You get a notification when someone publishes a page' : 'Get a notification when someone publishes a page'}
      className="mc-chip"
      style={{
        height: 24,
        border: `1px solid ${on ? '#B7D9C0' : '#E3E8E5'}`,
        background: on ? '#DCEEE1' : '#FFFFFF',
        color: on ? '#1F5A31' : '#5B6B60',
        cursor: 'pointer',
        fontFamily: 'inherit',
        gap: 5,
      }}
    >
      <Icon name="i44" size={12} strokeWidth={2} />
      {on ? 'Following' : 'Follow space'}
    </button>
  );
}
