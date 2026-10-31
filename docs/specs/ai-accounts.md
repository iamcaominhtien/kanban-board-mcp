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

## Not done yet

- **Runs for Codex, opencode and Antigravity.** Members of these types can be made and given an account (the design shows a
  *Not ready* chip), but their runs do not start. Each needs a runner like the Claude Code one (headless command, output
  parser, MCP and permission mapping). Antigravity: `agy -p` with `--output-format stream-json` exists.
- **Linux and Windows** were not tried with real logins. The profile approach follows the vendors' documentation; see
  `.claude/scripts/ai_profile.md`. Antigravity accounts are refused on Windows (its login belongs to the Windows user).
  The embedded terminal needs ConPTY on Windows (not built; the fallback command is shown instead).
- **Moving an existing login** ("Move to an account") signs in again in the new account's folder; it does not copy the old
  token.
- **Desktop notification** for a signed-out account: the board shows one banner per account; the system notification is
  not sent yet.
