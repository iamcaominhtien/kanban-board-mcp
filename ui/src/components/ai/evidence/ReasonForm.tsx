import { useState } from 'react';
import '../workflow/workflow.css';

/**
 * Taking work without its evidence asks why (ai-story-flow N): a short box, and the button stays off until something
 * is written. The reason is kept on the step and shown on the card with who and when.
 */
export function ReasonForm({
  label,
  placeholder,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
  testId,
}: {
  label: string;
  placeholder: string;
  submitLabel: string;
  busy?: boolean;
  onSubmit: (reason: string) => void;
  onCancel: () => void;
  testId?: string;
}) {
  const [text, setText] = useState('');
  const reason = text.trim();
  return (
    <form
      style={{ display: 'grid', gap: 6 }}
      data-testid={testId}
      onSubmit={(e) => {
        e.preventDefault();
        if (reason) onSubmit(reason);
      }}
    >
      <label className="wf-note" style={{ fontWeight: 700 }}>
        {label}
        <textarea
          className="wf-textarea"
          style={{ marginTop: 4, fontWeight: 400 }}
          value={text}
          placeholder={placeholder}
          autoFocus
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <div className="wf-actions">
        <button type="submit" className="ai-btn ai-btn-primary ai-btn-sm" disabled={!reason || busy}>
          {submitLabel}
        </button>
        <button type="button" className="ai-btn ai-btn-sm" onClick={onCancel}>
          Cancel
        </button>
        <span className="wf-hint">A reason is required. It is kept on the step with your name and the time.</span>
      </div>
    </form>
  );
}
