import { useState } from 'react';
import { resolveOrigin } from '../../api/resolveOrigin';
import { Field, ICONS, Pills, SIcon, SettingsCard } from './settingsUi';
import styles from './SettingsPage.module.css';

const PRESETS = [
  ['1', 'Last hour'],
  ['24', 'Last 24h'],
  ['168', 'Last 7 days'],
  ['all', 'All'],
] as const;
type Preset = (typeof PRESETS)[number][0];

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
  const [logStatus, setLogStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [preset, setPreset] = useState<Preset | null>(null);

  /** Fill the log range with the last `hours` hours (null clears it = whole log). */
  function setLogPreset(p: Preset) {
    setPreset(p);
    setLogSince(p === 'all' ? '' : toLocalInputValue(new Date(Date.now() - Number(p) * 3600_000)));
    setLogUntil('');
  }

  async function handleLogExport() {
    setLogStatus(null);
    const since = logSince ? new Date(logSince) : null;
    const until = logUntil ? new Date(logUntil) : null;
    if (since && until && since > until) {
      setLogStatus({ ok: false, text: '"From" must be before "To".' });
      return;
    }
    try {
      const origin = await resolveOrigin();
      const params = new URLSearchParams({ level: logLevel });
      if (since) params.set('since', since.toISOString());
      if (until) params.set('until', until.toISOString());
      const res = await fetch(`${origin}/logs/export?${params}`);
      if (!res.ok) {
        setLogStatus({ ok: false, text: `Export error: ${await res.text()}` });
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
      setLogStatus({ ok: true, text: 'Log exported' });
    } catch (e: any) {
      setLogStatus({ ok: false, text: `Export failed: ${e?.message ?? 'Unknown error'}` });
    }
  }

  return (
    <SettingsCard
      title="Application logs"
      hint="Export the app log (server activity, UI errors, MCP errors and warnings) to share when something goes wrong. Leave the range empty to export everything kept (up to about 30 MB)."
      setting="logs"
      status={logStatus}
    >
      <div className={styles.grid2}>
        <Field label="From" htmlFor="log-from">
          <input
            id="log-from"
            type="datetime-local"
            className={styles.input}
            value={logSince}
            onChange={(e) => {
              setLogSince(e.target.value);
              setPreset(null);
            }}
          />
        </Field>
        <Field label="To" htmlFor="log-to">
          <input
            id="log-to"
            type="datetime-local"
            className={styles.input}
            value={logUntil}
            onChange={(e) => {
              setLogUntil(e.target.value);
              setPreset(null);
            }}
          />
        </Field>
      </div>
      <Pills options={PRESETS} value={preset} label="Log range" onChange={(v) => setLogPreset(v)} />
      <div className={styles.row}>
        <select
          className={`${styles.input} ${styles.select}`}
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
          <SIcon d={ICONS.download} size={14} />
          Export logs
        </button>
      </div>
    </SettingsCard>
  );
}
