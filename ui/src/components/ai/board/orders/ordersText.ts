import type { Order, OrderTemplates, Rule, SignalKind } from '../../../../types/aiOrders';

/** What each signal says in the rule's own words (design/screens/ai-board-wave3.md, F and G). */
export const SIGNAL_LABEL: Record<SignalKind, string> = {
  ai_hang: 'An AI produces no output for N minutes',
  ai_failing: 'An AI’s last three runs failed',
  quota_near: 'An account is near its window',
  needs_queue: 'Needs you is long',
  arbitration_wait: 'An arbitration waits',
  run_failed_network: 'A run failed on the network or a 5xx',
  review_stale: 'A ticket has sat in Review for 24 hours',
  ci_red: 'CI failed on a pull request the board opened',
};

/** "When it looks" column: the signal with its number filled in. */
export function whenLooks(rule: Rule): string {
  if (!rule.when) return '—';
  const base = SIGNAL_LABEL[rule.when] ?? rule.when;
  if (rule.when === 'ai_hang') return base.replace('N', String(rule.if.minMinutes ?? 30));
  return base;
}

/** The actions (by their snake_case key) a fixed rule may do for a signal. */
export function actionsFor(templates: OrderTemplates | undefined, when: Rule['when']) {
  if (!templates || !when) return [];
  return Object.entries(templates.actions)
    .map(([k, v]) => ({ key: snake(k), label: v.label, signals: v.signals }))
    .filter((a) => a.key !== 'diagnose' && a.signals.includes(when));
}

function snake(s: string): string {
  return s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/** The label of an action key, whichever way the client spelled the map. */
export function actionLabel(templates: OrderTemplates | undefined, key: string): string {
  if (!templates) return key;
  const hit = Object.entries(templates.actions).find(([k]) => snake(k) === key || k === key);
  return hit ? hit[1].label : key;
}

/** A rule as a short name when the person gives none: "A run failed on the network → try once more". */
export function defaultName(rule: Rule, templates: OrderTemplates | undefined): string {
  if (!rule.when) return '';
  const signal = (SIGNAL_LABEL[rule.when] ?? rule.when).replace(' for N minutes', '');
  const act =
    rule.then.mode === 'diagnose' ? 'diagnose and act' : actionLabel(templates, rule.then.action).toLowerCase();
  return `${signal} → ${act}`;
}

/** A blank rule for "pick one in the editor". */
export function emptyRule(): Rule {
  return {
    when: '',
    if: {},
    then: { mode: 'fixed', action: '' },
    afterwards: { lesson: false },
    maxPerDay: 3,
    maxPerTarget: 1,
    onlyProject: true,
  };
}

const DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');

/** "Today 09:14", "Yesterday 15:40", "Mon 16:08", "Oct 20 16:08". */
export function dayTime(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const days = Math.round((new Date(now).setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / DAY);
  if (days <= 0) return `Today ${hm}`;
  if (days === 1) return `Yesterday ${hm}`;
  if (days < 7) return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${hm}`;
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${hm}`;
}

/** "Trial · 2 of 3 days". */
export function trialProgress(o: Order, now = Date.now()): string {
  const started = o.trialStartedAt ? new Date(o.trialStartedAt).getTime() : now;
  const day = Math.min(o.trialDays, Math.max(1, Math.floor((now - started) / DAY) + 1));
  return `Trial · ${day} of ${o.trialDays} days`;
}

/** Why Turn it on is off. */
export const NOT_FIRED_YET = 'The trial has not fired yet';
