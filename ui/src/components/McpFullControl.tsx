import { useState } from 'react';
import { extractError } from '../api/extractError';
import { useMcpControl, useSetMcpControl } from '../api/settings';
import styles from './McpIntegrations.module.css';

/**
 * "Full control over MCP": lets an MCP client act on the AI team as the person does. Turning it on asks again and
 * needs the risks accepted; turning it off is immediate.
 */
export function McpFullControl() {
  const control = useMcpControl();
  const set = useSetMcpControl();
  const [asking, setAsking] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const on = control.data?.enabled === true;

  const change = async (enabled: boolean) => {
    setError(null);
    try {
      await set.mutateAsync({ enabled, acceptRisks: enabled && accepted });
      setAsking(false);
      setAccepted(false);
    } catch (err) {
      setError(extractError(err));
    }
  };

  return (
    <div className={styles.section} data-testid="mcp-full-control">
      <div className={styles.headRow}>
        <h3 className={styles.title}>Full control over MCP</h3>
        {on && (
          <span className={styles.toolsChip} data-testid="mcp-full-control-on">
            On
          </span>
        )}
      </div>
      <p className={styles.hint}>
        Lets a connected AI tool do everything you can do with the AI team: add, change and remove AI members, assign
        and cancel work, decide approvals, pause or resume AI for a project, change safety settings and read the audit
        log. Off by default.
      </p>

      {asking ? (
        <div className={styles.confirm} role="alertdialog" aria-label="Turn on full control over MCP">
          <p className={styles.text}>
            <strong>Turn on full control over MCP?</strong>
          </p>
          <p className={styles.hint}>
            Any tool connected to this board over MCP can then act as you, with your rights, and the board will not ask
            you first. That includes approving what an AI asked permission for, raising what an AI may do and spending
            on your plan or API keys. A mistake or a prompt injection in that tool can do real damage. AI members
            running on the board never get this; it is only for the tools you connected yourself.
          </p>
          <label className={styles.hint} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <input
              type="checkbox"
              checked={accepted}
              onChange={(e) => setAccepted(e.target.checked)}
              data-testid="mcp-full-control-accept"
            />
            <span>I understand and accept all the risks.</span>
          </label>
          {error && (
            <p className={styles.hint} role="alert" style={{ color: '#c4432a' }}>
              {error}
            </p>
          )}
          <div className={styles.actions}>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnSm}`}
              onClick={() => {
                setAsking(false);
                setAccepted(false);
                setError(null);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnSm} ${styles.btnDanger}`}
              disabled={!accepted || set.isPending}
              onClick={() => void change(true)}
              data-testid="mcp-full-control-confirm"
            >
              Turn on
            </button>
          </div>
        </div>
      ) : (
        <div className={styles.actions}>
          {on ? (
            <button
              type="button"
              className={`${styles.btn} ${styles.btnSm}`}
              disabled={set.isPending}
              onClick={() => void change(false)}
              data-testid="mcp-full-control-off"
            >
              Turn off
            </button>
          ) : (
            <button
              type="button"
              className={`${styles.btn} ${styles.btnSm} ${styles.btnDangerOutline}`}
              disabled={control.isLoading}
              onClick={() => setAsking(true)}
              data-testid="mcp-full-control-start"
            >
              Turn on…
            </button>
          )}
          {error && (
            <span className={styles.hint} role="alert" style={{ color: '#c4432a' }}>
              {error}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
