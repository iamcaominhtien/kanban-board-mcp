import { useState } from 'react';
import { useOrders, useOrderTemplates, useParseSentence, usePatchOrder, useTick } from '../../../api/aiOrders';
import { useAiBoard } from '../../../api/ai';
import { extractError } from '../../../api/extractError';
import type { Order, OrderTemplate } from '../../../types/aiOrders';
import { LoadError } from '../aiUi';
import { FiringsPanel } from './orders/FiringsPanel';
import { RuleEditor, type EditorSeed } from './orders/RuleEditor';
import { dayTime, defaultName, emptyRule, trialProgress, whenLooks } from './orders/ordersText';
import './orders/orders.css';

type Open =
  | { kind: 'words' }
  | { kind: 'editor'; seed: EditorSeed; existing?: Order }
  | { kind: 'history'; id: string }
  | { kind: 'all' }
  | null;

const STEPS: [string, string, string][] = [
  [
    'so-step-words',
    '1 · You write it in words',
    'A sentence in the Board AI chat: “if an AI hangs for more than half an hour, diagnose it and fix it if you can”.',
  ],
  [
    '',
    '2 · It becomes a rule you can read',
    'When, if, do what, at most how often. You change any part of it before it is saved.',
  ],
  [
    'so-step-trial',
    '3 · It runs in trial mode',
    'For a time you choose, it only writes down what it would have done. Nothing happens.',
  ],
  ['', '4 · You turn it on', 'After reading the trial. Every firing is recorded and can be undone.'],
];

/** Standing orders (design/screens/ai-board-wave3.md, G and H): a rule in your words, tried before it does anything. */
export function StandingOrdersSection({ projectId }: { projectId: string }) {
  const orders = useOrders(projectId);
  const templates = useOrderTemplates();
  const board = useAiBoard(projectId);
  const parse = useParseSentence(projectId);
  const patch = usePatchOrder(projectId);
  const tick = useTick(projectId);
  const [open, setOpen] = useState<Open>(null);
  const [sentence, setSentence] = useState('');
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const settings = board.data?.settings;
  const paused = !!settings?.pausedAll;
  const aiOff = settings ? !settings.aiEnabled : false;
  const list = orders.data ?? [];

  const fromTemplate = (t: OrderTemplate) =>
    setOpen({
      kind: 'editor',
      seed: { name: t.name, sentence: t.sentence, rule: structuredClone(t.rule), template: t.key },
    });

  const understand = () => {
    const text = sentence.trim();
    if (!text) return;
    parse.mutate(text, {
      onSuccess: (rule) =>
        setOpen({
          kind: 'editor',
          seed: { name: defaultName(rule, templates.data), sentence: text, rule, template: null },
        }),
      onError: (e) =>
        setOpen({
          kind: 'editor',
          seed: { name: '', sentence: text, rule: emptyRule(), template: null, notice: extractError(e) },
        }),
    });
  };

  const setState = (o: Order, state: Order['state']) => {
    setNote(null);
    patch.mutate({ id: o.id, body: { state } }, { onError: (e) => setNote({ ok: false, text: extractError(e) }) });
  };

  const editOf = (o: Order) =>
    setOpen({
      kind: 'editor',
      existing: o,
      seed: { name: o.name, sentence: o.sentence, rule: structuredClone(o.rule), template: o.template },
    });

  const current = open?.kind === 'history' ? list.find((o) => o.id === open.id) : undefined;

  return (
    <div className="so-root" data-testid="standing-orders-section" data-project={projectId}>
      <div className="so-head">
        <h2 className="so-h1">Standing orders</h2>
        <span className="ai-chip" style={{ background: '#E6F2EA', color: '#1F5A31' }}>
          This project
        </span>
        <span className="so-spacer" />
        <button
          type="button"
          className="ai-btn ai-btn-primary ai-btn-sm"
          onClick={() => {
            setNote(null);
            setOpen({ kind: 'words' });
          }}
        >
          New rule
        </button>
        <button
          type="button"
          className="ai-btn ai-btn-sm"
          onClick={() => setOpen(open?.kind === 'all' ? null : { kind: 'all' })}
        >
          Everything they did
        </button>
        <button
          type="button"
          className="ai-btn ai-btn-sm"
          disabled={tick.isPending || paused || aiOff}
          title="Look at the signals now instead of waiting"
          onClick={() => {
            setNote(null);
            tick.mutate(undefined, {
              onSuccess: (r) =>
                setNote({
                  ok: true,
                  text: r.fired.length
                    ? `Looked now: ${r.fired.length} rule${r.fired.length === 1 ? '' : 's'} fired.`
                    : 'Looked now: nothing to fire on.',
                }),
              onError: (e) => setNote({ ok: false, text: extractError(e) }),
            });
          }}
        >
          Look now
        </button>
      </div>
      <div className="ai-hint" style={{ maxWidth: 980, fontSize: 12.5, lineHeight: 1.55 }}>
        Rules only ever do things that can be undone. Every firing is recorded with what it changed and a button to put
        it back.
      </div>
      {(paused || aiOff) && (
        <div className="ai-notice ai-notice-warn" role="status" data-testid="orders-paused">
          {aiOff
            ? 'The Board AI is off, so every rule is paused and nothing is half-running.'
            : 'Pause all AI is on, so every rule is paused with everything else.'}
        </div>
      )}
      {note && (
        <div
          className={`ai-notice ${note.ok ? 'ai-notice-info' : 'ai-notice-error'}`}
          role={note.ok ? 'status' : 'alert'}
        >
          {note.text}
        </div>
      )}

      {open?.kind === 'words' && (
        <div className="so-editor" style={{ background: '#fff' }} data-testid="words-step">
          <div className="so-steps">
            {STEPS.map(([cls, title, text]) => (
              <div key={title} className={`so-step ${cls}`}>
                <b>{title}</b>
                <p>{text}</p>
              </div>
            ))}
          </div>
          <div className="so-field">
            <label className="so-lab" htmlFor="so-sentence">
              Say it in a sentence
            </label>
            <textarea
              id="so-sentence"
              className="ai-textarea"
              rows={2}
              value={sentence}
              placeholder="If an AI hangs for more than half an hour, diagnose it and fix it if you can."
              onChange={(e) => setSentence(e.target.value)}
            />
          </div>
          <div className="so-actions">
            <button
              type="button"
              className="ai-btn ai-btn-primary ai-btn-sm"
              disabled={!sentence.trim() || parse.isPending}
              onClick={understand}
            >
              {parse.isPending && <span className="ai-spin" />}
              Read it as a rule
            </button>
            <button
              type="button"
              className="ai-btn ai-btn-sm"
              onClick={() =>
                setOpen({ kind: 'editor', seed: { name: '', sentence: '', rule: emptyRule(), template: null } })
              }
            >
              Set it up by hand
            </button>
            <button
              type="button"
              className="ai-btn ai-btn-sm"
              style={{ borderColor: 'transparent' }}
              onClick={() => setOpen(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {open?.kind === 'editor' && (
        <RuleEditor
          key={open.existing?.id ?? open.seed.template ?? open.seed.sentence}
          projectId={projectId}
          templates={templates.data}
          seed={open.seed}
          existing={open.existing}
          onClose={() => setOpen(null)}
        />
      )}

      <div className="so-grid so-gridhead">
        {['Rule', 'When it looks', 'State', 'Fired', 'Last time', ''].map((h, i) => (
          <div key={i} className="ai-label">
            {h}
          </div>
        ))}
      </div>
      {orders.isLoading ? (
        <div className="ai-skel" style={{ height: 120 }} aria-busy="true" aria-label="Loading" />
      ) : orders.error ? (
        <LoadError what="the rules" error={orders.error} onRetry={() => void orders.refetch()} />
      ) : list.length === 0 ? (
        <div className="ai-notice ai-notice-slate" data-testid="orders-empty">
          No rules yet. Write one in a sentence with New rule, or start from one of the ready-made rules below.
        </div>
      ) : (
        <div className="so-rows" data-testid="orders-list">
          {list.map((o) => {
            const trial = o.state === 'trial';
            const stateText = paused || aiOff ? 'Paused' : o.state === 'on' ? 'On' : trial ? trialProgress(o) : 'Off';
            const stateCls = paused || aiOff ? 'paused' : o.state;
            return (
              <div
                key={o.id}
                className={`so-grid so-row${trial ? ' so-row-trial' : ''}${paused || aiOff ? ' so-row-paused' : ''}`}
                data-testid="order-row"
                data-state={o.state}
              >
                <div className="so-name">{o.name}</div>
                <div className="so-when">{whenLooks(o.rule)}</div>
                <div className={`so-state-${stateCls}`}>{stateText}</div>
                <div>
                  {trial ? (
                    <>
                      <b>{o.wouldHave}</b> would have
                    </>
                  ) : o.fired > 0 ? (
                    <b>{o.fired}</b>
                  ) : (
                    '—'
                  )}
                </div>
                <div className="ai-hint" style={{ minWidth: 0 }}>
                  {o.lastFiredAt
                    ? `${dayTime(o.lastFiredAt)}${o.lastSummary ? ` · ${trial ? 'would have ' : ''}${o.lastSummary}` : ''}`
                    : 'Never run'}
                </div>
                <div className="so-btns">
                  {trial ? (
                    <>
                      <button
                        type="button"
                        className="ai-btn ai-btn-primary ai-btn-sm"
                        onClick={() => setOpen({ kind: 'history', id: o.id })}
                      >
                        Read the trial
                      </button>
                      <button
                        type="button"
                        className="ai-btn ai-btn-sm"
                        disabled={!o.canGoLive || patch.isPending}
                        title={o.canGoLive ? undefined : 'The trial has not fired yet'}
                        onClick={() => setState(o, 'on')}
                      >
                        Turn it on
                      </button>
                    </>
                  ) : o.state === 'on' ? (
                    <>
                      <button
                        type="button"
                        className="ai-btn ai-btn-sm"
                        onClick={() => setOpen({ kind: 'history', id: o.id })}
                      >
                        History
                      </button>
                      <button
                        type="button"
                        className="ai-btn ai-btn-sm"
                        disabled={patch.isPending}
                        onClick={() => setState(o, 'off')}
                      >
                        Pause
                      </button>
                    </>
                  ) : (
                    <>
                      {o.fired + o.wouldHave > 0 && (
                        <button
                          type="button"
                          className="ai-btn ai-btn-sm"
                          onClick={() => setOpen({ kind: 'history', id: o.id })}
                        >
                          History
                        </button>
                      )}
                      <button
                        type="button"
                        className="ai-btn ai-btn-sm"
                        disabled={patch.isPending}
                        onClick={() => setState(o, 'trial')}
                      >
                        Start a trial
                      </button>
                      <button type="button" className="ai-btn ai-btn-sm" onClick={() => editOf(o)}>
                        Edit
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {open?.kind === 'history' && current && (
        <FiringsPanel
          key={current.id}
          projectId={projectId}
          order={current}
          orders={list}
          onClose={() => setOpen(null)}
          onEdit={editOf}
        />
      )}
      {open?.kind === 'all' && <FiringsPanel projectId={projectId} orders={list} onClose={() => setOpen(null)} />}

      <div className="so-editor-row">
        <div className="so-side" style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
          <div className="so-card" style={{ flex: 1, minWidth: 300 }}>
            <h3>What a rule may do</h3>
            <ul>
              <li>
                Only the middle tier. A rule can never do something that asks first, and cannot be made to — and the
                actions fixed in the last tier can never be lowered into its reach.
              </li>
              <li>It cannot do what the PM is doing on the same ticket, and two rules cannot set each other off.</li>
              <li>It respects quiet hours, and Pause all AI stops every rule as well as every AI.</li>
              <li>
                Each firing is one Undo group, exactly like a Board AI action, and sits in the rule’s own history.
              </li>
            </ul>
          </div>
          <div className="so-card so-card-warm" style={{ flex: 1, minWidth: 300 }}>
            <h3>Rules that come ready-made</h3>
            <ul>
              {(templates.data?.templates ?? []).map((t) => (
                <li key={t.key}>
                  <button type="button" className="so-ready" onClick={() => fromTemplate(t)}>
                    {t.sentence}
                  </button>
                </li>
              ))}
              <li>
                <span className="ai-hint">All off until you turn them on, and all start in trial mode.</span>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
