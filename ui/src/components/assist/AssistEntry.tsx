import { useAssistState, useHealth } from '../../api/assist';
import { SparkleIcon } from '../ai/aiUi';
import { shortcutLabel, useAssist } from './AssistContext';
import { featureBlock } from './assistUi';
import './assist.css';

/** Header "Ask AI ⌘J" (A1). Hidden when chat is turned off (I12); disabled with the reason on hover (I1, I2). */
export function AskAiButton() {
  const ctx = useAssist();
  const st = useAssistState(ctx?.projectId);
  if (!ctx || !st.data) return null;
  const chat = st.data.features.find((f) => f.key === 'chat');
  if (chat && !chat.on) return null;
  const block = st.data.boardAi.state === 'unavailable' ? featureBlock(st.data, 'chat') : null;
  return (
    <button
      type="button"
      className="as-header-btn"
      onClick={ctx.toggle}
      disabled={!!block}
      title={block ? `${block.reason}. Fix in AI members.` : 'Ask the Board AI'}
      data-testid="ask-ai-button"
      aria-pressed={ctx.open}
    >
      <SparkleIcon size={13} /> Ask AI <span className="as-kbd">{shortcutLabel()}</span>
    </button>
  );
}

/** Header "Board health" chip (A2): opens the panel; shows how many insights need action. */
export function BoardHealthChip() {
  const ctx = useAssist();
  const st = useAssistState(ctx?.projectId);
  const enabled =
    !!st.data &&
    !!st.data.features.find((f) => f.key === 'health' && f.on) &&
    st.data.boardAi.state !== 'not_configured';
  const panel = useHealth(ctx?.projectId, enabled);
  if (!ctx || !enabled) return null;
  const n = panel.data?.needsAction.length ?? 0;
  return (
    <button
      type="button"
      className="ai-chip"
      style={{
        height: 30,
        padding: '0 11px',
        border: '1px solid #E3E8E5',
        background: n ? '#FFF4E5' : '#F6FAF7',
        color: n ? '#9A5B12' : '#2E6F40',
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
      onClick={() => ctx.setHealthOpen(true)}
      data-testid="board-health-chip"
    >
      Board health{n ? ` · ${n}` : ''}
    </button>
  );
}
