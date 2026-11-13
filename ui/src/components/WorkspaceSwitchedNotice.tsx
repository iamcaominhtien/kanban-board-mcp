import { reloadAfterSwitch, useWorkspaceSwitchedElsewhere } from '../api/workspaces';
import styles from './WorkspaceSwitchedNotice.module.css';

/**
 * Shown when the board was switched to another workspace from somewhere else (another window, the desktop menu, an
 * editor's MCP). This window would otherwise go on showing, and changing, the other board without the person noticing.
 */
export function WorkspaceSwitchedNotice() {
  const { switchedTo } = useWorkspaceSwitchedElsewhere();
  if (!switchedTo) return null;
  return (
    <div className={styles.notice} role="alert" data-testid="workspace-switched-notice">
      <span>
        The board was switched to <b>{switchedTo}</b> somewhere else. What this window shows may be the other board.
      </span>
      <button type="button" className={styles.reload} onClick={reloadAfterSwitch}>
        Show {switchedTo}
      </button>
    </div>
  );
}
