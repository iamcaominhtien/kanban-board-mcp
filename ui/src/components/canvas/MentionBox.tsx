import { useRef, type ChangeEvent, type KeyboardEvent, type MouseEvent, type RefObject } from 'react';
import { RefSuggester, type SuggestMember } from '../docs/RefSuggester';

interface Props {
  /** A textarea (a new comment) or a one-line input (a reply). */
  multiline?: boolean;
  value: string;
  onChange: (value: string) => void;
  /** People offered after `@`. */
  members: SuggestMember[];
  projectId: string;
  className?: string;
  placeholder?: string;
  rows?: number;
  autoFocus?: boolean;
  ariaLabel?: string;
  testId?: string;
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => void;
  onClick?: (e: MouseEvent<HTMLTextAreaElement | HTMLInputElement>) => void;
}

/**
 * A comment box of the canvas with the `@` picker: typing `@` lists the people of the project; the box shows a pick as
 * `@Name` and the caller saves it with `store` from `useCanvasMentions`.
 * @param props - The text and what it looks like.
 */
export function MentionBox(props: Props) {
  const { multiline, value, onChange, members, projectId, className, placeholder, rows, autoFocus, ariaLabel } = props;
  const field = useRef<HTMLTextAreaElement | HTMLInputElement>(null);
  const common = {
    className,
    placeholder,
    value,
    autoFocus,
    'aria-label': ariaLabel,
    'data-testid': props.testId,
    onChange: (e: ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) => onChange(e.target.value),
    onKeyDown: props.onKeyDown,
    onClick: props.onClick,
  };
  return (
    <>
      {multiline ? (
        <textarea ref={field as RefObject<HTMLTextAreaElement>} rows={rows} {...common} />
      ) : (
        <input ref={field as RefObject<HTMLInputElement>} {...common} />
      )}
      {projectId && members.length > 0 && (
        <RefSuggester targetRef={field} projectId={projectId} members={members} membersOnly zIndex={2900} />
      )}
    </>
  );
}
