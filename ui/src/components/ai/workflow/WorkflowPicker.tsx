import { useState } from 'react';
import { useWorkflowMutation, useWorkflowTemplates, workflowApi } from '../../../api/aiWorkflow';
import { extractError } from '../../../api/extractError';
import type { WorkflowStep, WorkflowTemplate, WorkflowView } from '../../../types/aiWorkflow';
import { LoadError, useAiBoardState } from '../aiUi';
import { Ico } from '../settings/settingsUi';
import { roleOfConfig } from '../tools/MemberPluginsCard';
import { roleName as packRoleName } from '../tools/pluginLogic';
import { cap, roleLook, stepsSummary } from './wfFormat';
import './wfPicker.css';

/** The roles a template's AI steps need that no AI member of the project has. */
export function missingRoles(t: Pick<WorkflowTemplate, 'steps'>, teamRoles: Set<string>): string[] {
  const need = [...new Set(t.steps.filter((s) => s.kind === 'ai' && s.role).map((s) => s.role as string))];
  return need.filter((r) => !teamRoles.has(r));
}

/** "a User tester and a Designer". */
const roleList = (roles: string[]) => {
  const names = roles.map((r) => {
    const n = packRoleName(r);
    return `${/^[AEIO]/i.test(n) ? 'an' : 'a'} ${n}`;
  });
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
};

/** Triage put the ticket on its workflow: its step is the first and it is done. */
export const triageChose = (view: WorkflowView) => view.steps[0]?.role === 'triage' && view.steps[0]?.state === 'done';

/** One step of a workflow as a chip: a role's colour, code dashed, a stop for you dark. */
function StepChip({ s }: { s: WorkflowStep }) {
  if (s.kind === 'code') return <span className="wp-step wp-step-code">{s.label}</span>;
  if (s.kind === 'person') return <span className="wp-step wp-step-you">{s.label}</span>;
  const l = roleLook(s.role);
  return (
    <span className="wp-step" style={{ background: l.bg, color: l.fg, border: `1px solid ${l.border}55` }}>
      {s.label}
      {s.depth && s.depth !== 'standard' ? ` · ${cap(s.depth)}` : ''}
    </span>
  );
}

/**
 * Move a ticket to another workflow (design/screens/ai-story-flow.md, R1): each workflow with its steps, how often it
 * stops for you, the roles the project lacks for it, and the one Triage chose.
 */
export function WorkflowPicker({
  ticketId,
  projectId,
  view,
  onDone,
}: {
  ticketId: string;
  projectId: string;
  view: WorkflowView;
  onDone: () => void;
}) {
  const templates = useWorkflowTemplates(projectId);
  const { members } = useAiBoardState();
  const [picked, setPicked] = useState(view.templateKey);
  const [error, setError] = useState<string | null>(null);
  const change = useWorkflowMutation(ticketId, async (k: string) => {
    await workflowApi.detach(ticketId);
    return workflowApi.attach(ticketId, k);
  });
  const teamRoles = new Set(
    [...members.values()]
      .filter((m) => m.kind === 'ai')
      .map((m) => roleOfConfig(m.config))
      .filter((r): r is string => !!r),
  );
  const byTriage = triageChose(view);

  return (
    <div className="wp-wrap" role="group" aria-label="Move it to another workflow" data-testid="change-workflow">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <b style={{ fontSize: 13.5 }}>Move it to another workflow</b>
      </div>
      {templates.isLoading ? (
        <div className="ai-skel" style={{ height: 120 }} aria-busy="true" aria-label="Loading the workflows" />
      ) : templates.error || !templates.data ? (
        <LoadError what="the workflows" error={templates.error} onRetry={() => void templates.refetch()} />
      ) : (
        <div className="wp-grid" role="radiogroup" aria-label="Workflow">
          {templates.data.map((t) => {
            const missing = missingRoles(t, teamRoles);
            const current = t.key === view.templateKey;
            return (
              <button
                key={t.key}
                type="button"
                role="radio"
                aria-checked={picked === t.key}
                className="wp-card"
                data-testid={`pick-${t.key}`}
                onClick={() => setPicked(t.key)}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="wp-radio" aria-hidden="true" />
                  <b style={{ fontSize: 13.5 }}>{t.name}</b>
                  <span style={{ flex: 1 }} />
                  {current && byTriage && (
                    <span className="wp-chip" style={{ background: '#EEF1F4', color: '#3A4A5E' }}>
                      Triage chose this
                    </span>
                  )}
                  {current && !byTriage && (
                    <span className="wp-chip" style={{ background: '#E8F1FA', color: '#244E78' }}>
                      Now on it
                    </span>
                  )}
                </span>
                {t.description && (
                  <span className="ai-hint" style={{ lineHeight: 1.4 }}>
                    {t.description}
                  </span>
                )}
                <span className="wp-steps">
                  {t.steps.map((s, i) => (
                    <span key={`${s.key}${i}`} style={{ display: 'contents' }}>
                      {i > 0 && (
                        <span className="wp-sep" aria-hidden="true">
                          ›
                        </span>
                      )}
                      <StepChip s={s} />
                    </span>
                  ))}
                </span>
                <span style={{ fontSize: 11.5, color: '#5B6B60' }}>{stepsSummary(t.steps)}</span>
                {missing.length ? (
                  <span className="wp-roles" style={{ color: '#7A5A06' }} data-testid={`missing-${t.key}`}>
                    <Ico name="warn" size={12} />
                    Needs {roleList(missing)}: none on this project
                  </span>
                ) : (
                  <span className="wp-roles" style={{ color: '#1F5A31' }}>
                    <Ico name="tick" size={12} />
                    Every role is on the team
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span className="ai-hint" style={{ flex: 1, minWidth: 200 }}>
          Starts again from the first step of the new workflow; the steps done so far are dropped.
        </span>
        <button type="button" className="ai-btn ai-btn-sm" onClick={onDone}>
          Cancel
        </button>
        <button
          type="button"
          className="ai-btn ai-btn-sm ai-btn-primary"
          disabled={picked === view.templateKey || change.isPending}
          onClick={() => {
            setError(null);
            change.mutate(picked, { onSuccess: onDone, onError: (e) => setError(extractError(e)) });
          }}
        >
          Move it over
        </button>
      </div>
      {error && (
        <div className="ai-error-text" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
