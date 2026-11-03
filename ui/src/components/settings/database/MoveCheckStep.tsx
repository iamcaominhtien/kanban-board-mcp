import { useState } from 'react';
import { useMoveCommand, useMoveStart, type DatabaseInfo, type MoveJob } from '../../../api/database';
import { extractError } from '../../../api/extractError';
import { SIcon } from '../settingsUi';
import settings from '../SettingsPage.module.css';
import { CopyButton, DarkCode, DB_ICONS, EngineBadge, Line, ModalBody, ModalFoot, Spinner } from './dbUi';
import { confirmName, fmtInt, formatBytes, shortWhere, targetUrl } from './dbFormat';
import styles from './Database.module.css';

/**
 * Step 2, Check (design/screens/ai-databases.md D0, E1): From and To, what will happen, the problems the plan found,
 * copy my data or start empty, and the script for those who run it themselves. A target that already holds tables
 * offers "Use another database" or "Empty it first…" (type its name to confirm).
 */
export function MoveCheckStep({
  job,
  db,
  onBack,
  onStarted,
}: {
  job: MoveJob;
  db: DatabaseInfo;
  /** Back to step 1 (also "Use another database"). */
  onBack: () => void;
  onStarted: () => void;
}) {
  const plan = job.plan;
  const report = job.report;
  const [mode, setMode] = useState<'copy' | 'empty'>('copy');
  const [emptying, setEmptying] = useState(false);
  const [typed, setTyped] = useState('');
  const [showScript, setShowScript] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = useMoveStart();
  const url = targetUrl(job.target);
  const command = useMoveCommand(url, true);
  const notEmpty = report?.state === 'foreign' || report?.state === 'board';
  const name = confirmName(job.target);
  const src = plan?.source;
  const srcIsFile = job.source.engine === 'sqlite';

  async function go(emptyFirst: boolean) {
    setError(null);
    try {
      await start.mutateAsync({ mode, ...(emptyFirst ? { emptyFirst: true, confirm: typed.trim() } : {}) });
      onStarted();
    } catch (e) {
      setError(extractError(e));
    }
  }

  const scriptText = command.data
    ? `${command.data.dryRun}\n\nexport ${command.data.passwordEnv}=…\n${command.data.run}`
    : '';

  return (
    <>
      <ModalBody testId="move-step-check">
        <div className={styles.fromTo}>
          <div className={styles.box}>
            <div className={styles.boxHead}>
              <EngineBadge engine={job.source.engine} size="sm" />
              <b>From: {job.source.label}</b>
            </div>
            <span className={styles.monoChip}>{job.source.display}</span>
            {src && (
              <>
                <span>
                  {[
                    src.size != null ? formatBytes(src.size) : null,
                    `${fmtInt(src.tables)} tables`,
                    `about ${fmtInt(src.rows)} rows`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                <span>
                  {fmtInt(src.tickets)} tickets, {fmtInt(src.projects)} projects, {fmtInt(src.aiMembers)} AI members
                </span>
                {src.atHead && <span>Schema is at the newest migration</span>}
              </>
            )}
          </div>
          <SIcon d={DB_ICONS.arrowRight} size={20} stroke="#5B6B60" />
          <div className={styles.box}>
            <div className={styles.boxHead}>
              <EngineBadge engine={job.target.engine} size="sm" />
              <b>To: {report?.version || job.target.label}</b>
            </div>
            <span className={styles.monoChip}>{job.target.display}</span>
            <span>
              {notEmpty
                ? `Holds ${fmtInt(report?.tables)} tables already`
                : `Empty · the board will create ${fmtInt(plan?.tablesCount)} tables`}
            </span>
            <span>Connection tested a moment ago</span>
          </div>
        </div>

        {notEmpty && (
          <div className={styles.notEmpty} data-testid="move-not-empty">
            <div className={styles.dangerBox}>
              <SIcon d={DB_ICONS.warn} size={18} stroke="#C4432A" />
              <div>
                <b>
                  {name} on {shortWhere(job.target) || job.target.display} already has {fmtInt(report?.tables)} tables
                </b>
                <div className={styles.lineDetail}>
                  The board will not write into a database that already holds something, because it cannot tell what is
                  yours.
                </div>
              </div>
            </div>
            <ul className={styles.lines}>
              <Line
                level="error"
                title={`Found · ${fmtInt(report?.tables)} tables${report?.tickets != null ? `, ${fmtInt(report.tickets)} tickets` : ''}${
                  report?.state === 'board' ? ' (it looks like another Kanban board)' : ''
                }`}
              />
            </ul>
            <p className={styles.para}>
              Choose another database or schema, or empty this one. Emptying deletes every table in <b>{name}</b>
              {job.target.engine !== 'sqlite' && (
                <>
                  {' '}
                  on <b>{job.target.host}</b>
                </>
              )}
              .
            </p>
            <div className={settings.row}>
              <button type="button" className={`${settings.btn} ${settings.btnPrimary}`} onClick={onBack}>
                <SIcon d={DB_ICONS.database} size={14} />
                Use another database
              </button>
              <button
                type="button"
                className={settings.btn}
                aria-expanded={emptying}
                onClick={() => setEmptying((v) => !v)}
              >
                <SIcon d={DB_ICONS.trash} size={14} />
                Empty it first…
              </button>
            </div>
            {emptying && (
              <div className={settings.confirmBox}>
                <label htmlFor="move-confirm-name">
                  Type <b>{name}</b> to confirm:
                </label>
                <input
                  id="move-confirm-name"
                  className={settings.input}
                  value={typed}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setTyped(e.target.value)}
                  data-testid="move-confirm-input"
                />
                <div className={settings.row}>
                  <button
                    type="button"
                    className={`${settings.btn} ${settings.btnDanger}`}
                    disabled={typed.trim() !== name || start.isPending}
                    onClick={() => void go(true)}
                    data-testid="move-empty-first"
                  >
                    {start.isPending ? <Spinner /> : <SIcon d={DB_ICONS.trash} size={14} />}
                    Delete the {fmtInt(report?.tables)} tables and go on
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        <div className={styles.eyebrow}>What will happen</div>
        <ul className={styles.lines}>
          <Line
            level="ok"
            title="The tables are created first · the same migrations run on the new database, so the structure is exactly the app’s own."
          />
          {mode === 'copy' && (
            <Line
              level="ok"
              title="Rows are copied table by table · parents before children, in batches, inside one transaction per table."
            />
          )}
          <Line
            level="ok"
            title={`Your ${job.source.label} ${srcIsFile ? 'file' : 'database'} is only read · it is not changed, moved or deleted, and stays a way back.`}
          />
          <Line
            level="warn"
            title={`Attachments do not move · ${
              plan?.attachments
                ? `${fmtInt(plan.attachments.files)} file${plan.attachments.files === 1 ? '' : 's'} (${formatBytes(plan.attachments.size)})`
                : 'they'
            } stay in the data folder on this computer (${db.dataFolder}). Another computer using this database will not see them.`}
          />
          {plan?.notes.map((n) => (
            <Line key={n.key} level="warn" title={n.title} detail={n.detail || undefined} />
          ))}
          {plan?.problems.map((p) => (
            <Line
              key={p.key}
              level={p.level === 'error' ? 'error' : 'warn'}
              title={p.title}
              detail={p.detail || undefined}
            />
          ))}
        </ul>

        <div className={styles.eyebrow}>What goes into the new database</div>
        <div className={styles.modes} role="radiogroup" aria-label="What goes into the new database">
          {(
            [
              ['copy', 'Copy my data', 'Everything above, so the board looks the same after the switch.'],
              [
                'empty',
                'Start empty',
                `A new board on the new database. Your ${job.source.label} data is left where it is.`,
              ],
            ] as const
          ).map(([value, title, text]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={mode === value}
              className={`${settings.choice} ${mode === value ? settings.choiceOn : ''} ${styles.mode}`}
              onClick={() => setMode(value)}
              data-testid={`move-mode-${value}`}
            >
              <span className={`${settings.radioDot} ${mode === value ? settings.radioDotOn : ''}`} />
              <span className={styles.modeText}>
                <span>
                  <b>{title}</b>
                  {value === 'copy' && <span className={styles.dim}> Recommended</span>}
                </span>
                <span className={styles.lineDetail}>{text}</span>
              </span>
            </button>
          ))}
        </div>

        <div className={styles.scriptRow}>
          <SIcon d={DB_ICONS.terminal} size={16} />
          <span className={styles.grow}>
            Rather run it yourself, for a big database or on a server? Use the script.
          </span>
          {command.data && <CopyButton text={scriptText} label="Copy the command" />}
          <button
            type="button"
            className={settings.btn}
            aria-expanded={showScript}
            onClick={() => setShowScript((v) => !v)}
          >
            <SIcon d={DB_ICONS.chevronRight} size={14} />
            {showScript ? 'Hide it' : 'Show it'}
          </button>
        </div>
        {showScript && command.data && (
          <DarkCode caption="the script" testId="move-script">
            <div className={styles.darkComment}># 1 · look first (--dry-run): writes nothing</div>
            <div>$ {command.data.dryRun}</div>
            <div className={styles.darkComment}># 2 · do it, then compare (--verify)</div>
            <div>$ export {command.data.passwordEnv}=…</div>
            <div>$ {command.data.run}</div>
          </DarkCode>
        )}

        {error && (
          <div className={`${settings.notice} ${styles.noticeErr}`} role="alert">
            <SIcon d={DB_ICONS.warn} size={15} stroke="#C4432A" />
            <span>{error}</span>
          </div>
        )}
      </ModalBody>
      <ModalFoot>
        <button type="button" className={settings.btn} onClick={onBack}>
          <SIcon d={DB_ICONS.back} size={14} />
          Back
        </button>
        <span className={styles.spacer} />
        {notEmpty && <span className={settings.hint}>Empty it first, or use another database.</span>}
        <button
          type="button"
          className={`${settings.btn} ${settings.btnPrimary}`}
          disabled={notEmpty || start.isPending}
          onClick={() => void go(false)}
          data-testid="move-start"
        >
          {start.isPending ? <Spinner /> : <SIcon d={DB_ICONS.play} size={14} />}
          {mode === 'copy' ? 'Copy my data' : 'Create empty database'}
        </button>
      </ModalFoot>
    </>
  );
}
