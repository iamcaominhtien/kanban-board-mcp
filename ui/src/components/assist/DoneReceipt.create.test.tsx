// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { appliedWords, proposedWords } from './DoneReceipt';

describe('a new ticket from the Board AI, in words', () => {
  it('names the type it will have, a Story included', () => {
    const story = render(<>{proposedWords({ op: 'create', ticket: '', title: 'Learn code graphs', type: 'story' })}</>);
    expect(story.container.textContent).toBe('New Story “Learn code graphs”');
    const bug = render(<>{proposedWords({ op: 'create', ticket: '', title: 'Crash on save', type: 'bug' })}</>);
    expect(bug.container.textContent).toBe('New bug “Crash on save”');
    const plain = render(<>{proposedWords({ op: 'create', ticket: '', title: 'Tidy up' })}</>);
    expect(plain.container.textContent).toBe('New ticket “Tidy up”');
  });

  it('says a Story waits as a Draft for the PM', () => {
    expect(appliedWords({ op: 'create', created: 'RES-2', type: 'story' })).toBe(
      'created as a Story, a Draft until you hand it to the PM',
    );
    expect(appliedWords({ op: 'create', created: 'RES-3', type: 'task' })).toBe('created as a new ticket');
    expect(appliedWords({ op: 'create', created: 'RES-4', type: 'bug' })).toBe('created as a new bug');
  });
});
