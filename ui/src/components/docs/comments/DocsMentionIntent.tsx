import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { DocsMentionIntent } from '../../../utils/docsThreadAiRules';
import '../../ai/ai.css';

const KEY = 'kanban.docs.mentionIntent';

function remembered(): DocsMentionIntent | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'ask' || v === 'suggest' || v === 'notify' ? v : null;
  } catch {
    return null;
  }
}

/**
 * "What does the mention mean?" for a Docs comment that mentions an AI member (docs-ai-care E): Ask only, Suggest an
 * edit (the tickets' "Do the work"), or Just notify. Resolves to the choice, or null when the person goes back.
 * Mounted on its own, so any comment box can ask without a place in its tree.
 * @param names - The AI members mentioned.
 */
export function askDocsMentionIntent(names: string[]): Promise<DocsMentionIntent | null> {
  const saved = remembered();
  if (saved) return Promise.resolve(saved);
  return new Promise((resolve) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const done = (v: DocsMentionIntent | null, remember: boolean) => {
      if (v && remember) {
        try {
          localStorage.setItem(KEY, v);
        } catch {
          /* storage unavailable */
        }
      }
      resolve(v);
      root.unmount();
      host.remove();
    };
    root.render(<IntentDialog names={names} onDone={done} />);
  });
}

function IntentDialog({
  names,
  onDone,
}: {
  names: string[];
  onDone: (v: DocsMentionIntent | null, remember: boolean) => void;
}) {
  const [intent, setIntent] = useState<DocsMentionIntent>('ask');
  const [remember, setRemember] = useState(false);
  const opts: { id: DocsMentionIntent; title: string; sub: string; tag?: string }[] = [
    {
      id: 'ask',
      title: 'Ask (answer in the thread)',
      sub: 'It reads the page and the whole thread and replies here. Nothing on the page changes.',
      tag: 'Default',
    },
    {
      id: 'suggest',
      title: 'Ask and suggest an edit',
      sub: 'It answers, and when the page is out of date it proposes the change for a person to review.',
    },
    {
      id: 'notify',
      title: 'Just notify',
      sub: 'Same as mentioning a person. Nothing runs.',
    },
  ];
  return (
    <div className="ai-overlay" onClick={() => onDone(null, false)}>
      <div
        className="ai-modal"
        style={{ width: 480 }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onDone(null, false);
        }}
        role="dialog"
        aria-label="What does the mention mean"
        data-testid="docs-mention-intent"
      >
        <div className="ai-modal-head">
          <h2 className="ai-modal-title" style={{ fontSize: 15 }}>
            You mentioned {names.join(', ')}
          </h2>
          <div className="ai-hint">What should happen when you post this comment?</div>
        </div>
        <div className="ai-modal-body" style={{ gap: 8 }}>
          {opts.map((o) => (
            <button
              key={o.id}
              type="button"
              className={`ai-option ${intent === o.id ? 'ai-option-active' : ''}`}
              onClick={() => setIntent(o.id)}
              data-testid={`docs-mention-${o.id}`}
            >
              <span className={`ai-radio ${intent === o.id ? 'ai-radio-on' : ''}`} />
              <span>
                <b style={{ fontSize: 13 }}>{o.title}</b>
                {o.tag && (
                  <span
                    className="ai-chip"
                    style={{ marginLeft: 6, height: 18, background: '#F1F8F3', color: '#2E6F40' }}
                  >
                    {o.tag}
                  </span>
                )}
                <div className="ai-muted">{o.sub}</div>
              </span>
            </button>
          ))}
          <label style={{ display: 'flex', gap: 8, fontSize: 12.5, alignItems: 'center' }}>
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember my
            choice for Docs comments
          </label>
        </div>
        <div className="ai-modal-foot">
          <span style={{ flex: 1 }} />
          <button type="button" className="ai-btn" onClick={() => onDone(null, false)}>
            Back
          </button>
          <button
            type="button"
            className="ai-btn ai-btn-primary"
            autoFocus
            onClick={() => onDone(intent, remember)}
            data-testid="docs-mention-send"
          >
            Post comment
          </button>
        </div>
      </div>
    </div>
  );
}
