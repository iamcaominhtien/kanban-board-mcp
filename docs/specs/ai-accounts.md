# AI accounts: several logins of the same AI CLI

Version 3.16.0. Context: an AI member that runs on the person's computer used whatever login its CLI already had (one
per CLI per user). An **AI account** is a separate login of the same CLI. Several can run at the same time, and several
AI members can share one. Design: `design/screens/ai-accounts.md`. Related: `design/screens/ai-members.md`,
`docs/specs/ai-members.md`. The developer script that proved the idea is `.claude/scripts/ai_profile.py`
(see `.claude/scripts/ai_profile.md`); the server uses the same module, `server/services/ai/profiles.py`.

## Decisions

1. **Keep what exists.** An AI member can still use the CLI's own login ("the login already on this computer", the
   default) or an API key. Nothing changes for them.
2. **An account is its own thing, not part of a member.** A member picks one from the list; several members can pick the
   same account. When the login expires, fixing it once fixes every member on it.
3. **Signing in is a human step.** An AI that calls the board through MCP can list accounts and assign a member to one,
   but cannot sign in, sign out, rename or remove. A signed-out account holds its members' runs ("Account X needs
   sign-in") and the run that was going fails with "Account signed out".
4. **The sign-in happens in a real terminal inside the app** (a pseudo-terminal on the server, shown with xterm.js),
   because each CLI asks in its own way. Desktop only, like the other local runners: every route that changes an account
   needs the request to come from this computer. Where no pseudo-terminal exists (Windows), the window shows the command
   to run in the person's own terminal and polls the CLI until it reports signed in.
5. **One pull request** carries the script, the server, the UI and this document.

## How it works

| Piece | Where |
| --- | --- |
| What each CLI needs to keep a login apart (environment variables, status command, sign-out) | `server/services/ai/profiles.py` (standard library only) |
| Accounts: create, check, rename, sign out, remove, assign, per-account members | `server/services/ai/accounts.py` |
| Sign-in terminal: PTY, output kept in memory only, status polling every 3 s, reading the screen for the status bar | `server/services/ai/signin.py` |
| REST and the terminal WebSocket | `server/api/ai_accounts.py` |
| Data | table `ai_account`, column `ai_member.account_id` (null = the login already on this computer) |
| MCP | `ai_team` actions `accounts` (read) and `assign_account` |

- **Folders.** `~/.kanban-board/ai-accounts/<slug>` (override with `KANBAN_AI_ACCOUNTS_HOME`). Outside the data folder, so
  it is not synced with it. Removing an account deletes the folder; for Claude Code on macOS it first logs the account
  out, which removes its keychain entry.
- **Running as an account.** The CLI of a run starts with the account's environment: `CLAUDE_CONFIG_DIR` for Claude Code
  (sessions are resumed from that folder), `HOME` for Antigravity, `CODEX_HOME` for Codex, the `XDG_*` folders for
  opencode. Variables that would override the login (`ANTHROPIC_API_KEY` ...) are removed for Claude Code.
- **Status.** Asked of the CLI, never read from a token file: `claude auth status --json` (email and plan),
  `codex login status`, `agy models`, `opencode auth list`. On opening the page, every few minutes (four) by the health
  sweep, when a person clicks Check now, and when a run fails with a sign-in error. The account goes to *needs sign-in*
  once, with how it was found, and every member on it follows.
- **Who is signed in.** Only Claude Code says (email, plan). For the others the account shows its method and the name the
  person gave it, so two accounts of the same login cannot be told apart there. Claude Code duplicates are noticed.
- **Safety of the terminal.** Only a request from this computer can open it; the WebSocket also refuses pages of other
  websites (origin check). There is no tool or route an AI member can use. Output is kept in memory so a window can attach
  again and is never logged or stored; closing the window or stopping the board stops the CLI.

## Codex, opencode and Antigravity runs

Members of these types work a ticket like a Claude Code member (`server/services/ai/adapters.py`; the lifecycle is
the same code in `runs.py`). Each adapter says how to start the CLI headless, how to read its output into steps,
files and a summary (tested on streams captured from the real CLIs, `server/tests/fixtures/real/`), and how to ask
whether it is signed in. By default the board passes no flag that skips a CLI's permission checks. A project owner can turn on **Bypass permissions** for a member (the same setting, confirmation and audit entry as for Claude Code; work runs only, never in Safe mode): Codex then runs with `-s danger-full-access`, opencode allows every command and edit except what a Deny rule stops, and Antigravity gets `--dangerously-skip-permissions` with the Deny rules still passed as `command(...)` deny rules (tested: a denied command is blocked under the flag, and the run goes on). The Deny rules do not apply to Codex.

| | Command | Permissions | Board MCP |
| --- | --- | --- | --- |
| Codex | `codex exec [resume <id>] --json -s <sandbox>` | `read-only` for a question or safe mode, else `workspace-write`; the Allow/Deny tool rules cannot be expressed and are not applied (a first step says so) | `-c mcp_servers.kanban.url` with the token in `KANBAN_RUN_TOKEN` |
| opencode | `opencode run --format json [-s <id>]` | `permission` map in `OPENCODE_CONFIG_CONTENT`: deny everything, then the Allow rules, then the Deny rules; edits denied for a question | the same variable, with the token in the header |
| Antigravity | `agy -p --output-format stream-json --mode accept-edits` (`plan` for a question) | Allow rules as `command(...)` rules in `--settings`, plus read-only commands; the board's MCP and a few folders are allowed | a stdio bridge (`mcp_bridge.py`, entry `mcp_stdio.py --bridge`) named in the account's `mcp_config.json`; it reads the token from the environment of the run |

- The run's token is never on a command line or in a shared file.
- **Antigravity** needs an AI account (its MCP servers live in the account's HOME; without one that file would be the
  person's own). Its headless mode ends the run at the first action that no rule allows: the run then fails with the
  reason instead of finishing empty, and a member that keeps failing is auto-paused as usual. Under Bypass permissions
  there is no such stop. Otherwise the run is told to stay inside the working folder and to use only test commands,
  `ls`, `cat` and `git`. The Allow rules are the way to give it
  more; a pre-approved command set is not a sandbox.
- Codex and Antigravity do not report changed-line counts, so a changed file shows `+0 -0`.
- **Configuration tab.** For these three types the tab shows Rules (put in the prompt of every run), Permissions
  (Allow and Deny rules; Codex has none) and Model & limits. Nothing is written into the working folder and nothing is
  "documented": the earlier steps to paste rules into the Antigravity app are gone. The model list comes from
  `agy models` or `opencode models`. `--effort` is not passed to `agy` (it conflicts with models that carry the level
  in their name). Codex can set `model_auto_compact_token_limit`; Antigravity compacts by itself and opencode has no
  threshold. On macOS an Antigravity account gets a keychain of its own (empty, unlocked before each use) so no
  keychain dialog appears.
- Found by running each one against a live board with the three CLIs on this computer (Codex and Antigravity with an
  account, opencode with a free model): each worked a ticket to Review through the board's MCP tools.

## Not done yet

- **Linux and Windows** were not tried with real logins. The profile approach follows the vendors' documentation; see
  `.claude/scripts/ai_profile.md`. Antigravity accounts are refused on Windows (its login belongs to the Windows user).
  The embedded terminal needs ConPTY on Windows (not built; the fallback command is shown instead). Long prompts on
  Windows go over the command-line limit for the three new CLIs (Claude Code spills them to stdin).
- **Moving an existing login** ("Move to an account") signs in again in the new account's folder; it does not copy the old
  token.
- **Desktop (system) notification** for a signed-out account: the board shows one banner per account and one toast when an
  account goes signed out or comes back; no system notification is sent yet.
- **AI Team › Needs you** card for a signed-out account: that view does not exist in this branch.
