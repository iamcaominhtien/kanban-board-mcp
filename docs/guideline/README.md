# Guidelines

User guides that ship with the repository. Each guide keeps its source next to the PDF, so updating one is
"edit text, run one command".

| Guide | Language | PDF |
| --- | --- | --- |
| **User and administrator guide**: using the app (tickets, Docs, ideas, AI, settings, desktop app) and installing, connecting and administering it (data and backup, configuration, MCP, privacy, troubleshooting), in 7 parts, 25 chapters and 3 appendices, with audience tags | English | built into `guide/dist/` (see below); attached to each release |
| Using AI in Kanban Board: the AI team (PM, Dev, Reviewer, General), creating members step by step, the rest of the setup, copy-paste prompts, assigning work, schedules, safety, troubleshooting | Vietnamese | [`ai/huong-dan-dung-ai.pdf`](ai/huong-dan-dung-ai.pdf) |

## The user and administrator guide

Source in [`guide/`](guide/). One Markdown file per chapter in `guide/chapters/`, built into the full PDF, a web version and stand-alone PDFs. Design: [`design/screens/guideline-design.md`](../../design/screens/guideline-design.md).

```bash
cd docs/guideline/guide
pip install -r requirements.txt     # markdown, pypdf
npm install --no-save playwright && npx playwright install chromium
python3 build.py                    # dist/kanban-board-guide-<version>.pdf, dist/web/, dist/standalone/*.pdf
python3 build.py --release          # what CI runs: chapters marked to-confirm are left out and "to confirm" markers fail the build
python3 build.py --facts            # print the facts read from the code and check the documented environment variables
```

**A chapter** is `guide/chapters/NN-name.md` (the number sets the order and the chapter number). It starts with front matter:

| Key | Meaning |
| --- | --- |
| `title`, `summary`, `reading` | Title, the line under it on the opener, minutes to read |
| `part` | 1 to 7, or `appendix` |
| `audience` | One or more of `everyone`, `admin`, `developer`, `desktop`, `ai` (the tags under the title) |
| `status` | `released` (default), `draft` (left out unless `--drafts`) or `to-confirm` (shown with a banner, left out of `--release`) |
| `kind` | `chapter` (default) or `sheet` (one page, no opener) |
| `standalone` | A name: also build this chapter as a stand-alone PDF |

**In the text.** Plain Markdown, plus: `!!! tip "Title"` (also `note`, `warning`, `caution`, `ai`) for callouts; numbered lists become steps; `++Ctrl+N++` for keys (`Mod` is Ctrl, or ⌘ on a Mac); `{menu:Settings › Updates}` for menu paths; `@figure <image-name> "Caption" markers=x,y;x,y` for a figure with numbered markers (percent positions; the build fails when the image is missing, and the caption is the alt text); `{fact:tool_count}` for a value read from the code; `{confirm: what to check}` for something that must be checked before release; `@preset pm persona` for the text of a built-in AI role; `{{shortcuts}}` and `{{releases}}` for generated tables. Headings level 2 are numbered `chapter.section` and listed on the chapter opener.

**Screenshots** are `guide/images/<name>.jpg` (the AI guide's `ai/images/` are used too). Retake them with `guide/shots/take_screenshots.js` (the header of the script says how to start a demo server); JPEG, 1440 × 900, about 1500 px wide.

**One list of shortcuts.** `ui/src/components/shortcuts/shortcuts.json` feeds the Keyboard Shortcuts window in the app, the shortcut sheet in the guide and a test (`desktop/tests/menu.test.js`) that keeps the desktop menu's accelerators in line. To add or change a shortcut, change the file and the code that handles the key (each entry names its `source`).

**Facts from code.** `guide/facts.py` reads values from the code (the number and names of MCP tools, AI defaults, ticket statuses, types and priorities, settings pages, the documented environment variables). A chapter uses `{fact:name}`, so the text follows the code; `python3 build.py --facts` lists every fact with its source and fails when a documented variable no longer exists in the code. A statement that cannot be read from the code and has not been checked gets a `{confirm: …}` marker; a chapter with `status: to-confirm` (today the privacy chapter) is not released.

**Publishing.** The release workflow builds the guide and attaches the full PDF and the stand-alone PDFs to the GitHub release (a problem in that job never blocks the installers). The PDF is not committed.

### Facts to re-check in the guide

| Fact | Where it comes from |
| --- | --- |
| Number and names of MCP tools, the Idea Space tools | `server/kanban_mcp/tools/__init__.py`, `registry.py` (read by `facts.py`) |
| AI defaults (parallel runs, runs per day, daily budget) | `server/services/ai/members.py` (read by `facts.py`) |
| Statuses, types, priorities | `server/models.py` (read by `facts.py`) |
| Settings pages and their scope | `ui/src/components/settings/settingsIndex.ts` (read by `facts.py`) |
| Menu items, accelerators, which items need the backend | `desktop/menu.js` (tested in `desktop/tests/menu.test.js`) |
| The built-in AI roles | `ui/src/components/ai/memberPresets.json` (read through `@preset`) |
| Docs, Sketch, Idea Space and editor shortcuts and limits stated in prose | `shortcuts.json` entries name their `source`; limits come from `CHANGELOG.md` and `docs/specs/` and are re-read when the feature changes |
| What an AI request contains (privacy chapter) | `server/services/ai/` (to confirm) |

## Updating the AI guideline (Vietnamese)

Everything is in [`ai/`](ai/):

- `build.py`: the text (sections 1 to 12, prompt samples, tables), the layout (CSS) and the build.
- `images/`: the screenshots. `build.py` refers to them by file name, for example `fig("t01-settings-ai", "caption")`.
- `print_pdf.js`: prints the HTML to PDF with Chromium.
- `huong-dan-dung-ai.pdf`: the result. Commit it together with the source.

**Change the text.** Edit `ai/build.py`. Prompt samples are constants near the top (`PERSONA_PM`, `PERSONA_DEV`, `INSTR_REVIEWER`, `STYLE_GUIDE`, `TICKET_GOOD`, …);
sections are the `p1` … `p_prompts` … `p12` blocks lower down, in reading order (1 prepare, 2 the team, 3 create members, 4 the rest of the setup, 5 prompts to copy, 6 to 13 how it works, safety, troubleshooting, checklist). The app's UI is in English, so button and page names stay English in `<b>…</b>`;
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
| What the Add AI member dialog asks (steps, fields, no template choice; the Role template is chosen later on the Permissions tab) | `ui/src/components/ai/AddAiMemberModal.tsx`, `AiPermissionsTab.tsx` |
| The first AI member of a project becomes its Board AI; "Currently not chosen" | `server/services/ai/members.py` (`board_ai_id`), `ui/src/components/ai/AiSettingsSection.tsx` |
| What a work run and the Board AI pass to the CLI (what the folder's `CLAUDE.md` and `.claude/` can affect) | `server/services/ai/cli.py` (`build_args`), `server/services/ai/llm.py` |
| What the board writes into the folder (`CLAUDE.md` block, `.mcp.json`, `.claude/settings.json`) | `server/services/ai/config_sync.py` |
| One AI member in several projects: what is shared, Scope | `server/services/ai/multiproject.py`, `ui/src/components/ai/ProjectsPicker.tsx` |
| Schedule editor sections and "Done when" checks | `ui/src/components/schedules/ScheduleEditor.tsx` |
| Assign dialog choices (Start now, Queue, Assign without running) and mention intents | `ui/src/components/ai/AssigneePicker.tsx`, `MentionIntent.tsx` |
| The Board AI proposing AI members (what it may propose, who approves, the stand-in AI) | `server/services/ai/assist/member_drafts.py`, `assist/prompts.py` (`CHAT_FORMAT`), `assist/settings.py` (`fallback_ai`), `ui/src/components/assist/DraftAiMembers.tsx` |
| The PM, Dev and Reviewer personas, limits and CLI rules (the "Start from" row of the Add dialog) | `ui/src/components/ai/memberPresets.json` (`build.py` reads the Vietnamese personas from it) |
| Which runs the run limits count (scheduled and AI-started only), their defaults (15 per ticket, 100 per board) | `server/services/ai/budget.py`, `runs.py` (`create_run`), `server/models.py` |
| One session per AI and ticket, the "Activity since your last run" block, Auto-compact (default 60%) | `server/services/ai/runs.py` (`_session_for`, `_activity_for`), `context.py`, `cli.py` (`child_env`), `assist/chat.py` |
