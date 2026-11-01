import { useState } from 'react';
import { useCreateOrder, usePatchOrder } from '../../../../api/aiOrders';
import { extractError } from '../../../../api/extractError';
import type { Order, OrderTemplates, Rule, SignalKind } from '../../../../types/aiOrders';
import { actionsFor, defaultName, NOT_FIRED_YET, SIGNAL_LABEL } from './ordersText';
import './orders.css';

export interface EditorSeed {
  name: string;
  sentence: string;
  rule: Rule;
  template: string | null;
  /** Said above the form: why it opened empty, for instance. */
  notice?: string;
}

const TRIAL_CHOICES = [1, 3, 7, 14];

/** The server's key for what a rule does; named once so no object literal here carries a member called `then`. */
const THEN = 'then';

/** The rule with another action; written to the wire as `then`. */
const withAction = (r: Rule, action: Rule['then']): Rule => ({ ...r, [THEN]: action });

/** "What I understood — change anything": the rule as lines a person can read and change before it is saved. */
export function RuleEditor({
  projectId,
  templates,
  seed,
  existing,
  onClose,
}: {
  projectId: string;
  templates: OrderTemplates | undefined;
  seed: EditorSeed;
  /** Set when an existing rule is being changed rather than a new one written. */
  existing?: Order;
  onClose: () => void;
}) {
  const [rule, setRule] = useState<Rule>(seed.rule);
  const [name, setName] = useState(seed.name || existing?.name || '');
  const [trialDays, setTrialDays] = useState(existing?.trialDays ?? 3);
  const [error, setError] = useState<string | null>(null);
  const create = useCreateOrder(projectId);
  const patch = usePatchOrder(projectId);
  const busy = create.isPending || patch.isPending;

  const signals = templates?.signals ?? (Object.keys(SIGNAL_LABEL) as SignalKind[]);
  const fixed = actionsFor(templates, rule.when);
  const isDiagnose = rule.then.mode === 'diagnose';
  const action = rule.then.mode === 'fixed' ? rule.then.action : '';
  const complete = !!rule.when && (isDiagnose || (!!action && fixed.some((a) => a.key === action)));

  const setWhen = (when: SignalKind | '') => {
    const next = actionsFor(templates, when);
    setRule((r) => {
      const cur = r.then.mode === 'fixed' ? r.then.action : '';
      const keep = r.then.mode === 'fixed' && next.some((a) => a.key === cur);
      let action = r.then;
      if (r.then.mode === 'diagnose' && when !== 'ai_hang') action = { mode: 'fixed', action: next[0]?.key ?? '' };
      else if (r.then.mode === 'fixed' && !keep) action = { mode: 'fixed', action: next[0]?.key ?? '' };
      return withAction({ ...r, when }, action);
    });
  };
  const setIf = (patchIf: Partial<Rule['if']>) => setRule((r) => ({ ...r, if: { ...r.if, ...patchIf } }));
  const num = (v: string, min: number, max: number, fallback: number) => {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
  };

  const save = () => {
    setError(null);
    const finalName = name.trim() || defaultName(rule, templates);
    if (existing) {
      patch.mutate(
        { id: existing.id, body: { rule, name: finalName, trialDays } },
        { onSuccess: onClose, onError: (e) => setError(extractError(e)) },
      );
      return;
    }
    create.mutate(
      {
        draft: { name: finalName, sentence: seed.sentence || finalName, rule, template: seed.template },
        trialDays,
      },
      { onSuccess: onClose, onError: (e) => setError(extractError(e)) },
    );
  };

  const canLive = !!existing && existing.state === 'trial' && existing.canGoLive;

  return (
    <div className="so-editor" data-testid="rule-editor">
      <div className="so-editor-title">
        <b>What I understood — change anything</b>
        <span className="ai-chip" style={{ background: '#F1F3F1', color: '#5B6B60' }}>
          {existing ? 'Saved' : 'Not saved yet'}
        </span>
      </div>
      {seed.notice && (
        <div className="ai-notice ai-notice-warn" role="status" data-testid="editor-notice">
          {seed.notice}
        </div>
      )}

      <div className="so-field">
        <label className="so-lab" htmlFor="so-name">
          Name
        </label>
        <input
          id="so-name"
          className="ai-input"
          value={name}
          placeholder={defaultName(rule, templates) || 'Name this rule'}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className="so-field">
        <label className="so-lab" htmlFor="so-when">
          When
        </label>
        <select
          id="so-when"
          className="ai-select"
          value={rule.when}
          onChange={(e) => setWhen(e.target.value as SignalKind | '')}
        >
          <option value="">Pick a signal…</option>
          {signals.map((s) => (
            <option key={s} value={s}>
              {SIGNAL_LABEL[s] ?? s}
            </option>
          ))}
        </select>
        <div className="so-hint">A signal the board already computes.</div>
      </div>

      <div className="so-field">
        <div className="so-lab">Only if</div>
        {rule.when === 'ai_hang' && (
          <div className="so-inline">
            <span className="so-hint" style={{ fontSize: 12 }}>
              No output for at least
            </span>
            <input
              className="ai-input so-num"
              type="number"
              min={1}
              aria-label="Minutes without output"
              value={rule.if.minMinutes ?? 30}
              onChange={(e) => setIf({ minMinutes: num(e.target.value, 1, 1440, 30) })}
            />
            <span className="so-hint" style={{ fontSize: 12 }}>
              minutes
            </span>
          </div>
        )}
        {isDiagnose && (
          <label className="so-check">
            <input
              type="checkbox"
              checked={!!rule.if.confident}
              onChange={(e) => setIf({ confident: e.target.checked })}
            />
            <span>
              The diagnosis is confident
              <div className="so-hint">Not “unknown”. An unknown cause goes to Needs you instead.</div>
            </span>
          </label>
        )}
        <label className="so-check">
          <input type="checkbox" checked disabled readOnly />
          <span>
            The fix is in the middle tier
            <div className="so-hint">
              Stopping one child process, sending the AI a note, or stopping and continuing with a note. Never a blind
              restart.
            </div>
          </span>
        </label>
        <label className="so-check">
          <input
            type="checkbox"
            checked={rule.onlyProject}
            onChange={(e) => setRule((r) => ({ ...r, onlyProject: e.target.checked }))}
          />
          <span>
            Only on this project
            <div className="so-hint">Off: it applies everywhere.</div>
          </span>
        </label>
      </div>

      <div className="so-field">
        <div className="so-lab">Then</div>
        <label className={`so-opt${isDiagnose ? ' so-opt-on' : ''}`} htmlFor="so-then-diagnose">
          <input
            id="so-then-diagnose"
            type="radio"
            name="so-then"
            checked={isDiagnose}
            disabled={rule.when !== '' && rule.when !== 'ai_hang'}
            onChange={() =>
              setRule((r) => ({ ...withAction(r, { mode: 'diagnose' }), if: { ...r.if, confident: true } }))
            }
          />
          <span>
            <b>Let the AI analyse, then decide</b>
            <span className="so-hint">
              {' '}
              It picks from the actions the diagnosis allows: wait longer · stop the stuck child process · send the AI a
              note · stop and continue with a note · hand it to Needs you.
              {rule.when !== '' && rule.when !== 'ai_hang' && ' Only a hang has a diagnosis to act on.'}
            </span>
          </span>
        </label>
        <label className={`so-opt${!isDiagnose ? ' so-opt-on' : ''}`} htmlFor="so-then-fixed">
          <input
            id="so-then-fixed"
            type="radio"
            name="so-then"
            checked={!isDiagnose}
            onChange={() => setRule((r) => withAction(r, { mode: 'fixed', action: fixed[0]?.key ?? '' }))}
          />
          <span style={{ flex: 1 }}>
            <b>Always do one thing</b>
            <span className="so-hint">
              {' '}
              A fixed action, chosen here. Use it when you already know what this project does.
            </span>
            {!isDiagnose && (
              <select
                className="ai-select"
                style={{ marginTop: 6 }}
                aria-label="Action"
                value={action}
                onChange={(e) => setRule((r) => withAction(r, { mode: 'fixed', action: e.target.value }))}
              >
                {!rule.when && <option value="">Pick a signal first</option>}
                {fixed.map((a) => (
                  <option key={a.key} value={a.key}>
                    {a.label}
                  </option>
                ))}
              </select>
            )}
          </span>
        </label>
        <div className="so-hint">
          Every rule has the same shape: notice → diagnose → act. A rule with no diagnosis step is one whose signal
          already names the cause.
        </div>
      </div>

      <div className="so-field">
        <div className="so-lab">Afterwards</div>
        <label className="so-check">
          <input
            type="checkbox"
            checked={rule.afterwards.lesson}
            onChange={(e) => setRule((r) => ({ ...r, afterwards: { lesson: e.target.checked } }))}
          />
          <span>
            Write what it learned into the project memory
            <div className="so-hint">
              A cause this project will meet again becomes a lesson you can edit. Nothing is added without you keeping
              it.
            </div>
          </span>
        </label>
      </div>

      <div className="so-field">
        <div className="so-lab">At most</div>
        <div className="so-inline">
          <input
            className="ai-input so-num"
            type="number"
            min={1}
            max={50}
            aria-label="Times a day"
            value={rule.maxPerDay}
            onChange={(e) => setRule((r) => ({ ...r, maxPerDay: num(e.target.value, 1, 50, 3) }))}
          />
          <span className="so-hint" style={{ fontSize: 12 }}>
            times a day, and
          </span>
          <input
            className="ai-input so-num"
            type="number"
            min={1}
            max={10}
            aria-label="Times per target"
            value={rule.maxPerTarget}
            onChange={(e) => setRule((r) => ({ ...r, maxPerTarget: num(e.target.value, 1, 10, 1) }))}
          />
          <span className="so-hint" style={{ fontSize: 12 }}>
            time per run
          </span>
        </div>
        <div className="so-hint">Past that it stops firing and tells you, rather than looping.</div>
      </div>

      <div className="so-field">
        <label className="so-lab" htmlFor="so-trial">
          Trial first
        </label>
        <div className="so-inline">
          <select
            id="so-trial"
            className="ai-select"
            style={{ width: 150 }}
            value={trialDays}
            onChange={(e) => setTrialDays(Number.parseInt(e.target.value, 10))}
          >
            {TRIAL_CHOICES.map((d) => (
              <option key={d} value={d}>
                For {d} {d === 1 ? 'day' : 'days'}
              </option>
            ))}
          </select>
          <span className="so-hint" style={{ fontSize: 12 }}>
            it writes down what it would have done, and does nothing
          </span>
        </div>
      </div>

      {error && (
        <div className="ai-notice ai-notice-error" role="alert" data-testid="editor-error">
          {error}
        </div>
      )}

      <div className="so-actions">
        <button
          type="button"
          className="ai-btn ai-btn-primary ai-btn-sm"
          disabled={!complete || busy}
          onClick={save}
          data-testid="start-trial"
        >
          {busy && <span className="ai-spin" />}
          {existing ? 'Save changes' : 'Start the trial'}
        </button>
        <button
          type="button"
          className="ai-btn ai-btn-sm"
          disabled={!canLive || busy}
          title={canLive ? undefined : NOT_FIRED_YET}
          onClick={() =>
            patch.mutate(
              { id: existing!.id, body: { state: 'on' } },
              { onSuccess: onClose, onError: (e) => setError(extractError(e)) },
            )
          }
          data-testid="turn-on-now"
        >
          Turn it on now
        </button>
        <button type="button" className="ai-btn ai-btn-sm" style={{ borderColor: 'transparent' }} onClick={onClose}>
          Cancel
        </button>
      </div>
      <div className="so-hint" style={{ lineHeight: 1.55 }}>
        <b>Turn it on now is off until the trial has run.</b> A new rule goes live only after its trial has fired at
        least once, or run for a day with nothing to fire on — whichever comes first. Until then the button says{' '}
        <i>the trial has not fired yet</i>. A rule you have not watched is a rule you do not know, and the plan says the
        trial comes first.
      </div>
    </div>
  );
}
