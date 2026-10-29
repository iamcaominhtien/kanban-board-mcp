import { useEffect, useRef, useState } from 'react';
import { aiApi, useAiMutation } from '../../api/ai';
import { extractError } from '../../api/extractError';
import { useMembers } from '../../api/members';
import type { AiRun } from '../../types/ai';
import { MemberAvatar } from '../MemberAvatar';
import { useToast } from '../Toast';
import { currentPerson } from '../assist/assistUi';
import { FloatMenu } from './ComposerAi';
import { AiAvatar, RunStateChip, fmtElapsed, hhmm, secondsSince, useAiBoardState, useNow } from './aiUi';
import './ticketWork.css';

const laterKey = (runId: string) => `kanban.ai.answerLater.${runId}`;

/** “Answer later” is remembered for this browser session: the card shrinks to one line, the reminders keep coming. */
function useAnswerLater(runId: string): [boolean, (v: boolean) => void] {
  const [later, setLater] = useState(() => {
    try {
      return sessionStorage.getItem(laterKey(runId)) === '1';
    } catch {
      return false;
    }
  });
  return [
    later,
    (v) => {
      setLater(v);
      try {
        if (v) sessionStorage.setItem(laterKey(runId), '1');
        else sessionStorage.removeItem(laterKey(runId));
      } catch {
        /* storage unavailable */
      }
    },
  ];
}

/**
 * The AI asks back (E1): choices with a line each and one marked recommended, free text, Answer and resume,
 * Answer later and Ask someone else. Answering resumes the run; no terminal needed.
 */
export function QuestionCard({ run }: { run: AiRun }) {
  const q = run.question!;
  const { members } = useAiBoardState();
  const ai = members.get(run.memberId);
  const details = q.options.map(
    (o) => q.optionDetails?.find((d) => d.label === o) ?? { label: o, description: '', recommended: false },
  );
  const recommended = details.find((d) => d.recommended)?.label ?? q.options[0] ?? null;
  const [choice, setChoice] = useState<string | null>(recommended);
  const [text, setText] = useState('');
  const [later, setLater] = useAnswerLater(run.id);
  const toast = useToast();
  const answer = useAiMutation((t: string) => aiApi.answer(run.id, t));
  useNow(30_000);
  const value = choice === '__other' || !choice ? text : text ? `${choice}. ${text}` : choice;
  const waiting = fmtElapsed(secondsSince(q.askedAt));
  const reminded = q.reminders?.length ?? 0;
  if (later)
    return (
      <div className="tw-later" data-testid="ai-question-later">
        <RunStateChip state="needs_input" />
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <b>{run.memberName}</b> is waiting for {q.to}: {q.text}
        </span>
        {reminded > 0 && <span className="tw-dot" title={`Reminded ${reminded} time${reminded === 1 ? '' : 's'}`} />}
        <button type="button" className="ai-btn ai-btn-sm ai-btn-primary" onClick={() => setLater(false)}>
          Answer
        </button>
      </div>
    );
  return (
    <div className="tw-question" data-testid="ai-question-card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {ai && <AiAvatar provider={ai.provider} color={ai.color} glyph={ai.glyph} size={36} />}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>{run.memberName} asks a question</div>
          <div style={{ fontSize: 12.5, color: '#5B6F86' }}>
            {hhmm(q.askedAt)} · waiting {waiting} · run #{run.number} paused
          </div>
        </div>
        {reminded > 0 && (
          <span
            className="tw-dot"
            title={`Reminded ${reminded} time${reminded === 1 ? '' : 's'}`}
            data-testid="question-reminder-dot"
          />
        )}
        <span className="ai-chip" style={{ background: '#fff', color: '#34455A', border: '1px solid #D3DCE6' }}>
          To {q.to}
        </span>
      </div>
      <div style={{ fontSize: 14, margin: '12px 0', lineHeight: 1.55 }}>{q.text}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {details.map((o) => (
          <button
            key={o.label}
            type="button"
            className={`ai-option ${choice === o.label ? 'ai-option-active' : ''}`}
            onClick={() => setChoice(o.label)}
            data-testid="question-option"
          >
            <span className={`ai-radio ${choice === o.label ? 'ai-radio-on' : ''}`} />
            <span style={{ textAlign: 'left' }}>
              <b style={{ fontSize: 14 }}>{o.label}</b>
              {(o.description || o.recommended) && (
                <div className="ai-hint">
                  {o.description}
                  {o.description && o.recommended ? ' ' : ''}
                  {o.recommended && <b style={{ color: '#2E6F40' }}>Recommended.</b>}
                </div>
              )}
            </span>
          </button>
        ))}
        <div
          className={`ai-option ${choice === '__other' || !q.options.length ? 'ai-option-active' : ''}`}
          onClick={() => setChoice('__other')}
        >
          {q.options.length > 0 && <span className={`ai-radio ${choice === '__other' ? 'ai-radio-on' : ''}`} />}
          {q.options.length > 0 && <b style={{ fontSize: 14, whiteSpace: 'nowrap' }}>Something else</b>}
          <input
            className="ai-input"
            style={{ border: 'none', padding: 0, background: 'transparent', boxShadow: 'none' }}
            placeholder={q.options.length ? 'type an answer…' : 'Type an answer…'}
            value={text}
            onFocus={() => q.options.length && setChoice('__other')}
            onChange={(e) => setText(e.target.value)}
            data-testid="ai-answer-input"
          />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <button
          type="button"
          className="ai-btn ai-btn-primary"
          disabled={!value.trim() || answer.isPending}
          onClick={async () => {
            try {
              await answer.mutateAsync(value.trim());
              toast.success('Answer sent', `${run.memberName} resumes the run.`);
            } catch (err) {
              toast.error("Couldn't send the answer", extractError(err));
            }
          }}
          data-testid="ai-answer-send"
        >
          ▷ Answer and resume
        </button>
        <button type="button" className="ai-btn" onClick={() => setLater(true)} data-testid="ai-answer-later">
          Answer later
        </button>
        <AskSomeoneElse run={run} />
      </div>
      <div className="ai-muted" style={{ marginTop: 8 }}>
        Pending is set while it waits; the answer clears it. The hold lasts 24 h.
      </div>
    </div>
  );
}

/** Ask someone else: the question and Pending go to another person. */
function AskSomeoneElse({ run }: { run: AiRun }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const toast = useToast();
  const people = (useMembers(run.projectId).data ?? []).filter(
    (m) => (m.kind ?? 'human') === 'human' && m.name !== run.question?.to,
  );
  const pass = useAiMutation((id: string) => aiApi.askSomeoneElse(run.id, id));
  useEffect(() => {
    if (!open) return undefined;
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as Element).closest?.('.tw-menu'))
        setOpen(false);
    };
    document.addEventListener('mousedown', down);
    return () => document.removeEventListener('mousedown', down);
  }, [open]);
  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        ref={btn}
        type="button"
        className="ai-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        data-testid="ai-ask-someone-else"
      >
        ⌄ Ask someone else
      </button>
      {open && (
        <FloatMenu anchor={btn.current} onClose={() => setOpen(false)} width={260}>
          <div className="ai-label" style={{ marginBottom: 4, padding: '4px 8px 0' }}>
            Pass the question to
          </div>
          {people.map((p) => (
            <button
              key={p.id}
              type="button"
              role="menuitem"
              className="ai-mi"
              disabled={pass.isPending}
              data-testid="ask-else-person"
              onClick={async () => {
                try {
                  await pass.mutateAsync(p.id);
                  setOpen(false);
                  toast.success(`Asked ${p.name}`, 'They are notified and Pending now waits on them.');
                } catch (err) {
                  toast.error("Couldn't pass the question on", extractError(err));
                }
              }}
            >
              <MemberAvatar member={p} size={22} />
              {p.name}
              {p.name === currentPerson() && <span className="ai-muted"> you</span>}
            </button>
          ))}
          {people.length === 0 && <span className="ai-muted">Nobody else in this project.</span>}
        </FloatMenu>
      )}
    </span>
  );
}
