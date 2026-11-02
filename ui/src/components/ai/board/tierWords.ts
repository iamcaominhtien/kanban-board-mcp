import type { Tier } from '../../../types/aiBoard';

/** Each action in plain words (the ops the server's tier table names). */
export const OP_WORDS: Record<string, string> = {
  status: 'Move a ticket to another column',
  priority: 'Change a ticket’s priority',
  tags: 'Change a ticket’s labels',
  assignee: 'Assign a ticket',
  due_date: 'Set a due date',
  estimate: 'Set an estimate',
  title: 'Rename a ticket',
  comment: 'Comment on a ticket',
  add_criteria: 'Add acceptance criteria',
  workflow: 'Put a workflow on a ticket',
  depth: 'Set a ticket’s review depth',
  run: 'Start an AI on a ticket',
  stop_run: 'Stop one run',
  pause_member: 'Pause one AI member',
  resume_member: 'Resume one AI member',
  create: 'Create a ticket',
  message: 'Tell the AI that is working on a ticket',
  delegate: 'Hand a ticket to the PM',
  schedule_create: 'Make a schedule',
  schedule_edit: 'Change a schedule',
  schedule_pause: 'Pause a schedule',
  schedule_resume: 'Resume a schedule',
  schedule_run: 'Run a schedule now',
  schedule_delete: 'Delete a schedule',
  done: 'Move a ticket to Done',
  delete: 'Delete anything',
  pause_all: 'Pause all AI',
  permission: 'Change a permission, ceiling or bypass',
  budget: 'Change a budget or an account',
  merge: 'Merge a pull request',
  post_outside: 'Post anything outside the board',
};

export const TIER_WORDS: Record<Tier, string> = {
  free: 'Just does it',
  undo: 'Does it, and keeps an Undo',
  ask: 'Asks first',
};

/** The three cards' colours, as the design draws them. */
export const TIER_STYLE: Record<Tier, { border: string; bg: string; color: string; blurb: string }> = {
  free: {
    border: '#CFE3D6',
    bg: '#F3F9F5',
    color: '#1F5A31',
    blurb: 'Nothing changes, so there is nothing to undo.',
  },
  undo: {
    border: '#CBDDEE',
    bg: '#F2F7FC',
    color: '#244E78',
    blurb: 'Reversible, and small: up to {n} tickets, in one project. Above that it asks, as a bulk action.',
  },
  ask: {
    border: '#F0DBA8',
    bg: '#FFFBEF',
    color: '#7A5A06',
    blurb: 'Cannot be walked back from inside the board, reaches outside it, or touches more than {n} tickets at once.',
  },
};

export const LOCKED_REASON =
  'Fixed in the last tier, per project and for ever: moving a ticket to Done · deleting anything · Pause all AI · a permission, ceiling or bypass change · a budget or account change · merging · anything that posts outside the board.';

/**
 * The cards' own short bullets (design ai-board-wave3 C). The first card's are what the Board AI may always just do
 * (it only reads); actions lowered into it are listed after them.
 */
export const TIER_BULLETS: Record<Tier, string[]> = {
  free: [
    'Find a ticket, a page, a run, something in the knowledge base',
    'Who is working on what, and how far along',
    'Read a run, a transcript, the audit log, a schedule',
    'What a Claude account has left',
  ],
  undo: [
    'Create a ticket, change its fields, move it, assign it, comment',
    'Put a workflow or a review depth on a ticket',
    'Start a run, stop one run, pause or resume one member',
    'Create a member, give it a pack or a skill, install a plugin',
    'Create or edit a workflow template, a schedule, a Docs page',
  ],
  ask: [
    'Move a ticket to Done; more than {n} tickets, or more than one project; delete anything',
    'Pause all AI; change a permission, a ceiling or bypass; remove a member',
    'Merge, open a pull request, push a branch',
    'Budgets, accounts, settings — every change',
  ],
};
