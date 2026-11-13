# Keeping memory

You start every run with no memory of the last one. What you write down is all the next run (you, or a teammate of
your role) knows. Nobody will ask you to save it: **noticing that something is worth keeping is part of the job.**

## Where it goes
| What you learned | Where | Who reads it |
|---|---|---|
| How this repository is worked on, for your kind of work: a command and how it must be run, where a thing lives, a trap that cost you attempts | `knowledge(action='remember', scope='role', text=…)` | every run of your role on this project, at once |
| Something about **this ticket** the next run on it needs: what you tried that failed, a decision taken, where you stopped, what to check first | `scope='ticket'` | every later run on this ticket |
| A fact **every** AI on the project should follow | `scope='project'` (a lesson: proposed, a person keeps it) | everyone, once kept |
| A person corrected you, or said how they want it ("do not touch X", "answer in Vietnamese", "always attach a screenshot") | `scope='role'` (or `'project'` if it is for everyone) with `kind='feedback'` | as above, read first |

Your notes and the ticket's are in your prompt (with their ids, `[mem_…]`); `knowledge(action='memory')` reads them all,
with the project's instructions and lessons.

## When to write (without being asked)
- **A person corrects you or states a preference**: save it before you carry on. The same correction twice is the
  worst outcome.
- **Something cost you more than one attempt** (a command that hangs, a test that needs a flag, a path that moved):
  save the working way once it works.
- **You found where something is** after searching for it.
- **You stop with work left on a ticket**: a ticket note with where you stopped and what is next.
- **A note in your prompt turned out wrong or out of date**: replace it (`note_id=mem_…` with the new text) or
  `forget` it. A wrong memory is worse than none.

## How to write one
- **One fact, one or two sentences, with its reason**, concrete enough to act on:
  good: "Run the UI tests with `npm test -- --run`: plain `npm test` watches and the run never ends."
  bad: "Be careful with tests."
- **Name the exact place**: the file path, the command, the setting. A person may check it; the board flags a note
  whose file is gone.
- **Never**: secrets, tokens, personal data; a diary of what you did today (that is the work log); what the ticket or
  the instructions already say; guesses you did not check.
- **Keep it small**: each memory is capped. When it is full, replace or forget the least useful note instead of
  squeezing in another.

## Feedback from a person
When a comment, an answer or a review sends your work back, read it for the rule behind it, not only the fix. "The
button should be green" is a fix; "use the project's colour tokens, never hex values" is the rule worth keeping.
Save the rule with `kind='feedback'`, then do the fix. Say in your report what you saved.
