import { useAiOverview } from '../../../api/ai';
import { useWorkflowTemplates } from '../../../api/aiWorkflow';
import type { ProjectOps } from '../../../api/aiProjectOps';
import { Toggle } from '../aiUi';
import { roleOfConfig } from '../tools/MemberPluginsCard';
import { NumberSetting, SettingRow } from './settingsUi';

const INTAKE_COLUMNS: [string, string][] = [
  ['backlog', 'Backlog'],
  ['todo', 'To Do'],
  ['in-progress', 'In Progress'],
  ['review', 'Review'],
  ['testing', 'Testing'],
];
const RISKS: ['low' | 'medium' | 'high', string][] = [
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
];

const sinceText = (iso?: string | null) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime())
    ? ` Since ${d.toLocaleDateString([], { day: 'numeric', month: 'short' })}.`
    : '';
};

/**
 * "The team on its own" (design/screens/ai-team-process.md, M; D8, D7, D24): which tickets the team takes by itself,
 * who plans and who coordinates, what the PM may decide, and how far it goes before a person is asked.
 */
export function TeamOnItsOwn({
  ops,
  busy,
  save,
  projectId,
}: {
  ops: ProjectOps;
  busy: boolean;
  save: (body: Partial<ProjectOps>) => void;
  projectId: string;
}) {
  const overview = useAiOverview(projectId);
  const templates = useWorkflowTemplates(projectId);
  const members = (overview.data?.members ?? []).filter((m) => m.kind === 'ai');
  const withRole = (role: string) => members.filter((m) => roleOfConfig(m.config) === role);
  const intake = ops.intake ?? {};
  const manager = ops.manager ?? {};
  const triage = withRole('triage');
  const pms = withRole('pm');

  return (
    <>
      <div style={{ fontSize: 13, fontWeight: 700 }} data-testid="ops-own-heading">
        The team on its own
      </div>
      <SettingRow
        title="New tickets are taken by the team"
        hint={`Only tickets that arrive after you turn it on, in the column below and assigned to nobody. Triage reads each one and puts it on a workflow.${intake.on ? sinceText(intake.since) : ''}`}
      >
        <Toggle
          on={!!intake.on}
          label="New tickets are taken by the team"
          testId="ops-intake"
          disabled={busy}
          onChange={(v) => save({ intake: { on: v } })}
        />
      </SettingRow>
      {intake.on && (
        <SettingRow
          title="Taken from the column"
          hint="A ticket given to a person, or straight to one AI, is left alone."
        >
          <select
            className="ai-select"
            aria-label="Column new tickets are taken from"
            data-testid="ops-intake-status"
            value={intake.status ?? 'todo'}
            disabled={busy}
            onChange={(e) => save({ intake: { status: e.target.value } })}
          >
            {INTAKE_COLUMNS.map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </SettingRow>
      )}
      <SettingRow
        title="Workflow for new tickets"
        hint="What a taken ticket is put on. None: it is handed straight to one AI."
      >
        <select
          className="ai-select"
          aria-label="Workflow for new tickets"
          data-testid="ops-workflow-default"
          value={ops.workflowDefault ?? ''}
          disabled={busy}
          onChange={(e) => save({ workflowDefault: e.target.value })}
        >
          <option value="">None</option>
          {(templates.data ?? []).map((t) => (
            <option key={t.key} value={t.key}>
              {t.name}
            </option>
          ))}
        </select>
      </SettingRow>
      <SettingRow title="Triage" hint="The member that reads new tickets. Any Triage when none is chosen.">
        <select
          className="ai-select"
          aria-label="Triage"
          data-testid="ops-triage"
          value={ops.triageId ?? ''}
          disabled={busy}
          onChange={(e) => save({ triageId: e.target.value || null })}
        >
          <option value="">Any Triage</option>
          {triage.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </SettingRow>
      <div className="ai-divider" />
      <SettingRow
        title="The PM runs the team"
        hint="A step that failed twice, AI questions and permission requests nobody picked up, and tickets Triage says are several pieces go to the PM before you."
      >
        <Toggle
          on={!!manager.on}
          label="The PM runs the team"
          testId="ops-manager"
          disabled={busy}
          onChange={(v) => save({ manager: { on: v } })}
        />
      </SettingRow>
      <SettingRow title="The PM" hint="Arbitrates and runs the team. The first PM when none is chosen.">
        <select
          className="ai-select"
          aria-label="The PM"
          data-testid="ops-coordinator"
          value={ops.coordinatorId ?? ''}
          disabled={busy}
          onChange={(e) => save({ coordinatorId: e.target.value || null })}
        >
          <option value="">The first PM</option>
          {pms.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </SettingRow>
      {manager.on && (
        <>
          <SettingRow
            title="Waits for a person first"
            hint="How long a question or a request stays with you before the PM takes it."
          >
            <NumberSetting
              value={manager.graceMin ?? 5}
              min={0}
              label="Minutes before the PM takes over"
              testId="ops-manager-grace"
              disabled={busy}
              onSave={(n) => save({ manager: { graceMin: n } })}
            />
            <span className="ai-hint">minutes</span>
          </SettingRow>
          <SettingRow title="Highest risk the PM decides" hint="Anything above it still goes to you.">
            <select
              className="ai-select"
              aria-label="Highest risk the PM decides"
              data-testid="ops-manager-risk"
              value={manager.maxRisk ?? 'medium'}
              disabled={busy}
              onChange={(e) => save({ manager: { maxRisk: e.target.value as 'low' | 'medium' | 'high' } })}
            >
              {RISKS.map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </SettingRow>
          <SettingRow title="Decisions an hour" hint="After this many the PM stops deciding and asks you.">
            <NumberSetting
              value={manager.perHourLimit ?? 20}
              min={1}
              label="Decisions the PM may take in an hour"
              testId="ops-manager-limit"
              disabled={busy}
              onSave={(n) => save({ manager: { perHourLimit: n } })}
            />
          </SettingRow>
        </>
      )}
      <div className="ai-divider" />
      <SettingRow
        title="Done stays your move"
        hint={
          ops.autonomy?.done === 'after_review'
            ? 'The board moves it to Done itself once the checks, test-first and the review all passed. Moving to Done merges the branch.'
            : 'The ticket waits in Review until you move it to Done, which merges the branch.'
        }
      >
        <select
          className="ai-select"
          aria-label="Who moves a ticket to Done"
          data-testid="ops-autonomy-done"
          value={ops.autonomy?.done ?? 'person'}
          disabled={busy}
          onChange={(e) => save({ autonomy: { done: e.target.value as 'person' | 'after_review' } })}
        >
          <option value="person">Done stays your move</option>
          <option value="after_review">The board moves it to Done once checks, test-first and review all passed</option>
        </select>
      </SettingRow>
      {ops.autonomy?.done === 'after_review' && (
        <div className="ai-notice ai-notice-warn" role="note" data-testid="ops-done-warning">
          Done merges. With this on, a ticket that passed everything is merged without you.
        </div>
      )}
      <SettingRow title="Test first" hint="A Dev step needs a failing test run before the passing one.">
        <Toggle
          on={ops.tdd?.required ?? true}
          label="A Dev step needs a failing test run before the passing one"
          testId="ops-tdd"
          disabled={busy}
          onChange={(v) => save({ tdd: { required: v } })}
        />
      </SettingRow>
      <SettingRow
        title="Tokens one ticket may use"
        hint="Its workflow stops for you when the ticket's runs add up to this. 0 is no cap."
      >
        <NumberSetting
          value={ops.ticketTokenCap ?? 0}
          min={0}
          width={96}
          label="Tokens one ticket may use, 0 for no cap"
          testId="ops-token-cap"
          disabled={busy}
          onSave={(n) => save({ ticketTokenCap: n })}
        />
        <span className="ai-hint">tokens</span>
      </SettingRow>
      <SettingRow
        title="A message reaches a running AI at its next turn"
        hint="Off: it reaches the AI at its next call to the board."
      >
        <Toggle
          on={!!ops.liveMessages}
          label="A message reaches a running AI at its next turn"
          testId="ops-live-messages"
          disabled={busy}
          onChange={(v) => save({ liveMessages: v })}
        />
      </SettingRow>
      <SettingRow
        title="Watch GitHub for the pull requests the board opened"
        hint="No webhook: the app asks gh every few minutes while a pull request is open."
      >
        <Toggle
          on={!!ops.github?.on}
          label="Watch GitHub for the pull requests the board opened"
          testId="ops-github-on"
          disabled={busy}
          onChange={(v) => save({ github: { on: v } })}
        />
      </SettingRow>
      <SettingRow
        title="Red CI this change caused and review comments go to the Dev by themselves"
        hint="Only for pull requests the board opened."
      >
        <Toggle
          on={ops.github?.auto ?? true}
          label="Red CI this change caused and review comments go to the Dev by themselves"
          testId="ops-github-auto"
          disabled={busy}
          onChange={(v) => save({ github: { auto: v } })}
        />
      </SettingRow>
    </>
  );
}
