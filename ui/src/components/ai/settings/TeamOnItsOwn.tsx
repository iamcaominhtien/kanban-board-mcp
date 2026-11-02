import { useState, type ReactNode } from 'react';
import { useAiOverview } from '../../../api/ai';
import { usePacks } from '../../../api/aiPacks';
import { useAiMe, useAutopilot } from '../../../api/aiSafety';
import { useWorkflowTemplates } from '../../../api/aiWorkflow';
import type { ProjectOps } from '../../../api/aiProjectOps';
import { extractError } from '../../../api/extractError';
import { Toggle } from '../aiUi';
import { Dialog } from '../config/parts';
import { MakeMemberModal } from '../packs/PackDialogs';
import { roleOfConfig } from '../tools/MemberPluginsCard';
import { GroupHead, Ico, NumberSetting, TeamRow } from './settingsUi';
import './teamOwn.css';

type Risk = 'low' | 'medium' | 'high';

export const INTAKE_COLUMNS: [string, string][] = [
  ['backlog', 'Backlog'],
  ['todo', 'To Do'],
  ['in-progress', 'In Progress'],
  ['review', 'Review'],
  ['testing', 'Testing'],
];
/** The ceiling in Autopilot's wording, used in both places (design L). */
const RISKS: [Risk, string][] = [
  ['low', 'Low only'],
  ['medium', 'Up to Medium'],
  ['high', 'Everything'],
];
const RISK_WORD: Record<Risk, string> = { low: 'Low', medium: 'Medium', high: 'High' };

/** The three tiers with the actions that are in them (Members › Permissions). */
const TIERS: { risk: Risk; bg: string; fg: string; does: string; why: string }[] = [
  {
    risk: 'low',
    bg: '#E6F2EA',
    fg: '#1F5A31',
    does: 'Read tickets, comment, edit fields, create tickets, manage test cases.',
    why: 'Reversible and inside the ticket.',
  },
  {
    risk: 'medium',
    bg: '#FEF3D9',
    fg: '#7A5A06',
    does: 'Change status, change assignee, edit docs, move a page to the trash, create a branch.',
    why: 'Moves work or changes shared text. The default ceiling.',
  },
  {
    risk: 'high',
    bg: '#FDECE8',
    fg: '#A5321E',
    does: 'Delete a ticket.',
    why: 'Cannot be taken back. Blocked for AI members by default.',
  },
];

const dateText = (iso?: string | null) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString([], { day: 'numeric', month: 'short' }) : null;
};

/** 1st, 2nd, 3rd, 21st… */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

/**
 * "What this setup means": the two lists written from the settings, so they cannot disagree with them (design L).
 * `pm` is the PM that would run the team, or null when the project has none.
 */
export function setupMeaning(
  ops: ProjectOps,
  pm: string | null,
  workflowName: string | null,
): { own: ReactNode[]; you: ReactNode[] } {
  const intake = ops.intake ?? {};
  const manager = ops.manager ?? {};
  const own: ReactNode[] = [];
  const you: ReactNode[] = [];
  const column = INTAKE_COLUMNS.find(([k]) => k === (intake.status ?? 'todo'))?.[1] ?? intake.status ?? 'To Do';
  const since = dateText(intake.since);
  const deciding = !!manager.on && !!pm;
  const risk = manager.maxRisk ?? 'medium';
  const limit = manager.perHourLimit ?? 20;
  const cap = ops.ticketTokenCap ?? 0;

  if (intake.on)
    own.push(
      <>
        Takes each new ticket that lands in <b>{column}</b> with nobody assigned{since ? `, since ${since}` : ''}, and{' '}
        {workflowName ? 'lets Triage choose its workflow' : 'hands it straight to one AI'}.
      </>,
    );
  if (deciding) {
    const grace = manager.graceMin ?? 0;
    own.push(
      <>
        {pm} tries a failed step again, splits a ticket that is several pieces, and answers the questions and permission
        requests nobody picked up{grace > 0 ? ` after ${grace} minute${grace === 1 ? '' : 's'}` : ''}.
      </>,
    );
  }
  if (ops.autonomy?.approve === 'pm' && pm)
    own.push(<>{pm} approves the design step itself, then reads the hand-in like a design lead.</>);
  if (ops.autonomy?.done === 'after_review')
    own.push(
      <>
        Moves a ticket to <b>Done</b> once the checks, test-first and the review all passed, which merges the branch.
      </>,
    );
  if (own.length === 0) own.push(<>Nothing: a ticket waits until you give it to someone.</>);

  if (!intake.on) you.push(<>Starting a new ticket: nothing is taken until you give it to someone.</>);
  if (!deciding)
    you.push(
      manager.on ? (
        <>Every failed step, question and permission request: there is no PM to take them.</>
      ) : (
        <>Every failed step, question and permission request nobody picked up.</>
      ),
    );
  else if (risk === 'low')
    you.push(
      <>
        Anything of <b>Medium</b> or <b>High</b> risk, for example changing a status or deleting a ticket.
      </>,
    );
  else if (risk === 'medium')
    you.push(
      <>
        Anything of <b>High</b> risk, for example deleting a ticket.
      </>,
    );
  you.push(<>Raising the budget, a request of the PM’s own, managing members: never an AI’s call.</>);
  if (ops.autonomy?.approve !== 'pm' || !pm) you.push(<>Approving the design before anyone builds it.</>);
  if (ops.autonomy?.done !== 'after_review')
    you.push(
      <>
        Moving a ticket to <b>Done</b>, which merges the branch.
      </>,
    );
  const limits = [
    cap > 0 ? `any ticket that has used ${cap.toLocaleString('en-US')} tokens` : null,
    deciding ? `the ${ordinal(limit + 1)} decision in an hour` : null,
  ].filter(Boolean) as string[];
  if (limits.length) {
    const text = limits.join(', and ');
    you.push(<>{text[0].toUpperCase() + text.slice(1)}.</>);
  }
  return { own, you };
}

/** Make a member from the PM pack (the role pack library's own dialog). */
function AddPm({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const packs = usePacks(projectId);
  const pm = packs.data?.find((p) => p.key === 'pm');
  if (pm) return <MakeMemberModal projectId={projectId} pack={pm} onClose={onClose} onDone={onClose} />;
  return (
    <Dialog
      title="Add a PM"
      onClose={onClose}
      foot={
        <button type="button" className="ai-btn" onClick={onClose}>
          Close
        </button>
      }
    >
      {packs.isLoading ? (
        <div className="ai-skel" style={{ height: 40 }} aria-busy="true" aria-label="Loading packs" />
      ) : (
        <div className="ai-notice ai-notice-error" role="alert">
          {packs.error ? `Couldn't load the role packs: ${extractError(packs.error)}.` : 'There is no PM pack.'}
        </div>
      )}
    </Dialog>
  );
}

/** "Let the PM decide for you?": what turning on The PM runs the team hands over (Autopilot asks the same). */
function ConfirmPm({
  pm,
  risk,
  limit,
  onCancel,
  onConfirm,
}: {
  pm: string;
  risk: Risk;
  limit: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [agree, setAgree] = useState(false);
  return (
    <Dialog
      title="Let the PM decide for you?"
      sub="Turning on The PM runs the team makes it this project’s Autopilot delegate."
      width={460}
      testId="ops-manager-confirm"
      onClose={onCancel}
      foot={
        <>
          <button type="button" className="ai-btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="ai-btn ai-btn-primary"
            disabled={!agree}
            data-testid="ops-manager-confirm-on"
            onClick={onConfirm}
          >
            <Ico name="tick" />
            Turn on
          </button>
        </>
      }
    >
      <div style={{ fontSize: 13, lineHeight: 1.55 }}>
        {pm} will decide, in your place, the questions and permission requests that nobody picked up,{' '}
        {risk === 'high' ? (
          <>
            at <b>any</b> risk
          </>
        ) : (
          <>
            up to <b>{RISK_WORD[risk]}</b> risk
          </>
        )}
        , at most <b>{limit} an hour</b>. Everything it decides is in the audit log, marked{' '}
        <span className="to-code">Autopilot</span>, and in <b>Decided for you</b>, where each one can be overridden.
      </div>
      <div className="to-box to-box-warn">
        <Ico name="warn" />
        <div>
          {pm} reads what other AIs write to decide. A request could be worded to steer it.{' '}
          {risk === 'high'
            ? 'It never touches the budget, but at Everything it may delete a ticket.'
            : `That is why it stops at ${RISK_WORD[risk]} and never touches the budget.`}
        </div>
      </div>
      <label className="to-check">
        <input
          type="checkbox"
          checked={agree}
          data-testid="ops-manager-agree"
          onChange={(e) => setAgree(e.target.checked)}
        />
        <span>I understand what the PM may decide for me</span>
      </label>
    </Dialog>
  );
}

/** What the three risk tiers mean, and what is never the PM's call. */
function RiskTiers() {
  return (
    <div className="to-tiers" data-testid="ops-risk-tiers">
      <div>
        {TIERS.map((t) => (
          <div key={t.risk} className="to-tier">
            <span className="to-tier-chip" style={{ background: t.bg, color: t.fg }}>
              {RISK_WORD[t.risk]}
            </span>
            <div>
              <div>{t.does}</div>
              <div className="ai-hint" style={{ fontSize: 11.5 }}>
                {t.why}
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="to-box to-box-warn" data-testid="ops-never-pm">
        <Ico name="lock" />
        <div>
          <b>Never the PM’s call, whatever the ceiling:</b> raising the budget, its own requests, and anything while
          Safe mode is on. Managing the project and its members is for people only.
        </div>
      </div>
      <div className="ai-hint" style={{ fontSize: 11.5 }}>
        Each action’s tier is the one in Members › Permissions.
      </div>
    </div>
  );
}

/**
 * Team on its own (design/screens/ai-story-flow.md, L): how far the project's AI team goes before it asks a person,
 * grouped by what each setting decides, with a plain account of what the setup means.
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
  const autopilot = useAutopilot(projectId);
  const me = useAiMe(projectId);
  const [confirming, setConfirming] = useState(false);
  const [addingPm, setAddingPm] = useState(false);
  const members = (overview.data?.members ?? []).filter((m) => m.kind === 'ai');
  const withRole = (role: string) => members.filter((m) => roleOfConfig(m.config) === role);
  const intake = ops.intake ?? {};
  const manager = ops.manager ?? {};
  const triage = withRole('triage');
  const pms = withRole('pm');
  const pm = pms.find((m) => m.id === ops.coordinatorId) ?? pms[0] ?? null;
  const noPm = !!overview.data && pms.length === 0;
  const risk = manager.maxRisk ?? 'medium';
  const limit = manager.perHourLimit ?? 20;
  // only the project owner may hand decisions over; while the role is unknown the server is the judge
  const notOwner = !!me.data && me.data.role !== 'owner';
  const workflowName = (templates.data ?? []).find((t) => t.key === ops.workflowDefault)?.name ?? null;
  const meaning = setupMeaning(
    ops,
    pm?.name ?? null,
    ops.workflowDefault ? (workflowName ?? ops.workflowDefault) : null,
  );
  const used = autopilot.data?.enabled ? autopilot.data.usedLastHour : null;

  const state = manager.on
    ? pm
      ? { cls: 'to-state-on', icon: 'check' as const, text: `On · ${pm.name} decides` }
      : { cls: 'to-state-warn', icon: 'warn' as const, text: 'On · no PM' }
    : intake.on
      ? { cls: 'to-state-on', icon: 'check' as const, text: 'On · taking new tickets' }
      : { cls: '', icon: 'info' as const, text: 'Off' };

  return (
    <section className="to-sec" data-testid="team-own">
      <div className="to-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="to-title" data-testid="ops-own-heading">
            Team on its own
          </div>
          <div className="ai-hint" style={{ marginTop: 3 }}>
            How far this project’s AI team goes before it asks a person. Changes take effect on the next run.
          </div>
        </div>
        <span className={`to-state ${state.cls}`} data-testid="ops-own-state">
          <Ico name={state.icon} size={13} />
          {state.text}
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="ops-meaning">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          <b style={{ fontSize: 13 }}>What this setup means</b>
          <span className="ai-hint">Written from the settings below, so it cannot disagree with them.</span>
        </div>
        <div className="to-means">
          <div className="to-means-col to-means-own" data-testid="ops-meaning-own">
            <div className="to-h" style={{ color: '#1F5A31' }}>
              The team does by itself
            </div>
            <ul>
              {meaning.own.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          </div>
          <div className="to-means-col to-means-you" data-testid="ops-meaning-you">
            <div className="to-h" style={{ color: '#7A5A06' }}>
              Still comes to you
            </div>
            <ul>
              {meaning.you.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      <div className="to-group" data-testid="ops-group-intake">
        <GroupHead title="Taking work in" hint="Which tickets the team starts without being told." />
        <TeamRow
          title="New tickets are taken by the team"
          hint={`Only tickets that arrive after you turn it on, in the column below and assigned to nobody.${
            intake.on && dateText(intake.since) ? ` Since ${dateText(intake.since)}.` : ''
          }`}
        >
          <Toggle
            on={!!intake.on}
            label="New tickets are taken by the team"
            testId="ops-intake"
            disabled={busy}
            onChange={(v) => save({ intake: { on: v } })}
          />
        </TeamRow>
        {intake.on && (
          <TeamRow
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
          </TeamRow>
        )}
        <TeamRow
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
        </TeamRow>
        <TeamRow title="Triage" hint="The member that reads new tickets. Any Triage when none is chosen.">
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
        </TeamRow>
      </div>

      <div className="to-rule" />

      <div className="to-group" data-testid="ops-group-decides">
        <GroupHead
          title="Who decides"
          hint="Turning on The PM runs the team makes the PM this project’s Autopilot delegate, so the numbers below are Autopilot’s too."
        />
        <TeamRow
          title="The PM runs the team"
          hint={`A step that failed twice, AI questions and permission requests nobody picked up, and tickets Triage says are several pieces go to the PM before you.${
            notOwner ? ' Only the project owner can change it.' : ''
          }`}
        >
          <Toggle
            on={!!manager.on}
            label="The PM runs the team"
            testId="ops-manager"
            disabled={busy || notOwner || overview.isLoading}
            onChange={(v) => {
              if (v && pm) setConfirming(true);
              else save({ manager: { on: v } });
            }}
          />
        </TeamRow>
        {!intake.on && !manager.on && (
          <div className="to-box to-box-plain" data-testid="ops-off-note">
            <Ico name="info" />
            <div>
              Nothing is taken and nobody decides for you. Every failed step, question and request waits for you.
            </div>
          </div>
        )}
        <TeamRow title="The PM" hint="Arbitrates and runs the team. The first PM when none is chosen.">
          <select
            className="ai-select"
            aria-label="The PM"
            data-testid="ops-coordinator"
            value={noPm ? '' : (ops.coordinatorId ?? '')}
            disabled={busy || noPm}
            onChange={(e) => save({ coordinatorId: e.target.value || null })}
          >
            <option value="">{noPm ? 'No PM in this project' : 'The first PM'}</option>
            {pms.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </TeamRow>
        {manager.on && noPm && (
          <>
            <div className="to-box to-box-warn" role="note" data-testid="ops-no-pm">
              <Ico name="warn" />
              <div>
                <b>There is no PM to run it.</b> Autopilot is not set up and every decision still comes to you. Add a PM
                from the role pack.
              </div>
            </div>
            <div>
              <button
                type="button"
                className="ai-btn ai-btn-primary ai-btn-sm"
                data-testid="ops-add-pm"
                onClick={() => setAddingPm(true)}
              >
                <Ico name="plus" />
                Add a PM
              </button>
            </div>
          </>
        )}
        <TeamRow title="Who approves the design" hint="The step that waits for a person before the last one.">
          <span className="to-seg" role="group" aria-label="Who approves the design" data-testid="ops-approve">
            {(
              [
                ['person', 'You'],
                ['pm', 'The PM'],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                aria-pressed={(ops.autonomy?.approve ?? 'person') === k}
                disabled={busy || (k === 'pm' && noPm)}
                title={k === 'pm' && noPm ? 'There is no PM in this project.' : undefined}
                data-testid={`ops-approve-${k}`}
                onClick={() => (ops.autonomy?.approve ?? 'person') !== k && save({ autonomy: { approve: k } })}
              >
                {label}
              </button>
            ))}
          </span>
        </TeamRow>
        {manager.on && (
          <>
            <TeamRow
              title="Waits for you first"
              hint="How long a question or a request stays with you before the PM takes it. 0 means at once."
            >
              <NumberSetting
                value={manager.graceMin ?? 0}
                min={0}
                label="Minutes before the PM takes over"
                testId="ops-manager-grace"
                disabled={busy}
                onSave={(n) => save({ manager: { graceMin: n } })}
              />
              <span className="ai-hint">minutes</span>
            </TeamRow>
            <TeamRow
              title="Highest risk the PM decides"
              hint="Anything above it still goes to you. The three tiers are explained below."
            >
              <div className="to-opts" role="group" aria-label="Highest risk the PM decides">
                {RISKS.map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    className="to-opt"
                    aria-pressed={risk === k}
                    disabled={busy}
                    data-testid={`ops-manager-risk-${k}`}
                    onClick={() => risk !== k && save({ manager: { maxRisk: k } })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </TeamRow>
            <TeamRow
              title="Decisions an hour"
              hint={
                <>
                  After this many the PM stops deciding and asks you.
                  {used != null && (
                    <>
                      {' '}
                      <b style={{ color: '#1E2A22' }} data-testid="ops-manager-used">
                        {used} of {limit} used this hour.
                      </b>
                    </>
                  )}
                </>
              }
            >
              <NumberSetting
                value={limit}
                min={1}
                label="Decisions the PM may take in an hour"
                testId="ops-manager-limit"
                disabled={busy}
                onSave={(n) => save({ manager: { perHourLimit: n } })}
              />
            </TeamRow>
            <div className="to-h" style={{ paddingTop: 4 }}>
              What the three risk tiers mean
            </div>
            <RiskTiers />
          </>
        )}
      </div>

      <div className="to-rule" />

      <div className="to-group" data-testid="ops-group-done">
        <GroupHead
          title="Before it is done"
          hint="What a ticket must show, and how much it may cost, before the team stops."
        />
        <TeamRow
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
            <option value="after_review">The board moves it once everything passed</option>
          </select>
        </TeamRow>
        {ops.autonomy?.done === 'after_review' && (
          <div className="ai-notice ai-notice-warn" role="note" data-testid="ops-done-warning">
            Done merges. With this on, a ticket that passed everything is merged without you.
          </div>
        )}
        <TeamRow
          title="Test first"
          hint="A Dev step needs a failing test run before the passing one. Without it the step waits for you."
        >
          <Toggle
            on={ops.tdd?.required ?? true}
            label="A Dev step needs a failing test run before the passing one"
            testId="ops-tdd"
            disabled={busy}
            onChange={(v) => save({ tdd: { required: v } })}
          />
        </TeamRow>
        <TeamRow
          title="Tokens one ticket may use"
          hint="Its workflow stops for you when the ticket's runs add up to this. 0 is no cap. A Story has its own limit."
        >
          <NumberSetting
            value={ops.ticketTokenCap ?? 0}
            min={0}
            width={110}
            label="Tokens one ticket may use, 0 for no cap"
            testId="ops-token-cap"
            disabled={busy}
            onSave={(n) => save({ ticketTokenCap: n })}
          />
          <span className="ai-hint">tokens</span>
        </TeamRow>
      </div>

      {confirming && pm && (
        <ConfirmPm
          pm={pm.name}
          risk={risk}
          limit={limit}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            save({ manager: { on: true } });
          }}
        />
      )}
      {addingPm && <AddPm projectId={projectId} onClose={() => setAddingPm(false)} />}
    </section>
  );
}
