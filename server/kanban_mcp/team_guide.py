"""How an agent outside the board (the person's own assistant) works with the board's AI team: ai_team(action='guide').

Too long for the server instructions (Claude Code keeps their first 10,000 characters), so the instructions carry a
short table and point here.
"""

TEAM_GUIDE = """\
# Working with the board's AI team

You act for the person, outside any AI run. The AI members are the team; the board starts, holds and stops their runs.
You decide what goes to whom, then let the board and the team carry it. Do not do their work for them and do not
drive every step by hand.

## 1. Look before you hand anything over
- ai_team(members, project_id): who is on the team, each member's role (pm, ba, designer, dev, qa, user_tester,
  reviewer, triage, tech_writer, devops, security, data_analyst), whether it is idle, working, paused or offline, and what it holds.
- ai_team(runs, project_id, active_only=true): what is running now. A ticket that a work run holds takes no second
  work run until that run ends.
- get_ticket: the ticket's criteria, comments and status; ai_team(workflow, ticket_id) if it is on a workflow.

## 2. Pick how to hand it over

| You want | Use | What happens |
|---|---|---|
| An answer, an opinion, an estimate, a review of what exists | ai_team(ask, member_id, text, ticket_id) (intent 'ask', the default) | An ask run reads the ticket and answers in a comment. It does not take the ticket, move it or change code. Several asks can run at once. |
| One AI to do one job on one ticket | ai_team(ask, ..., intent='work') | The ticket is assigned to that AI and a work run starts: it moves the ticket to In progress, works (in the ticket's worktree when the project uses them), logs work, reports and hands it to Review. One work run per ticket at a time. |
| A message that needs no run (a heads-up, context for later) | ai_team(ask, ..., intent='notify') | An @mention comment only; nothing runs. The AI reads it on its next run. |
| A ticket that needs several roles (shape, build, test, review) | ai_team(start_workflow, ticket_id, workflow) | The ticket follows that workflow: the board runs each step with the right role, sends work back when a review asks, and stops where a person must decide. |
| A goal bigger than one ticket ("a weather web app") | ai_team(give_story, project_id, text=the goal, fields={title, criteria, approve, budget_tokens}) | A Story: the PM writes the plan (its tickets, their order, which criterion each covers), it is approved, the tickets run on workflows as soon as what they wait for is done, and the PM checks the criteria and closes it. |

Rules of thumb:
- Asking is cheap and safe; work changes things. When unsure, ask first, then hand over the work.
- Hand work to the role that does it: code to a dev, a screen to the designer, tests to qa, a review to the reviewer,
  scope and criteria to the ba, splitting and coordinating to the pm. ai_team(members) shows the roles.
- More than one role, or more than one ticket: do not chain asks and assignments yourself. Use a workflow (one
  ticket) or a Story (several tickets); the board and the PM coordinate, retry and report.
- Write the text as the brief a teammate needs: what and why, the ticket's criteria, constraints, what "done" is.
  Never paste secrets.
- An @mention you write in a comment with ticket_items does NOT wake an AI. Only ai_team(ask) does.

## 3. Workflows
- ai_team(workflows, project_id): the ready-made ones and the project's own, with their steps.
  quick_fix (a bug with an obvious cause), standard (most features: shape, build, checks, test, review),
  feature_ui (anything a person looks at: adds design, the design approval and a user try), docs (a document, no code),
  chore (no behaviour to test: a version bump, a config), research (a question, not a change).
- With intake on (the project's Team on its own settings) a new ticket in To Do is taken by itself: Triage picks the
  workflow. Then you only create the ticket with good criteria.
- A step that waits for a person (the design approval, Done) is the person's, or the PM's when the project lets the
  PM approve; ai_team(workflow) shows where a ticket stands.

## 4. Stories
- give_story makes the Story and hands it to the PM (fields.hand=false keeps it a Draft). fields.approve: 'person' to
  see the plan first, 'pm' to let the PM approve its own plan (default: the project's setting).
- When the plan waits for the person (ai_team(story) shows plan_waiting): approve_plan, revise_plan (text = what to
  change: the PM writes the next version) or reject_plan. Approve only when the person asked you to decide.
- ai_team(stories) lists them with their state (draft, planning, in_progress, review, done, dropped), progress and
  what a Blocked one waits for. A Story moves with its plan: never move its status by hand.

## 5. While it runs
- An AI's question to the person shows in ai_team(runs) as needs_input: answer it with ai_team(answer, run_id, text)
  when you know the answer; otherwise tell the person.
- Permission requests are decided by a person in the board, never over MCP.
- A run that failed: ai_team(retry, run_id). A run that is stuck or wrong: ai_team(cancel, run_id, text=why).
- ai_team(decisions, project_id) lists what the PM decided in the person's place; ai_team(override, decision_id)
  undoes one while nothing was built on it.
- To pause an AI: ai_team(pause, member_id); everything: the person's Pause all AI in the board.
- Cost and limits: ai_team(usage, project_id). Do not start more work than the team can run; work waits in a queue.
"""
