import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  moveIsOpen,
  moveKey,
  useForgetMove,
  useMove,
  type DatabaseInfo,
  type MoveJob,
  type TestReport,
} from '../../../api/database';
import type { ConnectionDraft } from './ConnectionForm';
import { Modal, StepHeader } from './dbUi';
import { MoveCheckStep } from './MoveCheckStep';
import { MoveCopyStep } from './MoveCopyStep';
import { MoveVerifyStep } from './MoveVerifyStep';
import { MoveWhereStep } from './MoveWhereStep';

type Stage = 'where' | 'check' | 'copy' | 'verify' | 'done';

const STEP_OF: Record<Stage, 1 | 2 | 3 | 4> = { where: 1, check: 2, copy: 3, verify: 4, done: 4 };

/** Which step a move is at; `where` wins while the person is (back) in step 1. */
export function stageOf(job: MoveJob | null | undefined, inWhere: boolean): Stage {
  if (inWhere || !job || job.state === 'new') return 'where';
  if (job.state === 'ready') return 'check';
  if (job.state === 'switched') return 'done';
  if (['verifying', 'verified', 'verified_with_differences', 'switching'].includes(job.state)) return 'verify';
  return 'copy';
}

/** States in which closing the wizard also closes the move on the server (nothing is running or left to do). */
const FORGET_ON_CLOSE: MoveJob['state'][] = ['new', 'ready', 'cancelled', 'switched'];

/**
 * Move to another database (design/screens/ai-databases.md C, D, E): 1 Where to, 2 Check, 3 Copy, 4 Verify. The
 * steps after 1 follow the move on the server, so the wizard can be hidden while it copies and opened again from the
 * card.
 */
export function MoveDatabaseDialog({ db, onClose }: { db: DatabaseInfo; onClose: () => void }) {
  const qc = useQueryClient();
  const move = useMove();
  const job = move.data ?? null;
  const forget = useForgetMove();
  const [inWhere, setInWhere] = useState(() => !moveIsOpen(qc.getQueryData<MoveJob | null>(moveKey) ?? db.move));
  const [draft, setDraft] = useState<ConnectionDraft | null>(null);
  const [report, setReport] = useState<TestReport | null>(null);
  const stage = stageOf(job, inWhere);

  const close = () => {
    if (job && FORGET_ON_CLOSE.includes(job.state)) forget.mutate(undefined, { onSettled: onClose });
    else onClose();
  };

  const backToWhere = () => setInWhere(true);

  const sub =
    stage === 'where'
      ? 'Your data stays where it is until the last step. Nothing is changed by choosing.'
      : stage === 'check'
        ? 'Step 2 of 4 · nothing has been written yet.'
        : stage === 'copy'
          ? `Step 3 of 4${job?.state === 'stopped' ? ' · stopped' : job?.state === 'paused' ? ' · paused' : ''}`
          : stage === 'verify'
            ? 'Step 4 of 4'
            : 'Done';

  return (
    <Modal
      title="Move to another database"
      sub={sub}
      head={<StepHeader step={STEP_OF[stage]} allDone={stage === 'done'} />}
      onClose={close}
      width={stage === 'copy' && job?.state === 'stopped' ? 980 : 860}
      testId="move-dialog"
    >
      {stage === 'where' && (
        <MoveWhereStep
          db={db}
          draft={draft}
          onDraft={setDraft}
          report={report}
          onReport={setReport}
          onChecked={() => setInWhere(false)}
          onCancel={close}
        />
      )}
      {stage === 'check' && job && <MoveCheckStep job={job} db={db} onBack={backToWhere} onStarted={() => {}} />}
      {stage === 'copy' && job && <MoveCopyStep job={job} onHide={onClose} onRestart={backToWhere} onClose={close} />}
      {(stage === 'verify' || stage === 'done') && job && <MoveVerifyStep job={job} onClose={close} />}
    </Modal>
  );
}
