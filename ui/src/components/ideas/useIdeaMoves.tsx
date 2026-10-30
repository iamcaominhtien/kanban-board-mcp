import { useCallback, useState, type ReactNode } from 'react';
import { ideaRuleError, useMoveIdea, useUndoIdeaMove, useUndoMerge } from '../../api/ideas';
import type { Idea, IdeaStage } from '../../types/idea';
import { STAGE_LABELS } from '../../types/idea';
import { FooterNote, ModalShell, Spacer } from '../docs/docsShared';
import { useToast } from '../Toast';
import { ArchiveDialog, KeepDialog, MergeDialog, ParkDialog } from './TriageDialogs';

type Subject = Pick<Idea, 'id' | 'title' | 'projectId' | 'tags' | 'body' | 'description' | 'stage'>;

export type Decision = 'keep' | 'park' | 'merge' | 'archive';

interface Options {
  /** Promote was asked for (the Building stage is reached through Promote only). */
  onPromote: (idea: Subject) => void;
  /** Called after any change, e.g. to advance a triage list to the next idea. */
  onChanged?: (ideaId: string, decision: string) => void;
}

/**
 * The one place that turns "move this idea to that stage" into the right dialog or request.
 * Keep, Park, Merge and Archive open their small dialogs; a move that skips the readiness checks asks first; every
 * accepted move shows a toast with Undo.
 * @returns `request(idea, to)` and `decide(idea, decision)` to call, and `dialogs` to render.
 */
export function useIdeaMoves({ onPromote, onChanged }: Options) {
  const toast = useToast();
  const move = useMoveIdea();
  const undoMove = useUndoIdeaMove();
  const undoMerge = useUndoMerge();
  const [dialog, setDialog] = useState<{ kind: Decision | 'skip-checks'; idea: Subject } | null>(null);

  const done = useCallback(
    (message: string, undo?: 'move' | 'merge', targetId?: string, ideaId?: string) => {
      toast.success(
        message,
        undefined,
        9000,
        undo
          ? {
              label: 'Undo',
              onClick: () => {
                if (undo === 'merge' && targetId) undoMerge.mutate(targetId);
                else if (ideaId) undoMove.mutate(ideaId);
              },
            }
          : undefined,
      );
    },
    [toast, undoMerge, undoMove],
  );

  const decide = useCallback((idea: Subject, decision: Decision) => setDialog({ kind: decision, idea }), []);

  const request = useCallback(
    async (idea: Subject, to: IdeaStage) => {
      if (idea.stage === to) return;
      if (idea.stage === 'building') {
        toast.error('Not allowed while the ticket is open', 'Close or remove the ticket first.');
        return;
      }
      if (to === 'building') return onPromote(idea);
      if (to === 'parked') return setDialog({ kind: 'park', idea });
      if (to === 'archived') return setDialog({ kind: 'archive', idea });
      if (to === 'shipped') {
        toast.error('Shipped follows the ticket', 'An idea ships by itself when its ticket is Done.');
        return;
      }
      if (to === 'exploring' && idea.stage === 'inbox') return setDialog({ kind: 'keep', idea });
      try {
        await move.mutateAsync({ id: idea.id, to, via: 'Drag' });
        done(`Moved “${idea.title}” to ${STAGE_LABELS[to]}`, 'move', undefined, idea.id);
        onChanged?.(idea.id, to);
      } catch (e) {
        const rule = ideaRuleError(e);
        if (rule.code === 'not_ready') setDialog({ kind: 'skip-checks', idea });
        else toast.error('Could not move the idea', rule.message);
      }
    },
    [move, toast, done, onPromote, onChanged],
  );

  const close = () => setDialog(null);
  const finished =
    (idea: Subject, decision: string) => (message: string, undo?: 'move' | 'merge', targetId?: string) => {
      close();
      done(message, undo, targetId, idea.id);
      onChanged?.(idea.id, decision);
    };

  let dialogs: ReactNode = null;
  if (dialog) {
    const { kind, idea } = dialog;
    if (kind === 'keep') dialogs = <KeepDialog idea={idea} onClose={close} onDone={finished(idea, 'keep')} />;
    else if (kind === 'park') dialogs = <ParkDialog idea={idea} onClose={close} onDone={finished(idea, 'park')} />;
    else if (kind === 'archive')
      dialogs = <ArchiveDialog idea={idea} onClose={close} onDone={finished(idea, 'archive')} />;
    else if (kind === 'merge') dialogs = <MergeDialog idea={idea} onClose={close} onDone={finished(idea, 'merge')} />;
    else
      dialogs = (
        <ModalShell
          width={420}
          ariaLabel="Move without the checks"
          title="Move to Ready without the checks?"
          subtitle={idea.title}
          onClose={close}
          footer={
            <>
              <FooterNote>It is a signal, not a rule. The move is recorded in the idea’s history.</FooterNote>
              <Spacer />
              <button type="button" className="is-btn" onClick={close}>
                Cancel
              </button>
              <button
                type="button"
                className="is-btn is-btn-primary"
                onClick={async () => {
                  try {
                    await move.mutateAsync({ id: idea.id, to: 'ready', force: true, via: 'Drag' });
                    finished(idea, 'ready')(`Moved “${idea.title}” to Ready`, 'move');
                  } catch (e) {
                    close();
                    toast.error('Could not move the idea', ideaRuleError(e).message);
                  }
                }}
              >
                Move anyway
              </button>
            </>
          }
        >
          <div className="is-root is-dlg-body" style={{ flex: 'none', background: 'transparent' }}>
            Not every high-impact assumption of this idea is validated yet. Ready means “everything that matters has
            been tested”.
          </div>
        </ModalShell>
      );
  }

  return { request, decide, dialogs };
}
