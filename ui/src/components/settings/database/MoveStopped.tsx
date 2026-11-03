import { useState, type ReactNode } from 'react';
import { useMoveApply, useMoveAsk, useMoveCancel, useMoveResume, type MoveJob } from '../../../api/database';
import { extractError } from '../../../api/extractError';
import { SIcon } from '../settingsUi';
import settings from '../SettingsPage.module.css';
import { DarkCode, DB_ICONS, ModalBody, ModalFoot, Spinner } from './dbUi';
import { fmtInt } from './dbFormat';
import styles from './Database.module.css';

/** Statements typed by the person: split on ";" (or one per line when there is none), comments dropped. */
export function splitStatements(text: string): string[] {
  const lines = text
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
  const parts = lines.includes(';') ? lines.split(';') : lines.split('\n');
  return parts.map((s) => s.trim()).filter(Boolean);
}

function Fact({ name, value, bad }: { name: string; value: ReactNode; bad?: boolean }) {
  return (
    <div className={`${styles.fact} ${bad ? styles.factBad : ''}`}>
      <span className={styles.factName}>{name}</span>
      <span>{value}</span>
    </div>
  );
}

/**
 * A stopped copy (design/screens/ai-databases.md D4): where it stopped and what the board knows, what the AI is shown,
 * and what the AI suggests. The AI proposes; the board applies the statements, resumes and checks the counts itself.
 */
export function MoveStopped({ job }: { job: MoveJob }) {
  const stop = job.stop!;
  const ai = job.ai ?? { state: 'idle' };
  const proposal = ai.state === 'answered' ? ai.proposal : undefined;
  const ask = useMoveAsk();
  const apply = useMoveApply();
  const resume = useMoveResume();
  const cancel = useMoveCancel();
  const [editing, setEditing] = useState(false);
  const [edited, setEdited] = useState('');
  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState('');
  const [showShown, setShowShown] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = (p: Promise<unknown>, after?: () => void) => {
    setError(null);
    p.then(() => after?.()).catch((e) => setError(extractError(e)));
  };

  const target = stop.targetVersion || job.target.label;
  const source = `${stop.sourceEngine || job.source.label}${stop.sourceType ? `, column ${stop.sourceType}` : ''}`;
  const row =
    stop.valueNull === true
      ? 'empty (NULL)'
      : stop.valueLength != null
        ? `${fmtInt(stop.valueLength)} characters`
        : null;
  const statements = proposal?.statements ?? [];
  const chip =
    ai.state === 'asking'
      ? 'Asking…'
      : ai.state === 'answered'
        ? `${proposal?.member ?? 'AI'}${proposal?.elapsedS != null ? ` · ${Math.round(proposal.elapsedS)} s` : ''}`
        : ai.state === 'failed'
          ? 'Could not answer'
          : 'Not run yet';

  return (
    <>
      <ModalBody testId="move-step-stopped">
        <div className={styles.stopGrid}>
          <div className={styles.stopLeft}>
            <div className={styles.dangerBox} data-testid="move-stopped">
              <SIcon d={DB_ICONS.warn} size={18} stroke="#C4432A" />
              <div>
                <b>The copy stopped at table {stop.table}</b>
                <div className={styles.lineDetail}>
                  At row {fmtInt(stop.row)} of {fmtInt(stop.total)} a value would not go in. {stop.tablesDone} of{' '}
                  {stop.tablesTotal} tables are done and checked; the new database is consistent up to there.
                </div>
              </div>
            </div>
            <DarkCode caption="what the board knows" testId="move-stop-facts">
              <Fact
                name="table"
                value={`${stop.table}   (${fmtInt(stop.total)} rows, ${fmtInt(stop.copied)} copied)`}
              />
              <Fact name="error" value={stop.error} bad />
              {stop.column && <Fact name="column" value={`${stop.table}.${stop.column}`} bad />}
              {row && <Fact name="row" value={row} />}
              <Fact name="target" value={`${target}${stop.targetType ? `, column ${stop.targetType}` : ''}`} />
              <Fact name="source" value={source} />
            </DarkCode>
            <div className={styles.eyebrow}>What the AI is shown</div>
            <p className={styles.para}>
              The error, the table and column names, the column types on both sides, and row counts. <b>Not</b> the rows
              themselves and <b>never</b> the password.
            </p>
          </div>

          <div className={styles.stopRight} data-testid="move-ai">
            <div className={styles.aiHead}>
              <SIcon d={DB_ICONS.sparkle} size={18} stroke="#2E6F40" />
              <b>What the AI suggests</b>
              <span className={styles.spacer} />
              <span className={styles.tag + ' ' + styles.tagGrey} data-testid="move-ai-chip">
                {chip}
              </span>
            </div>

            {ai.state === 'idle' && (
              <>
                <p className={styles.para}>
                  An AI member of the board reads what the board knows (left) and proposes a change for the new database
                  only. You decide whether it runs.
                </p>
                <div className={settings.row}>
                  <button
                    type="button"
                    className={`${settings.btn} ${settings.btnPrimary}`}
                    disabled={ask.isPending}
                    onClick={() => run(ask.mutateAsync({}))}
                    data-testid="move-ask"
                  >
                    {ask.isPending ? <Spinner /> : <SIcon d={DB_ICONS.sparkle} size={14} />}
                    Ask the AI
                  </button>
                </div>
              </>
            )}

            {ai.state === 'asking' && (
              <div className={styles.asking} role="status">
                <Spinner size={16} />
                Asking {ai.member ?? 'the AI'}… {ai.question ? `“${ai.question}”` : ''}
              </div>
            )}

            {ai.state === 'failed' && (
              <>
                <div className={`${settings.notice} ${settings.noticeWarn}`} role="alert" data-testid="move-ai-failed">
                  <SIcon d={DB_ICONS.warn} size={15} stroke="#B4791E" />
                  <span>{ai.message ?? 'The AI could not answer.'}</span>
                </div>
                <div className={settings.row}>
                  <button type="button" className={settings.btn} onClick={() => run(ask.mutateAsync({}))}>
                    <SIcon d={DB_ICONS.refresh} size={14} />
                    Ask again
                  </button>
                </div>
              </>
            )}

            {proposal && (
              <>
                {ai.question && (
                  <div className={styles.qa}>
                    <div className={styles.dim}>You asked: “{ai.question}”</div>
                    {proposal.answer && <p className={styles.para}>{proposal.answer}</p>}
                  </div>
                )}
                {proposal.cause && (
                  <p className={styles.para}>
                    <b>Likely cause.</b> {proposal.cause}
                  </p>
                )}
                {statements.length > 0 ? (
                  <>
                    <p className={styles.para}>
                      <b>Proposed change</b>, on the new database only:
                    </p>
                    <DarkCode caption="proposed script" testId="move-ai-script">
                      <div className={styles.darkComment}>
                        -- {statements.length} statement{statements.length === 1 ? '' : 's'}, on the target
                      </div>
                      {statements.map((s, i) => (
                        <div key={i} className={styles.darkStmt}>
                          {s.trim().endsWith(';') ? s : `${s};`}
                        </div>
                      ))}
                      <div className={styles.darkComment}>-- then: resume from {stop.table}, and re-check</div>
                    </DarkCode>
                  </>
                ) : (
                  <p className={styles.para}>
                    <b>No change proposed.</b>
                  </p>
                )}
                {proposal.affects && (
                  <p className={styles.para}>
                    <b>What it affects.</b> {proposal.affects}
                  </p>
                )}
                {proposal.otherColumns?.length > 0 && (
                  <p className={styles.para}>
                    <b>Other columns that may not fit.</b>{' '}
                    {proposal.otherColumns.map((c, i) => (
                      <span key={c}>
                        {i > 0 && ', '}
                        <span className={settings.code}>{c}</span>
                      </span>
                    ))}
                  </p>
                )}
                <div className={`${settings.notice} ${styles.noticeOk}`}>
                  <SIcon d={DB_ICONS.sparkle} size={15} stroke="#2E6F40" />
                  <span>
                    <b>The AI proposes; the board applies.</b> It runs the statement, resumes the copy and re-checks the
                    counts itself. The AI’s own words never decide whether the copy succeeded.
                  </span>
                </div>
                {!proposal.applicable && (
                  <div className={`${settings.notice} ${styles.noticeErr}`} data-testid="move-ai-refused">
                    <SIcon d={DB_ICONS.warn} size={15} stroke="#C4432A" />
                    <span>
                      <b>The board will not run this.</b> {proposal.refused ?? ''}
                    </span>
                  </div>
                )}
                <div className={settings.row}>
                  <button
                    type="button"
                    className={`${settings.btn} ${settings.btnPrimary}`}
                    disabled={!proposal.applicable || statements.length === 0 || apply.isPending}
                    onClick={() => run(apply.mutateAsync({ statements }))}
                    data-testid="move-apply"
                  >
                    {apply.isPending ? <Spinner /> : <SIcon d={DB_ICONS.play} size={14} />}
                    Apply and resume
                  </button>
                  <button
                    type="button"
                    className={settings.btn}
                    aria-expanded={editing}
                    onClick={() => {
                      setEdited(statements.map((s) => (s.trim().endsWith(';') ? s : `${s};`)).join('\n'));
                      setEditing((v) => !v);
                    }}
                  >
                    <SIcon d={DB_ICONS.edit} size={14} />
                    Edit it myself
                  </button>
                  <button
                    type="button"
                    className={settings.btn}
                    aria-expanded={asking}
                    onClick={() => setAsking((v) => !v)}
                  >
                    <SIcon d={DB_ICONS.chat} size={14} />
                    Ask something else
                  </button>
                  <button
                    type="button"
                    className={settings.btn}
                    aria-expanded={showShown}
                    onClick={() => setShowShown((v) => !v)}
                  >
                    <SIcon d={DB_ICONS.code} size={14} />
                    What it was given
                  </button>
                </div>
                <div className={styles.dim} data-testid="move-ai-member">
                  Answered by {proposal.member}
                  {proposal.elapsedS != null ? ` in ${Math.round(proposal.elapsedS)} s` : ''}
                  {proposal.confidence ? ` · confidence ${proposal.confidence}` : ''}
                  {proposal.cost ? ` · $${proposal.cost.toFixed(3)}` : ''}
                </div>
              </>
            )}

            {editing && (
              <div className={styles.editBox}>
                <label className={settings.fieldLab} htmlFor="move-edit-statements">
                  Statements to run on the new database (end each with ;)
                </label>
                <textarea
                  id="move-edit-statements"
                  className={`${settings.input} ${settings.mono} ${styles.textarea}`}
                  rows={5}
                  value={edited}
                  spellCheck={false}
                  onChange={(e) => setEdited(e.target.value)}
                  data-testid="move-edit-statements"
                />
                <div className={settings.row}>
                  <button
                    type="button"
                    className={`${settings.btn} ${settings.btnPrimary}`}
                    disabled={splitStatements(edited).length === 0 || apply.isPending}
                    onClick={() =>
                      run(apply.mutateAsync({ statements: splitStatements(edited) }), () => setEditing(false))
                    }
                    data-testid="move-apply-edited"
                  >
                    {apply.isPending ? <Spinner /> : <SIcon d={DB_ICONS.play} size={14} />}
                    Apply and resume
                  </button>
                  <button type="button" className={settings.btn} onClick={() => setEditing(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {asking && (
              <div className={styles.editBox}>
                <label className={settings.fieldLab} htmlFor="move-question">
                  Ask the AI
                </label>
                <input
                  id="move-question"
                  className={settings.input}
                  value={question}
                  placeholder="Would TEXT be enough instead of LONGTEXT?"
                  onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && question.trim())
                      run(ask.mutateAsync({ question: question.trim() }), () => setAsking(false));
                  }}
                  data-testid="move-question"
                />
                <div className={settings.row}>
                  <button
                    type="button"
                    className={`${settings.btn} ${settings.btnPrimary}`}
                    disabled={!question.trim() || ask.isPending}
                    onClick={() => run(ask.mutateAsync({ question: question.trim() }), () => setAsking(false))}
                  >
                    {ask.isPending ? <Spinner /> : <SIcon d={DB_ICONS.chat} size={14} />}
                    Ask
                  </button>
                </div>
              </div>
            )}

            {showShown && proposal && (
              <DarkCode caption="exactly what the AI was given">
                <pre className={styles.darkPre}>{JSON.stringify(proposal.shown, null, 2)}</pre>
              </DarkCode>
            )}

            {job.applied.length > 0 && (
              <p className={styles.dim}>
                Applied before: {job.applied.length} statement{job.applied.length === 1 ? '' : 's'}.
              </p>
            )}
          </div>
        </div>
        {confirmCancel && (
          <div className={settings.confirmBox} role="alertdialog" aria-label="Cancel the copy">
            <span className={settings.confirmTitle}>
              <SIcon d={DB_ICONS.warn} size={16} stroke="#C4432A" />
              Cancel the copy?
            </span>
            <span>The new database is cleared. Your {job.source.label} data is not touched.</span>
            <div className={settings.row}>
              <button type="button" className={settings.btn} onClick={() => setConfirmCancel(false)}>
                Keep it
              </button>
              <button
                type="button"
                className={`${settings.btn} ${settings.btnDanger}`}
                disabled={cancel.isPending}
                onClick={() => run(cancel.mutateAsync(), () => setConfirmCancel(false))}
              >
                {cancel.isPending && <Spinner />}
                Cancel and clear the new database
              </button>
            </div>
          </div>
        )}
        {error && (
          <div className={`${settings.notice} ${styles.noticeErr}`} role="alert">
            <SIcon d={DB_ICONS.warn} size={15} stroke="#C4432A" />
            <span>{error}</span>
          </div>
        )}
      </ModalBody>
      <ModalFoot>
        <button type="button" className={settings.btn} onClick={() => setConfirmCancel(true)}>
          <SIcon d={DB_ICONS.close} size={14} />
          Cancel the copy
        </button>
        <span className={styles.spacer} />
        <button
          type="button"
          className={settings.btn}
          disabled={resume.isPending}
          onClick={() => run(resume.mutateAsync({}))}
          data-testid="move-resume-plain"
        >
          {resume.isPending ? <Spinner /> : <SIcon d={DB_ICONS.refresh} size={14} />}
          Resume without a change
        </button>
      </ModalFoot>
    </>
  );
}
