import { MAX_PERSONA } from './teamOptions';

/** The persona box of a team: a textarea with its length counted in the corner ("56 / 4000", design C and D). */
export function PersonaField({
  value,
  onChange,
  placeholder,
  ariaLabel,
  testId,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  testId?: string;
}) {
  return (
    <div className="ai-persona">
      <textarea
        className="ai-textarea"
        style={{ minHeight: 70 }}
        value={value}
        maxLength={MAX_PERSONA}
        aria-label={ariaLabel}
        data-testid={testId}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      <span className="ai-persona-count">
        {value.length} / {MAX_PERSONA}
      </span>
    </div>
  );
}
