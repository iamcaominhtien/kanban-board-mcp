import { useMemo, useState } from 'react';
import { usePacks } from '../../../api/aiPacks';
import { useSaveTemplate } from '../../../api/aiWorkflow';
import { extractError } from '../../../api/extractError';
import type { Gives, WorkflowStep, WorkflowTemplate } from '../../../types/aiWorkflow';
import { DEPTHS, cap, roleName, stepsSummary } from './wfFormat';
import { StepChain } from './WfUi';
import './workflow.css';
import { MenuSelect } from '../../ui/MenuSelect';

const GIVES: { key: Gives; label: string }[] = [
  { key: 'ticket', label: 'The ticket' },
  { key: 'criteria', label: 'The criteria' },
  { key: 'design', label: 'The design' },
  { key: 'previous_note', label: 'The previous step’s note' },
  { key: 'transcript', label: 'The transcript' },
];
const MODELS = ['', 'haiku', 'sonnet', 'opus'];
const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
const DEFAULT_ROLES = [
  'triage',
  'pm',
  'ba',
  'designer',
  'dev',
  'reviewer',
  'qa',
  'user_tester',
  'tech_writer',
  'devops',
  'security',
  'data_analyst',
];

const slug = (s: string) => {
  let out = '';
  for (const c of s.toLowerCase()) {
    if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) out += c;
    else if (out && !out.endsWith('_')) out += '_';
  }
  return out.endsWith('_') ? out.slice(0, -1) || 'step' : out || 'step';
};

function uniqueKey(base: string, taken: string[]): string {
  let k = base;
  for (let n = 2; taken.includes(k); n++) k = `${base}_${n}`;
  return k;
}

const blankStep = (steps: WorkflowStep[]): WorkflowStep => ({
  key: uniqueKey(
    'step',
    steps.map((s) => s.key),
  ),
  label: 'New step',
  kind: 'ai',
  role: 'dev',
  handsIn: '',
  gives: ['ticket', 'criteria', 'design', 'previous_note'],
  model: null,
  effort: null,
  retryModel: null,
  depth: null,
});

/** The step editor of a template (design: E): move, remove, who does it, what it hands in, what it is given, model. */
export function TemplateEditor({
  projectId,
  template,
  templates,
  ticketsOn = 0,
  isNew = false,
  onClose,
}: {
  projectId: string;
  template: WorkflowTemplate;
  templates: WorkflowTemplate[];
  /** How many tickets are on this template now (from the measurements). */
  ticketsOn?: number;
  /** A workflow written from a copy of a template: only "Save as new" applies. */
  isNew?: boolean;
  onClose: () => void;
}) {
  const packs = usePacks(projectId);
  const save = useSaveTemplate(projectId);
  const [name, setName] = useState(template.name);
  const [description, setDescription] = useState(template.description);
  const [steps, setSteps] = useState<WorkflowStep[]>(() => template.steps.map((s) => ({ ...s, gives: [...s.gives] })));
  const [sel, setSel] = useState(
    Math.max(
      0,
      template.steps.findIndex((s) => s.kind === 'ai' && s.role !== 'triage'),
    ),
  );
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<WorkflowTemplate | null>(null);

  const roleOptions = useMemo(() => {
    const fromPacks = (packs.data ?? []).map((p) => ({
      key: p.key,
      name: p.name,
      hint: p.tagline as string | undefined,
    }));
    const keys = new Set(fromPacks.map((p) => p.key));
    return [
      ...fromPacks,
      ...DEFAULT_ROLES.filter((r) => !keys.has(r)).map((r) => ({
        key: r,
        name: roleName(r),
        hint: undefined as string | undefined,
      })),
    ];
  }, [packs.data]);
  const names = useMemo(() => Object.fromEntries(roleOptions.map((r) => [r.key, r.name])), [roleOptions]);

  const step = steps[sel] as WorkflowStep | undefined;
  const patch = (i: number, p: Partial<WorkflowStep>) =>
    setSteps((all) => all.map((s, j) => (j === i ? { ...s, ...p } : s)));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= steps.length) return;
    setSteps((all) => {
      const next = [...all];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
    setSel(j);
  };
  const remove = (i: number) => {
    setSteps((all) => all.filter((_, j) => j !== i));
    setSel(Math.max(0, Math.min(i, steps.length - 2)));
  };
  const add = () => {
    // before the last step, which always waits for you
    const at = steps.length && steps[steps.length - 1].kind === 'person' ? steps.length - 1 : steps.length;
    setSteps((all) => [...all.slice(0, at), blankStep(all), ...all.slice(at)]);
    setSel(at);
  };
  const who = (i: number, v: string) => {
    if (v === '@code') patch(i, { kind: 'code', role: null, depth: null });
    else if (v === '@you') patch(i, { kind: 'person', role: null, depth: null });
    else patch(i, { kind: 'ai', role: v, depth: v === 'reviewer' ? (steps[i].depth ?? 'standard') : null });
  };

  const people = steps.filter((s) => s.kind === 'person').length + (steps[steps.length - 1]?.kind === 'person' ? 0 : 1);
  const noRole = steps.find((s) => s.kind === 'ai' && !s.role);
  const lastIsPerson = steps[steps.length - 1]?.kind === 'person';

  const body = (n: string) => ({
    name: n,
    description,
    steps: steps.map((s) => ({
      key: s.key,
      label: s.label.trim() || 'Step',
      kind: s.kind,
      role: s.kind === 'ai' ? s.role : null,
      handsIn: s.handsIn,
      gives: s.gives,
      model: s.model || null,
      effort: s.effort || null,
      retryModel: s.retryModel || null,
      depth: s.kind === 'ai' && s.role === 'reviewer' ? s.depth : null,
    })),
  });
  const run = async (key: string, n: string) => {
    setError(null);
    try {
      setSaved(await save.mutateAsync({ key, body: body(n) }));
    } catch (e) {
      setError(extractError(e));
    }
  };
  const saveNew = () => {
    const taken = templates.map((t) => t.key);
    const n = !isNew && name.trim() === template.name ? `${name.trim()} (copy)` : name.trim();
    setName(n);
    void run(uniqueKey(slug(n), taken), n);
  };
  const warning = saved?.warning ?? (people > 2 ? 'This template stops for you more than twice.' : null);

  return (
    <div
      className="ai-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={isNew ? 'New workflow' : `Edit ${template.name}`}
      data-testid="template-editor"
    >
      <div className="ai-modal" style={{ width: 780 }}>
        <div className="ai-modal-head">
          <h2 className="ai-modal-title">{isNew ? 'New workflow' : 'Edit workflow'}</h2>
          <div className="wf-hint">
            Templates are versioned: a ticket remembers the version it started on, so editing one never rewrites what a
            ticket did last week.
          </div>
        </div>
        <div className="ai-modal-body">
          <div className="wf-line">
            <label className="wf-field" style={{ flex: 1, minWidth: 180 }}>
              <span className="wf-label">Name</span>
              <input
                className="wf-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                aria-label="Template name"
              />
            </label>
            <label className="wf-field" style={{ flex: 2, minWidth: 220 }}>
              <span className="wf-label">What it is for</span>
              <input
                className="wf-input"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                aria-label="Template description"
              />
            </label>
          </div>
          {ticketsOn > 0 && (
            <div className="ai-notice ai-notice-info" data-testid="in-use">
              {ticketsOn} ticket{ticketsOn === 1 ? ' is' : 's are'} on this template. Changing it leaves them to finish
              on the old shape; save it as a new template to keep both.
            </div>
          )}
          <StepChain steps={steps} names={names} selected={sel} onSelect={setSel} />
          <div className="wf-hint">
            {stepsSummary(steps)}
            {!lastIsPerson && ' · a last step, Done, is added for you'}
          </div>
          {warning && (
            <div className="ai-notice ai-notice-warn" role="status" data-testid="editor-warning">
              {warning} Review stays one of them; the built-in templates stop for you exactly twice.
            </div>
          )}
          {step && (
            <div className="wf-editor-step" data-testid="step-editor">
              <div className="wf-line">
                <b>
                  Step {sel + 1} &mdash; {step.label || 'Step'}
                </b>
                <span className="wf-grow" />
                <button type="button" className="ai-btn ai-btn-sm" disabled={sel === 0} onClick={() => move(sel, -1)}>
                  Move up
                </button>
                <button
                  type="button"
                  className="ai-btn ai-btn-sm"
                  disabled={sel === steps.length - 1}
                  onClick={() => move(sel, 1)}
                >
                  Move down
                </button>
                <button
                  type="button"
                  className="ai-btn ai-btn-sm"
                  disabled={steps.length < 2}
                  onClick={() => remove(sel)}
                >
                  Remove
                </button>
              </div>
              <label className="wf-field">
                <span className="wf-label">Name of the step</span>
                <input
                  className="wf-input"
                  value={step.label}
                  onChange={(e) => patch(sel, { label: e.target.value })}
                  aria-label="Step name"
                />
              </label>
              <div className="wf-field">
                <span className="wf-label">Who does it</span>
                {/* E: the design's own dropdown, each role with a second line */}
                <MenuSelect
                  label="Who does it"
                  testId="wf-who"
                  value={step.kind === 'code' ? '@code' : step.kind === 'person' ? '@you' : (step.role ?? '')}
                  onChange={(v) => who(sel, v)}
                  placeholder="Pick a role"
                  options={[
                    ...roleOptions.map((r) => ({ value: r.key, label: `The ${r.name} role`, hint: r.hint })),
                    { value: '@code', label: 'Code, no AI', hint: 'The project’s checks' },
                    { value: '@you', label: 'You', hint: 'The step waits for you' },
                  ]}
                />
                <span className="wf-hint">
                  A role, not a person. Whichever member holds that role on the project picks it up.
                  {step.kind === 'ai' && step.role ? ` (${roleName(step.role, names)})` : ''}
                </span>
              </div>
              {step.kind === 'ai' && (
                <>
                  <label className="wf-field">
                    <span className="wf-label">What it has to hand in</span>
                    <textarea
                      className="wf-textarea"
                      value={step.handsIn}
                      onChange={(e) => patch(sel, { handsIn: e.target.value })}
                      aria-label="What it has to hand in"
                    />
                    <span className="wf-hint">
                      This text goes into the prompt, and the step is not done until the board can see it.
                    </span>
                  </label>
                  <div className="wf-field">
                    <span className="wf-label">What it is given</span>
                    <div className="wf-gives">
                      {GIVES.map((g) => {
                        const on = step.gives.includes(g.key);
                        return (
                          <button
                            key={g.key}
                            type="button"
                            role="switch"
                            aria-checked={on}
                            data-testid={`give-${g.key}`}
                            className={`wf-give${on ? ' wf-give-on' : ''}${g.key === 'transcript' && !on ? ' wf-give-risk' : ''}`}
                            onClick={() =>
                              patch(sel, { gives: on ? step.gives.filter((x) => x !== g.key) : [...step.gives, g.key] })
                            }
                          >
                            {g.label}
                          </button>
                        );
                      })}
                    </div>
                    <span className="wf-hint">
                      The red one is off: a checker that read how the work was done is no longer independent.
                    </span>
                  </div>
                  <div className="wf-line">
                    <div className="wf-field" style={{ flex: 1 }}>
                      <span className="wf-label">Model</span>
                      <MenuSelect
                        label="Model"
                        testId="wf-model"
                        value={step.model ?? ''}
                        onChange={(v) => patch(sel, { model: v || null })}
                        options={MODELS.map((m) => ({ value: m, label: m ? cap(m) : 'The role’s own' }))}
                      />
                    </div>
                    <div className="wf-field" style={{ flex: 1 }}>
                      <span className="wf-label">Effort</span>
                      <MenuSelect
                        label="Effort"
                        testId="wf-effort"
                        value={step.effort ?? ''}
                        onChange={(v) => patch(sel, { effort: v || null })}
                        options={EFFORTS.map((m) => ({ value: m, label: m ? cap(m) : 'The role’s own' }))}
                      />
                    </div>
                    {step.role === 'reviewer' && (
                      <div className="wf-field" style={{ flex: 1 }}>
                        <span className="wf-label">Review depth</span>
                        <MenuSelect
                          label="Review depth"
                          testId="wf-depth"
                          value={step.depth ?? 'standard'}
                          onChange={(v) => patch(sel, { depth: v as WorkflowStep['depth'] })}
                          options={DEPTHS.map((d) => ({ value: d as string, label: cap(d as string) }))}
                        />
                      </div>
                    )}
                  </div>
                  <label
                    className="wf-line"
                    style={{ cursor: 'pointer' }}
                    htmlFor="wf-retry-opus"
                    aria-label="Opus at high on a second attempt"
                  >
                    <input
                      id="wf-retry-opus"
                      type="checkbox"
                      checked={step.retryModel === 'opus'}
                      onChange={(e) => patch(sel, { retryModel: e.target.checked ? 'opus' : null })}
                    />
                    <span>
                      <b style={{ fontSize: 12.5 }}>Opus at high on a second attempt</b>
                      <span className="wf-hint"> &middot; only after the same step failed once</span>
                    </span>
                  </label>
                </>
              )}
              {step.kind === 'code' && (
                <div className="wf-hint">
                  Done by code, not by an AI: it runs the project’s test, lint and build commands, costs no quota, and
                  no AI review starts until it passes.
                </div>
              )}
              {step.kind === 'person' && (
                <div className="wf-hint">
                  The work stops here until you answer. The last step always waits for you: the ticket sits in Review
                  until you move it to Done.
                </div>
              )}
            </div>
          )}
          <div>
            <button type="button" className="ai-btn ai-btn-sm" onClick={add}>
              Add a step
            </button>
          </div>
          {noRole && (
            <div className="ai-notice ai-notice-warn" role="status">
              The step {noRole.label} needs a role.
            </div>
          )}
          {error && (
            <div className="ai-notice ai-notice-error" role="alert">
              {error}
            </div>
          )}
          {saved && (
            <div className="ai-notice ai-notice-info" role="status" data-testid="editor-saved">
              Saved as {saved.name}, version {saved.version}. Tickets already on it keep the version they started on.
            </div>
          )}
        </div>
        <div className="ai-modal-foot">
          <button type="button" className="ai-btn" onClick={onClose}>
            {saved ? 'Close' : 'Cancel'}
          </button>
          <span className="wf-grow" style={{ flex: 1 }} />
          <button
            type="button"
            className={isNew ? 'ai-btn ai-btn-primary' : 'ai-btn'}
            disabled={save.isPending || !!noRole || !name.trim()}
            onClick={saveNew}
          >
            Save as new
          </button>
          {!isNew && (
            <button
              type="button"
              className="ai-btn ai-btn-primary"
              disabled={save.isPending || !!noRole || !name.trim()}
              onClick={() => void run(template.key, name.trim())}
            >
              Change this one
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
