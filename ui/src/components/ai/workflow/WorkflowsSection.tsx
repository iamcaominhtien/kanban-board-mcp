import { LineIcon } from '../../ui/LineIcon';
import { useMemo, useState } from 'react';
import { useWorkflowMetrics, useWorkflowTemplates } from '../../../api/aiWorkflow';
import type { WorkflowMetric, WorkflowTemplate } from '../../../types/aiWorkflow';
import { LoadError } from '../aiUi';
import { TemplateEditor } from './TemplateEditor';
import { hoursLabel, percent, stepsSummary } from './wfFormat';
import { StepChain } from './WfUi';
import './workflow.css';

/** Workflow templates of the project (design/screens/ai-team-process.md, E): four ready-made, and an editor. */
export function WorkflowsSection({ projectId }: { projectId: string }) {
  const q = useWorkflowTemplates(projectId);
  const metrics = useWorkflowMetrics(projectId);
  const [edit, setEdit] = useState<WorkflowTemplate | null>(null);
  const [fresh, setFresh] = useState(false);
  const byKey = useMemo(() => {
    const m = new Map<string, WorkflowMetric>();
    (metrics.data ?? []).forEach((x) => m.set(x.templateKey, x));
    return m;
  }, [metrics.data]);

  if (q.isLoading)
    return (
      <div
        data-testid="workflows-section"
        data-project={projectId}
        className="ai-skel"
        style={{ height: 120 }}
        aria-busy="true"
        aria-label="Loading workflows"
      />
    );
  if (q.error || !q.data) return <LoadError what="the workflows" error={q.error} onRetry={() => void q.refetch()} />;
  const templates = q.data;

  return (
    <div data-testid="workflows-section" data-project={projectId} className="wf-wrap">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span style={{ flex: 1 }} />
        <button type="button" className="ai-btn ai-btn-sm ai-btn-primary" onClick={() => setFresh(true)}>
          New workflow
        </button>
      </div>
      <div className="wf-hint">
        A ticket follows one of these. Triage picks it from the type and the labels; you change it on the ticket. The
        last three columns are measured, over the last 30 days.
      </div>
      {templates.length === 0 ? (
        <div className="ai-notice ai-notice-slate">No workflows yet.</div>
      ) : (
        <div className="wf-table" data-testid="workflow-table" style={{ overflowX: 'auto' }}>
          <div className="wf-th">
            <span>Template</span>
            <span>Steps</span>
            <span>Used on</span>
            <span>Median</span>
            <span>Passed first</span>
            <span />
          </div>
          {templates.map((t) => {
            const m = byKey.get(t.key);
            return (
              <div key={t.key} className="wf-row" data-testid={`workflow-row-${t.key}`}>
                <div>
                  <div className="wf-name">{t.name}</div>
                  <div className="wf-hint">{t.description}</div>
                  {!t.builtin && <span className="wf-pill">Your own</span>}
                </div>
                <div>
                  <StepChain steps={t.steps} />
                  <div className="wf-hint" style={{ marginTop: 4 }}>
                    {stepsSummary(t.steps)}
                  </div>
                  {t.warning && (
                    <div className="wf-hint" style={{ color: '#7a5a06' }}>
                      {t.warning}
                    </div>
                  )}
                </div>
                <div>
                  {m ? (
                    <>
                      <b>{m.tickets}</b> ticket{m.tickets === 1 ? '' : 's'}
                    </>
                  ) : (
                    <span className="wf-hint">–</span>
                  )}
                </div>
                <div className="wf-hint">{hoursLabel(m?.medianHours)}</div>
                <div className="wf-hint">{percent(m?.passedFirst)}</div>
                <div>
                  <button
                    type="button"
                    className="ai-btn ai-btn-sm"
                    aria-label={`Edit ${t.name}`}
                    onClick={() => setEdit(t)}
                  >
                    <LineIcon name="edit" size={13} /> Edit
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <div className="wf-hint">
        <b>The italic step is done by code, not by an AI.</b> <i>Checks</i> runs the project’s test, lint and build
        commands and collects the test-first evidence. It costs no quota, and no AI review starts until it passes.
      </div>
      <div className="wf-hint">
        <b>Few steps, cut where the context has to change.</b> A step exists because the next worker should start clean,
        not because a phase has a name.
      </div>
      <div className="wf-hint">
        <b>An odd job has no workflow.</b> Handing a ticket straight to one AI still works and is not a failure of the
        system. It gets an optional reviewer field and nothing else.
      </div>
      {edit && (
        <TemplateEditor
          projectId={projectId}
          template={edit}
          templates={templates}
          ticketsOn={byKey.get(edit.key)?.tickets ?? 0}
          onClose={() => setEdit(null)}
        />
      )}
      {fresh && (
        <TemplateEditor
          projectId={projectId}
          template={{
            key: '',
            name: 'New workflow',
            description: '',
            version: 0,
            builtin: false,
            personStops: 1,
            warning: null,
            steps: (templates.find((t) => t.key === 'quick_fix') ?? templates[0])?.steps ?? [],
          }}
          templates={templates}
          isNew
          ticketsOn={0}
          onClose={() => setFresh(false)}
        />
      )}
    </div>
  );
}
