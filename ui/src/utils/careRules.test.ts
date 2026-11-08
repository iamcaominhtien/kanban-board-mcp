import { describe, expect, it } from 'vitest';
import {
  canCreate,
  checkedLabel,
  columnLabel,
  createBody,
  createdToast,
  createLabel,
  defaultHealthTab,
  dueLabel,
  firstTicketRef,
  healthTabs,
  initials,
  showFreshnessBanner,
  toEditable,
  type TicketDraft,
} from './careRules';

const draft = (n: number, over: Partial<TicketDraft> = {}): TicketDraft => ({
  n,
  text: `item ${n}`,
  title: `Item ${n}`,
  type: 'task',
  projectId: 'p1',
  column: 'backlog',
  suggestedAssignee: { memberId: 'm1', name: 'Hoa Mai' },
  dueDate: null,
  ...over,
});

describe('checkedLabel', () => {
  it('says today with the time, yesterday and days ago', () => {
    const now = new Date(2026, 9, 30, 12, 0);
    expect(checkedLabel(new Date(2026, 9, 30, 6, 10).toISOString(), now)).toBe('Checked today 06:10');
    expect(checkedLabel(new Date(2026, 9, 29, 23, 0).toISOString(), now)).toBe('Checked yesterday');
    expect(checkedLabel(new Date(2026, 9, 25, 9, 0).toISOString(), now)).toBe('Checked 5 days ago');
    expect(checkedLabel(null, now)).toBe('Not checked yet');
  });
});

describe('freshness banner', () => {
  it('shows only to editors, with Docs AI on, for a flagged page that AI can read', () => {
    const base = { canEdit: true, aiOn: true, stale: true };
    expect(showFreshnessBanner(base)).toBe(true);
    expect(showFreshnessBanner({ ...base, canEdit: false })).toBe(false);
    expect(showFreshnessBanner({ ...base, aiOn: false })).toBe(false);
    expect(showFreshnessBanner({ ...base, stale: false })).toBe(false);
  });
  it('offers to open the first ticket among the reasons', () => {
    const r = (kind: string, ref: string) => ({ key: `${kind}:${ref}`, kind, ref, text: '', compared: '' });
    expect(firstTicketRef([r('page', 'Decision log'), r('ticket', 'KAN-12'), r('ticket', 'KAN-9')])).toBe('KAN-12');
    expect(firstTicketRef([r('page', 'Decision log')])).toBeNull();
  });
});

describe('docs health', () => {
  const counts = { outOfDate: 0, missing: 2, broken: 0, overlaps: 1, total: 3 };
  it('lists the tabs with counts and opens the first with something in it', () => {
    expect(healthTabs(counts).map((t) => `${t.label} ${t.count}`)).toEqual([
      'Out of date 0',
      'Missing docs 2',
      'Broken links 0',
      'Overlaps 1',
    ]);
    expect(defaultHealthTab(counts)).toBe('missing');
    expect(defaultHealthTab({ outOfDate: 0, missing: 0, broken: 0, overlaps: 0, total: 0 })).toBe('outOfDate');
  });
});

describe('tickets from a page', () => {
  it('starts with every draft included and nobody assigned', () => {
    const d = toEditable([draft(1), draft(2)]);
    expect(d.every((x) => x.include && x.assigneeId === null)).toBe(true);
    expect(d[0]!.suggestedAssignee?.name).toBe('Hoa Mai');
  });
  it('labels the button and the undo toast', () => {
    expect(createLabel(1)).toBe('Create 1 ticket');
    expect(createLabel(2)).toBe('Create 2 tickets');
    expect(createdToast(2, 'backlog')).toBe('2 tickets created in Backlog');
    expect(createdToast(1, 'todo')).toBe('1 ticket created in To Do');
    expect(columnLabel('in-progress')).toBe('In Progress');
  });
  it('needs one included draft and a title on each', () => {
    const d = toEditable([draft(1), draft(2)]);
    expect(canCreate(d)).toBe(true);
    expect(canCreate(d.map((x) => ({ ...x, include: false })))).toBe(false);
    expect(canCreate([{ ...d[0]!, title: '  ' }, d[1]!])).toBe(false);
    expect(canCreate([{ ...d[0]!, title: '  ', include: false }, d[1]!])).toBe(true);
  });
  it('sends only included drafts and never the suggested assignee', () => {
    const d = toEditable([draft(1), draft(2)]);
    d[1]!.include = false;
    const body = createBody(d, true, true);
    expect(body.drafts).toHaveLength(1);
    expect(body.drafts[0]!.assigneeId).toBeNull();
    expect(body.replaceText).toBe(true);
    d[0]!.assigneeId = 'm1';
    expect(createBody(d, false, false).drafts[0]!.assigneeId).toBe('m1');
  });
  it('formats due dates and initials', () => {
    expect(dueLabel('2026-10-30')).toBe('Due Fri, Oct 30');
    expect(dueLabel(null)).toBeNull();
    expect(initials('Hoa Mai')).toBe('HM');
  });
});
