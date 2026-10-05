import { useState } from 'react';
import { extractError } from '../api/extractError';
import styles from './AppLoading.module.css';

interface FirstRunProps {
  onCreate: (data: { name: string; prefix: string; color: string }) => Promise<unknown>;
}

const PREFIX_RE = /^[A-Za-z]{2,5}$/;

/** Shown when the project list came back empty: create the first project, no further loading screen. */
export function FirstRun({ onCreate }: FirstRunProps) {
  const [name, setName] = useState('');
  const [prefix, setPrefix] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const prefixInvalid = prefix.length > 0 && !PREFIX_RE.test(prefix);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !PREFIX_RE.test(prefix)) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate({ name: name.trim(), prefix: prefix.toUpperCase(), color: '#2E6F40' });
    } catch (err) {
      setError(extractError(err));
      setBusy(false);
    }
  }

  return (
    <div className={styles.firstRun}>
      <form className={styles.firstRunCard} onSubmit={submit}>
        <h1 className={styles.firstRunTitle}>Create your first project</h1>
        <p className={styles.firstRunText}>Projects hold your boards and tickets.</p>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="first-project-name">
            Project name
          </label>
          <input
            id="first-project-name"
            className={styles.input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Kanban Redesign"
            autoFocus
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="first-project-prefix">
            Prefix
          </label>
          <input
            id="first-project-prefix"
            className={`${styles.input} ${prefixInvalid ? styles.inputError : ''}`}
            value={prefix}
            onChange={(e) => setPrefix(e.target.value.toUpperCase().slice(0, 5))}
            placeholder="KAN"
            aria-invalid={prefixInvalid}
            aria-describedby="first-project-prefix-hint"
          />
          <span id="first-project-prefix-hint" className={prefixInvalid ? styles.fieldError : styles.hint}>
            Prefix: 2 to 5 letters, used in ticket IDs, e.g. KAN-1
          </span>
        </div>
        {error && (
          <span className={styles.fieldError} role="alert">
            {error}
          </span>
        )}
        <button type="submit" className={styles.firstRunBtn} disabled={busy || !name.trim() || !PREFIX_RE.test(prefix)}>
          {busy ? 'Creating…' : 'Create project'}
        </button>
      </form>
    </div>
  );
}
