import { useState } from 'react';
import {
  reportOfError,
  useSaveConnection,
  useTestConnection,
  type DatabaseInfo,
  type DatabaseSettings,
  type TestReport,
} from '../../../api/database';
import { extractError } from '../../../api/extractError';
import { SIcon } from '../settingsUi';
import settings from '../SettingsPage.module.css';
import { ConnectionForm, draftFromSettings, draftReady, draftToBody, type ConnectionDraft } from './ConnectionForm';
import { DB_ICONS, FindingList, Modal, Spinner } from './dbUi';
import { ENGINE_NAME } from './dbFormat';
import styles from './Database.module.css';

/**
 * Edit connection… (design/screens/ai-databases.md B2, E3): the same server database reached another way (a new
 * password, host or secure connection). The data is not copied; a database that does not hold this board is refused.
 */
export function EditConnectionDialog({
  current,
  passwordStore,
  sqlitePath,
  onClose,
  onSaved,
}: {
  current: DatabaseSettings;
  passwordStore: 'keychain' | 'file';
  sqlitePath: string;
  onClose: () => void;
  onSaved?: (db: DatabaseInfo) => void;
}) {
  const [draft, setDraft] = useState<ConnectionDraft>(() => draftFromSettings(current));
  const [report, setReport] = useState<TestReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const test = useTestConnection();
  const save = useSaveConnection();
  const ready = draftReady(draft);

  const body = () => draftToBody(draft, { keepPassword: true });

  async function runTest() {
    setError(null);
    try {
      setReport(await test.mutateAsync(body()));
    } catch (e) {
      setReport(null);
      setError(extractError(e));
    }
  }

  async function runSave() {
    setError(null);
    try {
      const db = await save.mutateAsync(body());
      onSaved?.(db);
      onClose();
    } catch (e) {
      setError(extractError(e));
      const r = reportOfError(e);
      if (r) setReport(r);
    }
  }

  return (
    <Modal
      title="Edit connection"
      icon={DB_ICONS.edit}
      sub={`The same ${ENGINE_NAME[current.engine]} database, reached another way. Nothing is copied.`}
      onClose={onClose}
      width={820}
      testId="edit-connection"
      footer={
        <>
          <button type="button" className={settings.btn} onClick={onClose}>
            Cancel
          </button>
          <span className={styles.spacer} />
          <button type="button" className={settings.btn} disabled={!ready || test.isPending} onClick={runTest}>
            {test.isPending ? <Spinner /> : <SIcon d={DB_ICONS.refresh} size={14} />}
            Test connection
          </button>
          <button
            type="button"
            className={`${settings.btn} ${settings.btnPrimary}`}
            disabled={!ready || save.isPending}
            onClick={runSave}
          >
            {save.isPending ? <Spinner /> : <SIcon d={DB_ICONS.check} size={14} />}
            Save and reconnect
          </button>
        </>
      }
    >
      <div className={styles.split}>
        <ConnectionForm
          draft={draft}
          onChange={(d) => {
            setDraft(d);
            setReport(null);
          }}
          passwordStore={passwordStore}
          sqlitePath={sqlitePath}
          passwordNote="Leave it empty to keep the saved password."
        />
        <div className={styles.splitSide}>
          {error && (
            <div className={`${settings.notice} ${styles.noticeErr}`} role="alert">
              <SIcon d={DB_ICONS.warn} size={15} stroke="#C4432A" />
              <span>{error}</span>
            </div>
          )}
          {report ? (
            <FindingList findings={report.findings} />
          ) : (
            <p className={settings.hint}>Test first if you are not sure. Tests do not change the database.</p>
          )}
        </div>
      </div>
    </Modal>
  );
}
