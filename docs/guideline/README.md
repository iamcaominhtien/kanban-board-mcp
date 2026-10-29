# Guidelines

User guides that ship with the repository. Each guide keeps its source next to the PDF, so updating one is
"edit text, run one command".

| Guide | Language | PDF |
| --- | --- | --- |
| Using AI in Kanban Board: setup, writing prompts, assigning work, schedules, safety, troubleshooting | Vietnamese | [`ai/huong-dan-dung-ai.pdf`](ai/huong-dan-dung-ai.pdf) |

## Updating the AI guideline

Everything is in [`ai/`](ai/):

- `build.py`: the text (sections 1 to 12, prompt samples, tables), the layout (CSS) and the build.
- `images/`: the screenshots. `build.py` refers to them by file name, for example `fig("t01-settings-ai", "caption")`.
- `print_pdf.js`: prints the HTML to PDF with Chromium.
- `huong-dan-dung-ai.pdf`: the result. Commit it together with the source.

**Change the text.** Edit `ai/build.py`. Prompt samples are constants at the top (`PERSONA_DEV`, `TICKET_GOOD`, `STYLE_GUIDE`, …);
sections are the `p1` … `p12` blocks lower down. The app's UI is in English, so button and page names stay English in `<b>…</b>`;
the explanation is Vietnamese. Persona and style-guide samples are length-checked against the app's 1000 character limit.

**Change a screenshot.** Replace `ai/images/<name>.jpg` with a new image of the same name (JPEG, about 1500 px wide, quality
80; a `.png` with the same name works when there is no `.jpg`). The existing ones were taken at 1440×900, device scale 1.5,
on a demo project with a Claude Code member; the app's `?settings=ai` style URLs open a given Settings page directly.

**Build.**

```bash
cd docs/guideline/ai
python3 build.py        # writes huong-dan-dung-ai.pdf
```

It needs Python 3, Node and Playwright with Chromium (`npm i playwright && npx playwright install chromium`). The version on the
cover and in the footer is read from `server/version.py`, so rebuild when the app version changes. Look at the pages after a
build (for example `pdftoppm -r 60 -png huong-dan-dung-ai.pdf page`): tables and figures flow across pages, so a longer
paragraph can leave a short last page.

## Facts to re-check when the code changes

The guide states some facts that come from the code. When one of these changes, update the matching part of `ai/build.py`.

| Fact in the guide | Where it comes from |
| --- | --- |
| Permission table (Developer, Reviewer, Read only, Custom) and "delete needs approval" | `server/services/ai/permissions.py` (`TEMPLATES`, `LOCKS`) |
| Default CLI allow and deny rules (what a Claude Code member may run) | `server/services/ai/providers.py` (`allow_rules`, `deny_rules`) |
| Defaults: 2 parallel runs, 20 runs a day, $5 daily budget, ceiling Review, persona up to 1000 characters | `server/services/ai/members.py` |
| Models offered (Sonnet, Haiku for Claude Code) and the adapters | `server/services/ai/providers.py` |
| Where things are in Settings (AI, Board assistant, Diagnostics) and the Board AI switches | `ui/src/components/settings/settingsIndex.ts`, `ui/src/components/assist/AssistSettings.tsx` |
| Working-folder rule and `KANBAN_AI_ROOTS` | `server/services/ai/paths.py` |
| Schedule editor sections and "Done when" checks | `ui/src/components/schedules/ScheduleEditor.tsx` |
| Assign dialog choices (Start now, Queue, Assign without running) and mention intents | `ui/src/components/ai/AssigneePicker.tsx`, `MentionIntent.tsx` |
