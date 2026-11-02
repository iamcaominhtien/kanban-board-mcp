import type { ReactNode } from 'react';

const ico = (d: ReactNode, color = 'currentColor') => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    style={{ flexShrink: 0 }}
  >
    {d}
  </svg>
);
/** Part of the pull request (wave 3). */
export const SPARKLE = ico(<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />);
/** Part of the pull request (wave 3). */
export const EXTERNAL = ico(<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />);
/** Part of the pull request (wave 3). */
export const BRANCH = ico(
  <>
    <circle cx="6" cy="6" r="2.5" />
    <circle cx="6" cy="18" r="2.5" />
    <circle cx="18" cy="9" r="2.5" />
    <path d="M6 8.5v7M18 11.5c0 4-6 3-12 4.5" />
  </>,
  '#A5321E',
);
/** Part of the pull request (wave 3). */
export const BUBBLE = ico(<path d="M21 12a8 8 0 0 1-11.5 7.2L4 20.5l1.4-4.6A8 8 0 1 1 21 12z" />, '#244E78');

export const CI_TEXT: Record<string, string> = {
  green: 'CI is green',
  red: 'CI is red',
  pending: 'CI is running',
  none: 'No CI on this pull request',
};

const RULES: [string, ReactNode, ReactNode][] = [
  [
    'Which pull requests',
    'Only ones the board opened, from a ticket, on this project.',
    'A pull request nobody here created has an owner already.',
  ],
  [
    'How it finds out',
    'gh every few minutes while it is open; nothing while it is not.',
    'No webhook can reach a laptop. The polling stops the moment the pull request closes.',
  ],
  [
    'Is the failure ours',
    'Checked against the base branch first. Red on the base too means it is not this ticket’s.',
    'The trial in section H caught exactly this case before the rule went live.',
  ],
  [
    'Who fixes it',
    'The AI that wrote the code, on the ticket’s own worktree, as a normal run.',
    'Same no-progress rule, same quota, same place in the run history.',
  ],
  [
    'Review comments',
    'The text and the lines go to the AI. It replies on the thread when something changed.',
    'It never resolves a person’s thread, and it never pushes without the usual hand-over rules.',
  ],
  [
    'Pushing and replying',
    <>
      On a pull request the board opened, pushing to <b>that branch</b> and replying on <b>its</b> threads are part of
      the work: they happen inside the run, with no prompt, and are recorded in it.
    </>,
    'A fix it cannot push is not a fix. Everything else that leaves the board — any other branch, any other repository, opening a pull request in the first place — still asks.',
  ],
  [
    'Approving or merging',
    'Never. Both are in the ask-first tier, and neither can be moved out of it.',
    'Approving your own team’s work is not something to automate.',
  ],
];

/** The rule in words, with the reason beside each line (design J). */
export function PullRules() {
  return (
    <div data-testid="pull-rules" style={{ fontSize: 12, lineHeight: 1.5 }}>
      {RULES.map(([name, rule, why], i) => (
        <div
          key={name}
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(110px, 150px) 1fr 1fr',
            gap: 12,
            padding: '8px 0',
            borderTop: i ? '1px solid #EEF3EF' : undefined,
          }}
        >
          <b>{name}</b>
          <span style={{ color: '#5B6B60' }}>{rule}</span>
          <span style={{ color: '#1E2A22' }}>{why}</span>
        </div>
      ))}
    </div>
  );
}
