import { useState } from 'react';
import { aiApi, useAiMutation } from '../../api/ai';
import { extractError } from '../../api/extractError';
import type { RunQuestion } from '../../types/ai';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { useToast } from '../Toast';
import { AiAvatar, fmtElapsed, hhmm, secondsSince, useAiBoardState, useNow } from './aiUi';
import { fmtDuration } from '../aiteam/teamFormat';
import './ticketWork.css';
import { LineIcon } from '../ui/LineIcon';

/** What the card needs of a run: the board entry and the full run both have it. */
export interface QuestionRun {
  /** The run's id (`runId` on a board entry). */
  id: string;
  memberId: string;
  number: number;
  question: RunQuestion | null;
}

/**
 * The lead asks back: choices with a line each and one marked recommended, free text, Answer and resume.
 * Answering resumes the run's conversation; no terminal needed.
 */
export function QuestionCard({ run, variant }: { run: QuestionRun; variant?: 'strip' }) {
  const q = run.question;
  const { members } = useAiBoardState();
  const team = members.get(run.memberId);
  const options = q?.options ?? [];
  const details = options.map(
    (o) => q?.optionDetails?.find((d) => d.label === o) ?? { label: o, description: '', recommended: false },
  );
  const recommended = details.find((d) => d.recommended)?.label ?? options[0] ?? null;
  const [choice, setChoice] = useState<string | null>(recommended);
  const [text, setText] = useState('');
  const toast = useToast();
  const answer = useAiMutation((t: string) => aiApi.answer(run.id, t));
  useNow(30_000);
  if (!q) return null;
  const value = choice === '__other' || !choice ? text : text ? `${choice}. ${text}` : choice;
  const waiting = variant === 'strip' ? fmtDuration(secondsSince(q.askedAt)) : fmtElapsed(secondsSince(q.askedAt));
  const name = team?.name ?? 'The team';
  const strip = variant === 'strip';
  return (
    <div className={`tw-question${variant === 'strip' ? ' tw-question-strip' : ''}`} data-testid="ai-question-card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {team && <AiAvatar color={team.color} size={variant === 'strip' ? 30 : 36} />}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: strip ? 14 : 15, fontWeight: 700 }}>{name} asks a question</div>
          <div style={{ fontSize: strip ? 11.5 : 12.5, color: strip ? '#5B6B60' : '#5B6F86' }}>
            {q.askedAt ? `${hhmm(q.askedAt)} · waiting ${waiting} · ` : ''}run #{run.number} paused
          </div>
        </div>
        {q.to && (
          <span
            className="ai-chip"
            style={{ background: '#fff', color: '#34455A', border: `1px solid ${strip ? '#B8C4D2' : '#D3DCE6'}` }}
          >
            To {q.to}
          </span>
        )}
      </div>
      <div style={{ fontSize: strip ? 13 : 14, margin: '12px 0', lineHeight: strip ? 1.5 : 1.55 }}>
        <MarkdownRenderer plain>{q.text}</MarkdownRenderer>
      </div>
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
          className={`ai-option ${choice === '__other' || !options.length ? 'ai-option-active' : ''}`}
          onClick={() => setChoice('__other')}
        >
          {options.length > 0 && <span className={`ai-radio ${choice === '__other' ? 'ai-radio-on' : ''}`} />}
          {options.length > 0 && <b style={{ fontSize: 14, whiteSpace: 'nowrap' }}>Something else</b>}
          <input
            className="ai-input"
            style={{ border: 'none', padding: 0, background: 'transparent', boxShadow: 'none' }}
            placeholder={options.length ? 'type an answer…' : 'Type an answer…'}
            value={text}
            onFocus={() => options.length && setChoice('__other')}
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
              toast.success('Answer sent', `${name} resumes the run.`);
            } catch (err) {
              toast.error("Couldn't send the answer", extractError(err));
            }
          }}
          data-testid="ai-answer-send"
        >
          <LineIcon name="play" size={12} /> Answer and resume
        </button>
      </div>
    </div>
  );
}
