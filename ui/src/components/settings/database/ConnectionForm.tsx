import { useId, useState } from 'react';
import type { ConnectionBody, DatabaseSettings, Engine, SslMode } from '../../../api/database';
import { SIcon } from '../settingsUi';
import settings from '../SettingsPage.module.css';
import { DB_ICONS } from './dbUi';
import { DEFAULT_PORT, targetUrl } from './dbFormat';
import styles from './Database.module.css';

/** The connection form of step 1 and of Edit connection (design/screens/ai-databases.md C2, C3). */

/** What the person typed. */
export interface ConnectionDraft {
  engine: Engine;
  host: string;
  port: string;
  name: string;
  user: string;
  password: string;
  ssl: SslMode;
  /** "Or paste a connection string" is open: `url` replaces the fields. */
  useUrl: boolean;
  url: string;
}

/** An empty form for an engine (the port defaults to the engine's). */
export function emptyDraft(engine: Engine): ConnectionDraft {
  return {
    engine,
    host: engine === 'sqlite' ? '' : '127.0.0.1',
    port: engine === 'sqlite' ? '' : String(DEFAULT_PORT[engine]),
    name: engine === 'sqlite' ? '' : 'kanban',
    user: '',
    password: '',
    ssl: 'prefer',
    useUrl: false,
    url: '',
  };
}

/** The form filled from saved settings (Edit connection). */
export function draftFromSettings(s: DatabaseSettings): ConnectionDraft {
  const base = emptyDraft(s.engine);
  return {
    ...base,
    host: s.host ?? base.host,
    port: s.port != null ? String(s.port) : base.port,
    name: s.name ?? base.name,
    user: s.user ?? '',
    ssl: s.ssl ?? base.ssl,
  };
}

/** True when the form has what a test needs. */
export function draftReady(d: ConnectionDraft): boolean {
  if (d.engine === 'sqlite') return true;
  if (d.useUrl) return d.url.trim() !== '';
  return d.host.trim() !== '' && d.name.trim() !== '' && /^\d*$/.test(d.port.trim());
}

/** The request body for a draft; `keepPassword` uses the saved password when the field is left empty. */
export function draftToBody(d: ConnectionDraft, opts: { keepPassword?: boolean } = {}): ConnectionBody {
  if (d.engine === 'sqlite') return { engine: 'sqlite' };
  if (d.useUrl) {
    return { url: d.url.trim(), ...(d.password ? { password: d.password } : {}), ssl: d.ssl };
  }
  const body: ConnectionBody = {
    engine: d.engine,
    host: d.host.trim(),
    port: d.port.trim() ? Number(d.port.trim()) : DEFAULT_PORT[d.engine],
    name: d.name.trim(),
    user: d.user.trim() || undefined,
    ssl: d.ssl,
  };
  if (d.password) body.password = d.password;
  else if (opts.keepPassword) body.keepPassword = true;
  return body;
}

const SSL_OPTIONS: [SslMode, string][] = [
  ['off', 'Off'],
  ['prefer', 'Prefer'],
  ['require', 'Require'],
  ['verify-full', 'Verify the server (verify-full)'],
];

/** Where the password is kept, as the hint under the field says it. */
export function passwordHint(store: 'keychain' | 'file'): string {
  return store === 'keychain'
    ? "Encrypted with this app's key, which lives in your system keychain."
    : "Encrypted with this app's key file, readable only by you; never stored as text.";
}

/**
 * The fields for a server database (Host, Port, Database, User, Password with Show, Secure connection), or one
 * connection string; for SQLite, the file in the data folder, which needs no fields.
 */
export function ConnectionForm({
  draft,
  onChange,
  passwordStore,
  sqlitePath,
  passwordNote,
  disabled,
}: {
  draft: ConnectionDraft;
  onChange: (d: ConnectionDraft) => void;
  passwordStore: 'keychain' | 'file';
  /** The data folder's kanban.db (the SQLite target). */
  sqlitePath: string;
  /** A different line under the password (Edit connection: leave it empty to keep it). */
  passwordNote?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const [show, setShow] = useState(false);
  const set = (patch: Partial<ConnectionDraft>) => onChange({ ...draft, ...patch });

  if (draft.engine === 'sqlite') {
    return (
      <div className={styles.form} data-testid="connection-form">
        <div className={settings.field}>
          <span className={settings.fieldLab}>The file</span>
          <div className={`${settings.input} ${settings.mono} ${styles.readonly}`} data-testid="sqlite-target-path">
            {sqlitePath}
          </div>
          <span className={settings.hint}>
            SQLite needs no server: the board uses kanban.db in the data folder. Nothing to fill in.
          </span>
        </div>
      </div>
    );
  }

  const preview = targetUrl({
    engine: draft.engine,
    host: draft.host || 'HOST',
    port: Number(draft.port) || undefined,
    name: draft.name || 'DATABASE',
    user: draft.user || undefined,
  });

  return (
    <div className={styles.form} data-testid="connection-form">
      {draft.useUrl ? (
        <div className={settings.field}>
          <label className={settings.fieldLab} htmlFor={`${id}-url`}>
            Connection string
          </label>
          <input
            id={`${id}-url`}
            className={`${settings.input} ${settings.mono}`}
            placeholder={`${draft.engine}://user:password@host:${DEFAULT_PORT[draft.engine]}/kanban`}
            value={draft.url}
            disabled={disabled}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => set({ url: e.target.value })}
          />
          <span className={settings.hint}>
            The password may be in the string or in the field below; it is kept the same way either way.
          </span>
        </div>
      ) : (
        <>
          <div className={styles.formRow}>
            <div className={`${settings.field} ${styles.grow}`}>
              <label className={settings.fieldLab} htmlFor={`${id}-host`}>
                Host
              </label>
              <input
                id={`${id}-host`}
                className={`${settings.input} ${settings.mono}`}
                value={draft.host}
                disabled={disabled}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => set({ host: e.target.value })}
              />
            </div>
            <div className={`${settings.field} ${styles.port}`}>
              <label className={settings.fieldLab} htmlFor={`${id}-port`}>
                Port
              </label>
              <input
                id={`${id}-port`}
                className={`${settings.input} ${settings.mono}`}
                value={draft.port}
                inputMode="numeric"
                disabled={disabled}
                onChange={(e) => set({ port: e.target.value })}
              />
            </div>
          </div>
          <div className={settings.grid2}>
            <div className={settings.field}>
              <label className={settings.fieldLab} htmlFor={`${id}-name`}>
                Database
              </label>
              <input
                id={`${id}-name`}
                className={`${settings.input} ${settings.mono}`}
                value={draft.name}
                disabled={disabled}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => set({ name: e.target.value })}
              />
            </div>
            <div className={settings.field}>
              <label className={settings.fieldLab} htmlFor={`${id}-user`}>
                User
              </label>
              <input
                id={`${id}-user`}
                className={`${settings.input} ${settings.mono}`}
                value={draft.user}
                disabled={disabled}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => set({ user: e.target.value })}
              />
            </div>
          </div>
        </>
      )}
      <div className={settings.field}>
        <label className={settings.fieldLab} htmlFor={`${id}-password`}>
          Password
        </label>
        <div className={styles.formRow}>
          <input
            id={`${id}-password`}
            className={`${settings.input} ${styles.grow}`}
            type={show ? 'text' : 'password'}
            value={draft.password}
            disabled={disabled}
            autoComplete="new-password"
            onChange={(e) => set({ password: e.target.value })}
          />
          <button
            type="button"
            className={`${settings.btn} ${styles.showBtn}`}
            aria-pressed={show}
            onClick={() => setShow((v) => !v)}
          >
            <SIcon d={show ? DB_ICONS.eyeOff : DB_ICONS.eye} size={14} />
            {show ? 'Hide' : 'Show'}
          </button>
        </div>
        <span className={settings.hint}>{passwordNote ?? passwordHint(passwordStore)}</span>
      </div>
      <div className={settings.field}>
        <label className={settings.fieldLab} htmlFor={`${id}-ssl`}>
          Secure connection
        </label>
        <select
          id={`${id}-ssl`}
          className={`${settings.input} ${settings.select} ${styles.sslSelect}`}
          value={draft.ssl}
          disabled={disabled}
          onChange={(e) => set({ ssl: e.target.value as SslMode })}
        >
          {SSL_OPTIONS.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
        <span className={settings.hint}>Choose “Off” only for a server on this computer.</span>
      </div>
      <div className={styles.urlToggle}>
        {draft.useUrl ? (
          <>
            Or{' '}
            <button type="button" className={styles.linkBtn} onClick={() => set({ useUrl: false })}>
              fill in the fields
            </button>
          </>
        ) : (
          <>
            Or{' '}
            <button type="button" className={styles.linkBtn} onClick={() => set({ useUrl: true })}>
              paste a connection string
            </button>
            {preview && <div className={settings.mono}>{preview}</div>}
          </>
        )}
      </div>
    </div>
  );
}
