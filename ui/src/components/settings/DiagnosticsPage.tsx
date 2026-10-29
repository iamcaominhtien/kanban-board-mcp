import { useState } from 'react';
import { resolveOrigin } from '../../api/resolveOrigin';
import styles from './SettingsPage.module.css';

/** Format a Date as the local `YYYY-MM-DDTHH:mm` value a datetime-local input expects. */
function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Diagnostics: export the application log for a time range and level. */
export function DiagnosticsPage() {
  const [logSince, setLogSince] = useState('');
  const [logUntil, setLogUntil] = useState('');
  const [logLevel, setLogLevel] = useState('INFO');
  const [logStatus, setLogStatus] = useState<string | null>(null);

  /** Fill the log range with the last `hours` hours (null clears it = whole log). */
  function setLogPreset(hours: number | null) {
    setLogSince(hours === null ? '' : toLocalInputValue(new Date(Date.now() - hours * 3600_000)));
    setLogUntil('');
  }

  async function handleLogExport() {
    setLogStatus(null);
    const since = logSince ? new Date(logSince) : null;
    const until = logUntil ? new Date(logUntil) : null;
    if (since && until && since > until) {
      setLogStatus('Error: "From" must be before "To".');
      return;
    }
    try {
      const origin = await resolveOrigin();
      const params = new URLSearchParams({ level: logLevel });
      if (since) params.set('since', since.toISOString());
      if (until) params.set('until', until.toISOString());
      const res = await fetch(`${origin}/logs/export?${params}`);
      if (!res.ok) {
        setLogStatus(`Export error: ${await res.text()}`);
        return;
      }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `kanban-log-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}.log`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setLogStatus('✓ Log exported.');
    } catch (e: any) {
      setLogStatus(`Export failed: ${e?.message ?? 'Unknown error'}`);
    }
  }

  return (
    <div className={styles.section} data-setting="logs">
      <span className={styles.sectionTitle}>Application logs</span>
      <div className={styles.hint}>
        Export the app log (server activity, UI errors, MCP errors and warnings) to share when something goes wrong.
        Leave the range empty to export everything that is kept (up to ~30 MB).
      </div>
      <div className={styles.inputRow}>
        <label className={styles.hint} style={{ flex: 1 }}>
          From
          <input
            type="datetime-local"
            className={styles.input}
            value={logSince}
            onChange={(e) => setLogSince(e.target.value)}
          />
        </label>
        <label className={styles.hint} style={{ flex: 1 }}>
          To
          <input
            type="datetime-local"
            className={styles.input}
            value={logUntil}
            onChange={(e) => setLogUntil(e.target.value)}
          />
        </label>
      </div>
      <div className={styles.inputRow} style={{ flexWrap: 'wrap' }}>
        {(
          [
            ['Last hour', 1],
            ['Last 24h', 24],
            ['Last 7 days', 24 * 7],
            ['All', null],
          ] as const
        ).map(([label, hours]) => (
          <button key={label} type="button" className={styles.btn} onClick={() => setLogPreset(hours)}>
            {label}
          </button>
        ))}
      </div>
      <div className={styles.inputRow}>
        <select
          className={styles.input}
          style={{ width: 'auto' }}
          value={logLevel}
          onChange={(e) => setLogLevel(e.target.value)}
          aria-label="Minimum log level"
        >
          <option value="INFO">Info and above</option>
          <option value="WARNING">Warnings and errors</option>
          <option value="ERROR">Errors only</option>
          <option value="DEBUG">Everything</option>
        </select>
        <button type="button" className={styles.btn} onClick={handleLogExport}>
          ⬇ Export logs
        </button>
      </div>
      {logStatus && <span className={logStatus.startsWith('✓') ? styles.statusOk : styles.statusErr}>{logStatus}</span>}
    </div>
  );
}
