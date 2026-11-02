import { openTimeline } from '../aiteam/timelineLink';

/**
 * Links into and out of a Story: "See it in Flow" (the AI Team's Flow tab scoped to one Story) and the board's
 * "Group by: Story" switch, remembered per person.
 */

/** Show the AI Team's Flow tab scoped to this Story (the Flow tab's own link: scope and view). */
export function openStoryFlow(storyId: string): void {
  openTimeline({ flow: { story: storyId, ticket: null, view: 'map' } });
}

/** Who is looking: the member the app acts as, or the board's own user. */
function personKey(): string {
  try {
    return localStorage.getItem('kanbanActor') || 'me';
  } catch {
    return 'me';
  }
}

const groupKey = () => `kanban.board.groupByStory.${personKey()}`;

/** Group by Story is off until someone turns it on (design D). */
export function readGroupByStory(): boolean {
  try {
    return localStorage.getItem(groupKey()) === '1';
  } catch {
    return false;
  }
}

/** Remember the switch for this person. */
export function writeGroupByStory(on: boolean): void {
  try {
    if (on) localStorage.setItem(groupKey(), '1');
    else localStorage.removeItem(groupKey());
  } catch {
    /* storage unavailable: the switch lasts until the page reloads */
  }
}
