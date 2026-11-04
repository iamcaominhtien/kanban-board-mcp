import { useState } from 'react';
import { useAiInbox } from '../../api/aiSafety';
import type { AiMember } from '../../types/ai';
import { ago } from './aiUi';
import { SignedOutBanners } from './accounts/SignedOutBanners';
import './accounts/accountsMember.css';

type InboxTab = 'mentions' | 'questions';

/** Inbox (B1): the mentions of you and the questions the AIs wait on. */
export function InboxView({
  projectId,
  members,
  onOpenTicket,
  initialTab,
}: {
  projectId: string;
  members: AiMember[];
  onOpenTicket: (id: string) => void;
  initialTab?: InboxTab;
}) {
  const inbox = useAiInbox(projectId);
  const [tab, setTab] = useState<InboxTab>(initialTab ?? 'questions');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }} data-testid="ai-inbox">
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <b style={{ fontSize: 16, flex: 1 }}>Inbox</b>
      </div>
      <SignedOutBanners projectId={projectId} members={members} />
      <div className="ai-tabs" role="tablist" style={{ marginTop: 0 }}>
        {(
          [
            ['mentions', 'Mentions', inbox.data?.mentions.length ?? 0],
            ['questions', 'Questions', inbox.data?.questions.length ?? 0],
          ] as const
        ).map(([id, label, n]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`ai-tab ${tab === id ? 'ai-tab-active' : ''}`}
            onClick={() => setTab(id)}
            data-testid={`inbox-tab-${id}`}
          >
            {label}
            <span className="ai-tab-count">{n}</span>
          </button>
        ))}
      </div>
      {tab === 'mentions' && (
        <div className="ai-card">
          {!inbox.data?.mentions.length && (
            <div className="ai-hint" style={{ padding: 18 }}>
              No AI member has @mentioned you in the last two weeks.
            </div>
          )}
          {inbox.data?.mentions.map((m, i) => (
            <div
              key={m.commentId}
              className="ai-arow"
              style={{ gridTemplateColumns: '1fr auto', borderTop: i ? undefined : 0 }}
              onClick={() => onOpenTicket(m.ticketId)}
            >
              <div>
                <div style={{ fontSize: 13 }}>
                  <b>{m.author}</b> mentioned you on <span className="ai-mono">{m.ticketId}</span> · {m.ticketTitle}
                </div>
                <div className="ai-muted">{m.text.replace(/@\[([^\]]+)\]\(member:[^)]+\)/g, '@$1')}</div>
              </div>
              <span className="ai-muted">{ago(m.at)}</span>
            </div>
          ))}
        </div>
      )}
      {tab === 'questions' && (
        <div className="ai-card">
          {!inbox.data?.questions.length && (
            <div className="ai-hint" style={{ padding: 18 }}>
              No AI member is waiting for an answer.
            </div>
          )}
          {inbox.data?.questions.map((q, i) => (
            <div
              key={q.runId}
              className="ai-arow"
              style={{ gridTemplateColumns: '1fr auto', borderTop: i ? undefined : 0 }}
              onClick={() => onOpenTicket(q.ticketId)}
            >
              <div>
                <div style={{ fontSize: 13 }}>
                  <b>{q.memberName}</b> asks on <span className="ai-mono">{q.ticketId}</span> · {q.ticketTitle}
                </div>
                <div className="ai-muted">“{q.text}”</div>
              </div>
              <span className="ai-muted">{ago(q.askedAt)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
