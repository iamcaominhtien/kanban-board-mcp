import { useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { useQueryClient } from '@tanstack/react-query';
import { pageAiProblem, usePageAiStart, usePageJob, type DiagramResult } from '../../../api/docsAiPage';
import { cleanEditorMarkdown } from '../../../utils/docsMarkdown';
import { costLabel } from '../../../utils/docsAiRules';
import { problemLine } from '../../../utils/pageAiRules';
import { Icon } from '../Icon';
import './pageAi.css';

/** What the cursor is on: a diagram to change, a selection to draw, or the whole page. */
export function diagramTarget(editor: Editor | null): { diagramId: string | null; selection: string | null } {
  if (!editor) return { diagramId: null, selection: null };
  const { from, to } = editor.state.selection;
  const id = editor.isActive('diagram') ? (editor.getAttributes('diagram').id as string) : null;
  const selection = from !== to ? editor.state.doc.textBetween(from, to, '\n').trim() : '';
  return { diagramId: id || null, selection: selection || null };
}

/** Put the diagram line after the block the cursor is in. */
export function insertDiagram(editor: Editor | null, markdown: string): boolean {
  if (!editor) return false;
  const { $to } = editor.state.selection;
  const pos = $to.depth ? $to.after(1) : $to.pos;
  return editor
    .chain()
    .focus()
    .insertContentAt(pos, `${markdown}\n`, { contentType: 'markdown' } as never)
    .run();
}

/**
 * Draw a diagram: the AI member draws the selection (or the page) as an editable draw.io diagram and the line that
 * shows it is put in the person's draft. With a diagram selected it changes that diagram instead (a new version).
 */
export function DrawDiagram({
  pageId,
  getEditor,
  getMarkdown,
  onClose,
}: {
  pageId: string;
  getEditor: () => Editor | null;
  getMarkdown: () => string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const start = usePageAiStart(pageId);
  const target = diagramTarget(getEditor());
  const [instruction, setInstruction] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const { running, result, error } = usePageJob<DiagramResult>(jobId);
  const handled = useRef<string | null>(null);

  useEffect(() => {
    if (!result || handled.current === jobId) return;
    handled.current = jobId;
    if (result.changed) {
      void qc.invalidateQueries({ queryKey: ['diagram', result.diagramId] });
    } else {
      insertDiagram(getEditor(), result.markdown);
    }
  }, [result, jobId, qc, getEditor]);

  const go = () => {
    setProblem(null);
    setJobId(null);
    start.diagram.mutate(
      {
        selection: target.selection ?? undefined,
        instruction: instruction.trim() || undefined,
        diagramId: target.diagramId ?? undefined,
        markdown: cleanEditorMarkdown(getMarkdown()),
      },
      {
        onSuccess: (job) => setJobId(job.id),
        onError: (e) => {
          const p = pageAiProblem(e);
          setProblem(problemLine(p.code, p.detail));
        },
      },
    );
  };
  const busy = start.diagram.isPending || running;
  const failure = problem ?? (error ? problemLine(error.code, error.detail) : null);
  const changing = !!target.diagramId;
  return (
    <div className="pai-finding" data-testid="draw-diagram" style={{ display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon name="i57" size={14} />
        <strong>{changing ? 'Change this diagram' : 'Draw a diagram'}</strong>
        <span style={{ flex: 1 }} />
        <button type="button" className="st-btn st-btn-sm" onClick={onClose} aria-label="Close">
          Close
        </button>
      </div>
      <div className="pai-foot">
        {changing
          ? 'The AI redraws it as a new version; earlier versions stay in its history.'
          : target.selection
            ? 'From the text you selected.'
            : 'From this page.'}{' '}
        It is added to your draft; nothing is published.
      </div>
      <input
        className="st-input"
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        placeholder={
          changing
            ? 'What should change? e.g. add a cache between the API and the database'
            : 'What should it show? (optional)'
        }
        data-testid="draw-instruction"
      />
      {failure && (
        <div className="pai-err" role="alert">
          {failure}
        </div>
      )}
      {result && (
        <div className="pai-foot" data-testid="draw-done">
          {result.changed
            ? `Saved version ${result.version} of “${result.label}”.`
            : `Added “${result.label}” to your draft.`}{' '}
          {costLabel(result.cost, result.metered)}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          className="st-btn st-btn-sm pai-btn"
          disabled={busy || (changing && !instruction.trim())}
          onClick={go}
          data-testid="draw-go"
        >
          {busy ? 'Drawing…' : result ? 'Draw again' : changing ? 'Change it' : 'Draw it'}
        </button>
      </div>
    </div>
  );
}
