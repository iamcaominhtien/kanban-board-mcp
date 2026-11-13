import { reloadAfterSwitch, useBoardSwitchedElsewhere } from '../api/workspaces';
import styles from './WorkspaceSwitchedNotice.module.css';

/**
 * Shown when another board was opened since this window loaded (another window, the desktop menu, `kanban-db`). This
 * window still shows the board it loaded and the server refuses its changes, so the person is asked to reload.
 */
export function WorkspaceSwitchedNotice() {
  const { switched, openNow } = useBoardSwitchedElsewhere();
  if (!switched) return null;
  const name = openNow ?? 'another board';
  return (
    <div className={styles.notice} role="alert" data-testid="workspace-switched-notice">
      <span>
        <b>{name}</b> is now the board in use (it was opened elsewhere). This window still shows the board it loaded,
        and changes made here are not saved.
      </span>
      <button type="button" className={styles.reload} onClick={reloadAfterSwitch}>
        {openNow ? `Show ${openNow}` : 'Reload'}
      </button>
    </div>
  );
}
