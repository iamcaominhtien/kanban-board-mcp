import type { ReactNode } from 'react';
import { LineIcon } from '../../ui/LineIcon';
import type { RunStep } from '../../../types/ai';
import { stepTone } from './treeLogic';

const MARK = (glyph: ReactNode, color: string, label: string) => (
  <span
    title={label}
    aria-label={label}
    style={{ color, fontWeight: 800, width: 13, textAlign: 'center', flexShrink: 0 }}
  >
    {glyph}
  </span>
);

/** The mark in front of a step: what kind it is, red when it failed, a spinner on the one in progress. */
export function StepIcon({ step, working }: { step: RunStep; working?: boolean }) {
  if (working) return <span className="ai-spin" />;
  const tone = stepTone(step);
  if (tone === 'bad') return MARK(<LineIcon name="close" size={13} />, '#C4432A', 'Failed');
  switch (step.kind) {
    case 'subagent':
      return MARK('⑂', '#5B3AA6', 'Role');
    case 'skill':
      return MARK(<LineIcon name="sparkle" size={13} />, '#5B3AA6', 'Skill');
    case 'board':
      return MARK(<LineIcon name="link" size={13} />, '#2F6FB0', 'Board');
    case 'question':
      return MARK('?', '#34455A', 'Question');
    case 'text':
      return MARK('“', '#9AA8A0', 'Said');
    case 'message':
      return MARK(<LineIcon name="send" size={13} />, '#2F6FB0', 'Message');
    case 'rate_limited':
      return MARK(<LineIcon name="clock" size={13} />, '#B8860B', 'Waiting for the limit');
    case 'hook':
      return MARK('⚓', '#9AA8A0', 'Hook');
    case 'plan':
      return MARK(<LineIcon name="bulb" size={13} />, '#5B6B60', 'Plan');
    case 'report':
      return MARK(<LineIcon name="page" size={13} />, '#2E6F40', 'Report');
    case 'edit':
    case 'create':
      return MARK(<LineIcon name="edit" size={13} />, '#2E6F40', step.kind === 'edit' ? 'Edit' : 'New file');
    case 'read':
    case 'search':
      return MARK(<LineIcon name="search" size={13} />, '#5B6B60', step.kind === 'read' ? 'Read' : 'Search');
    case 'command':
      return MARK('$', '#2E6F40', 'Command');
    default:
      return (
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#2E6F40"
          strokeWidth="2.6"
          style={{ flexShrink: 0 }}
        >
          <path d="M5 12.5L10 17.5L19 7" />
        </svg>
      );
  }
}
