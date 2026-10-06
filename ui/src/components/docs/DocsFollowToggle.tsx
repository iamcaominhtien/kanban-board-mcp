import './docs.css';
import { Icon } from './Icon';
import { useDocsFollow } from './useDocsNotifications';

/** Bell button for the tree header (Follow space). Persists per project in localStorage (`docsFollow:<projectId>`). */
export function DocsFollowToggle({ projectId }: { projectId: string }) {
  const [on, setOn] = useDocsFollow(projectId);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={on ? 'Following this space' : 'Follow this space'}
      onClick={() => setOn(!on)}
      title={on ? 'Following: you get a notification when someone publishes a page' : 'Follow space: get a notification when someone publishes a page'}
      className="dk-icobtn"
      style={on ? { background: '#DCEEE1', color: '#1F5A31' } : undefined}
    >
      <Icon name="i44" size={15} strokeWidth={on ? 2.1 : 1.9} />
    </button>
  );
}
