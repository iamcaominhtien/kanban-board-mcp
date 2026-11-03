import { useState } from 'react';
import {
  reportOfError,
  useMoveCheck,
  useTestConnection,
  type DatabaseInfo,
  type Engine,
  type TestReport,
} from '../../../api/database';
import { extractError } from '../../../api/extractError';
import { SIcon } from '../settingsUi';
import settings from '../SettingsPage.module.css';
import { ConnectionForm, draftReady, draftToBody, emptyDraft, type ConnectionDraft } from './ConnectionForm';
import { DB_ICONS, EngineBadge, FindingList, ModalBody, ModalFoot, Spinner, WhyOnlyThese } from './dbUi';
import { ENGINE_NAME } from './dbFormat';
import styles from './Database.module.css';

const ENGINES: { engine: Engine; text: string; tag: string }[] = [
  { engine: 'sqlite', text: 'A file in the data folder. No server, no setup.', tag: 'No setup' },
  { engine: 'postgresql', text: 'A server you run or rent. Version 14 or newer.', tag: 'Needs a server' },
  { engine: 'mysql', text: 'MySQL 8 or MariaDB 10.6 and newer, utf8mb4.', tag: 'Needs a server' },
];

/**
 * Step 1, Where to (design/screens/ai-databases.md C1 to C3): pick an engine, fill in the connection, Test. Next is
 * on only when the test found no red line; it checks the target again and reads the plan (step 2).
 */
export function MoveWhereStep({
  db,
  draft,
  onDraft,
  report,
  onReport,
  onChecked,
  onCancel,
}: {
  db: DatabaseInfo;
  /** The form, or null while the engine is being chosen. */
  draft: ConnectionDraft | null;
  onDraft: (d: ConnectionDraft | null) => void;
  report: TestReport | null;
  onReport: (r: TestReport | null) => void;
  /** The check passed: the move is ready (step 2). */
  onChecked: () => void;
  onCancel: () => void;
}) {
  const [choice, setChoice] = useState<Engine | null>(draft?.engine ?? null);
  const [why, setWhy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const test = useTestConnection();
  const check = useMoveCheck();

  if (!draft) {
    return (
      <>
        <ModalBody testId="move-step-where">
          <div className={styles.engineCards} role="radiogroup" aria-label="Database engine">
            {ENGINES.map(({ engine, text, tag }) => {
              const current = engine === db.engine;
              const on = choice === engine;
              return (
                <button
                  key={engine}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={current}
                  data-testid={`engine-${engine}`}
                  className={`${styles.engineCard} ${on ? styles.engineCardOn : ''} ${current ? styles.engineCardCurrent : ''}`}
                  onClick={() => setChoice(engine)}
                >
                  <span className={styles.engineCardHead}>
                    <EngineBadge engine={engine} />
                    <b>{ENGINE_NAME[engine]}</b>
                    <span className={styles.spacer} />
                    {on ? (
                      <SIcon d={DB_ICONS.checkCircle} size={18} stroke="#2E6F40" />
                    ) : (
                      <span className={styles.radioRing} />
                    )}
                  </span>
                  <span className={styles.engineCardText}>
                    {text}
                    {current && ' This is where you are now.'}
                  </span>
                  <span className={`${styles.tag} ${current ? styles.tagGrey : styles[`tag_${engine}`]}`}>
                    {current ? 'Current' : tag}
                  </span>
                </button>
              );
            })}
          </div>
          <p className={settings.hint}>
            Redis and MongoDB are not on this list: the board is relational, and neither can hold it.{' '}
            <button type="button" className={styles.linkBtn} aria-expanded={why} onClick={() => setWhy((v) => !v)}>
              Why?
            </button>
          </p>
          {why && <WhyOnlyThese tables={db.tables} />}
        </ModalBody>
        <ModalFoot>
          <button type="button" className={settings.btn} onClick={onCancel}>
            <SIcon d={DB_ICONS.close} size={14} />
            Cancel
          </button>
          <span className={styles.spacer} />
          <button
            type="button"
            className={`${settings.btn} ${settings.btnPrimary}`}
            disabled={!choice}
            data-testid="move-next"
            onClick={() => choice && onDraft(emptyDraft(choice))}
          >
            <SIcon d={DB_ICONS.arrowRight} size={14} />
            Next
          </button>
        </ModalFoot>
      </>
    );
  }

  const ready = draftReady(draft);
  const blocked = !!report && !report.ok;

  async function runTest() {
    if (!draft) return;
    setError(null);
    try {
      onReport(await test.mutateAsync(draftToBody(draft)));
    } catch (e) {
      onReport(null);
      setError(extractError(e));
    }
  }

  async function next() {
    if (!draft) return;
    setError(null);
    try {
      await check.mutateAsync(draftToBody(draft));
      onChecked();
    } catch (e) {
      setError(extractError(e));
      const r = reportOfError(e);
      if (r) onReport(r);
    }
  }

  return (
    <>
      <ModalBody testId="move-step-where">
        <div className={styles.engineHead}>
          <EngineBadge engine={draft.engine} />
          <b>{ENGINE_NAME[draft.engine]}</b>
          <span className={styles.spacer} />
          <button
            type="button"
            className={settings.btn}
            onClick={() => {
              onReport(null);
              onDraft(null);
            }}
          >
            <SIcon d={DB_ICONS.chevronRight} size={14} />
            Change engine
          </button>
        </div>
        <div className={styles.split}>
          <div className={styles.form}>
            <ConnectionForm
              draft={draft}
              onChange={(d) => {
                onDraft(d);
                onReport(null);
              }}
              passwordStore={db.passwordStore}
              sqlitePath={db.sqliteFile.path}
              disabled={check.isPending}
            />
            <div className={settings.row}>
              <button
                type="button"
                className={`${settings.btn} ${settings.btnPrimary}`}
                disabled={!ready || test.isPending}
                onClick={runTest}
                data-testid="move-test"
              >
                {test.isPending ? <Spinner /> : <SIcon d={DB_ICONS.refresh} size={14} />}
                Test connection
              </button>
              <span className={settings.hint}>Tests do not change the database.</span>
            </div>
          </div>
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
              <div className={styles.placeholder}>
                Press <b>Test connection</b>. The test says what it found in plain lines, and for each problem how to
                fix it.
              </div>
            )}
          </div>
        </div>
      </ModalBody>
      <ModalFoot>
        <button type="button" className={settings.btn} onClick={() => onDraft(null)}>
          <SIcon d={DB_ICONS.back} size={14} />
          Back
        </button>
        <span className={styles.spacer} />
        {blocked && <span className={settings.hint}>Next is off until every line is green or amber.</span>}
        {!report && !blocked && <span className={settings.hint}>Test the connection first.</span>}
        <button
          type="button"
          className={`${settings.btn} ${report?.ok ? settings.btnPrimary : ''}`}
          disabled={!report?.ok || check.isPending}
          onClick={next}
          data-testid="move-next"
        >
          {check.isPending ? <Spinner /> : <SIcon d={DB_ICONS.arrowRight} size={14} />}
          Next
        </button>
      </ModalFoot>
    </>
  );
}
