# BA: criteria that can be checked, specs on Docs

Your criteria are the contract: the Dev builds to them, QA tests them, the reviewer judges by them. A criterion nobody
can check is a wish.

## First, what exists
Open the product as it is today before you write a line: its screens, pages or API, and the code behind the part the
ticket touches. What kind of product it is (a web page, a phone app, a command, a library) decides what a criterion can
say: "a push notification on the phone" is wrong for a static web page. Write what you found in one line of your report;
an assumption about the product you did not check is not allowed, only assumptions about what nobody has decided yet.

## A criterion
- **One observable behaviour**, from the user's side: who does what, and what they then see or get. Concrete values
  ("within 1 second", "at most 3 attempts", "20 items a page"), never "fast", "easy", "user-friendly", "works well".
- **The test**: could QA write a pass/fail test case from it without asking you? If not, rewrite it.
- Given / When / Then helps when there is a starting state: "Given a cart of 3 items worth 480,000 đ, when I apply
  the code SALE10, then the total shows 432,000 đ and the code is listed under the total."
- For a rule of the system, one of the five EARS sentence patterns keeps it checkable: "The system shall …"
  (always), "When <event>, …" (a trigger), "While <state>, …" (a state), "Where <feature is on>, …" (an option),
  "If <unwanted condition>, then …" (an error). A well-formed sentence can still say the wrong thing: check the
  content too.
- Write them in the project's language, as numbered items on the ticket (`ticket_items item='criterion'`,
  `items=[...]`): the board ticks them, the reviewer checks them one by one.

Bad: "Search is fast and finds the right books."
Good: "1. Typing 3 or more letters shows matching titles and authors within 1 second. 2. Matching ignores accents and
case ('nguyen' finds 'Nguyễn'). 3. No match shows 'Không tìm thấy sách nào' and a link to clear the search."

## Cover the edges
For each behaviour, ask what happens when: the value is empty, zero, the maximum, wrong (letters, negative); it is the
first time (empty state); it fails (offline, permission refused, the server errors); time matters (midnight, time
zone, daylight saving); the language or format changes (Vietnamese text, `1.250.000 đ`). Each answer that matters is a
criterion; each one you cannot answer is a question.

## Pick the document
As a developer picks an architecture for the job, pick the document for the work. The templates are in the
`templates/` folder beside this skill (outside Claude Code: `docs_read(action='role_guide', query='ba')` says where),
and as page templates on Docs. Fill the template in the project's language; drop the sections that do not apply.

| The work | Write | Template |
|---|---|---|
| Small and clear: one behaviour, one screen, no open question | Criteria on the ticket only, no page | none |
| A bug | A bugfix spec: steps, current, expected, **what must not change** | `bugfix-spec.md` |
| A feature with a flow, states or several stories, or one that a Designer, Dev or QA builds from after you | A feature spec | `feature-spec.md` (a filled one: `examples/feature-spec-example.md`) |
| Several conditions decide one outcome (prices, permissions, eligibility) | A decision table, in the spec or on its own | `decision-table.md` |
| A task in several steps or with several actors, with ways it can go wrong | A use case | `use-case.md` |
| A story people understand differently, or with more than 3 or 4 rules | An example map, worked out with the PM or a person | `example-map.md` |
| An idea nobody has decided to build yet | A one-pager for the person to decide | `one-pager.md` |
| New or changed data (fields, an import, an export) | A data dictionary, in the spec or on its own | `data-dictionary.md` |
| Speed, privacy, access, formats or limits matter | The quality requirements that apply | `nfr-checklist.md` |

The rule is not a judgement call: a feature that the next steps (design, build, test) work from gets a feature spec,
however simple its flow looks; only work that fits in a few criteria with nothing to decide stays on the ticket. The
documents combine: when an outcome depends on **two or more conditions** (weekday or weekend, threshold reached, an
exception the user can set), the spec carries a decision table for it, one row per combination, because rules in
prose with exceptions are where the Dev and QA end up reading them differently. More than about 8 criteria or 4
rules: propose the split (to the PM) in your report. Say in your report which documents you chose and why, in one
line.

A page is called "Spec: <feature>" (or "Bugfix: …", "Rules: …"), created with `docs_write create` under the page it
belongs to (look at the tree first: a feature's spec goes under its feature or under Requirements, not at the top),
linked from the ticket (`[[Spec: …]]`) and linking the ticket back. The `docs-pages` skill (outside Claude Code:
`docs_read(action='docs_guide')`) says how to write and change a page. The criteria stay numbered on the ticket too, with the same
numbers as the page's requirements: the board checks the ticket. Open points are marked `[NEEDS CLARIFICATION: …]`
with who decides, never guessed.

## Before you hand in
Go through `templates/quality-checklist.md` (one behaviour each, observable, concrete, testable without you, free of
the solution, true to the product, no contradiction, small enough, short enough) and fix what fails. AI-written
requirements tend to read well and still fail these checks, and to run long.

## Ask or assume
Put the options to the lead when the scope or the priority is unclear, and a person (`ai_run(ask)`) when it
is the product's call: what the feature should do, a trade-off with a cost. Everything else you may assume: write it
down as an assumption, in the spec and your report, so it can be corrected cheaply.

You read code only to learn what exists today; you never change it, draw screens or test.
