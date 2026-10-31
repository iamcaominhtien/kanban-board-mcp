# AI accounts: several logins of the same AI CLI, and the designer brief

Draft, 2026-10-31. Context: today an AI member that runs on the person's computer uses whatever login its CLI already
has (one per CLI per user). This adds **AI accounts**: separate logins of the same CLI that can run at the same time,
so one lead AI can hand work to members that each use a different account. The first step, a developer script that
proves the idea, is `.claude/scripts/ai_profile.py` (see `.claude/scripts/ai_profile.md`). Existing designs this builds
on: `design/screens/ai-members.md`, `design/screens/ai-provider-config.md`, `design/screens/ai-safety-cost.md`,
`design/components/ai-ticket-work.md`; technical notes: `docs/specs/ai-members.md`.

## Decisions already taken

1. **Keep what exists.** An AI member can still use the CLI's own login ("my CLI as it is") or an API key. Nothing
   changes for them.
2. **An account is its own thing, not part of a member.** There is a list of AI accounts (for example "Claude Max",
   "Claude Pro", "Codex"). A member picks one from the list. Several members can pick the same account; the login is
   made once; when it expires, fixing it once fixes every member that uses it.
3. **Signing in is a human step.** An AI that calls the board through MCP can list accounts, see whether each is
   signed in and assign a member to one, but cannot sign in. A signed-out account makes a run fail with "needs
   sign-in" and sends the person a notification.
4. **The sign-in happens in a real terminal inside the app** (a terminal pane), because each CLI asks things in its
   own way. Desktop only, like the other local runners (the web build cannot start a CLI on the person's computer).
5. **One pull request** carries the script, the server, the UI and this document.

## What a sign-in looks like in the CLI

Seen in a terminal for `agy`; for `claude` and `codex` taken from their documentation and `--help` (not run end to end):

| CLI | Steps | Notes |
| --- | --- | --- |
| `agy` (Antigravity) | choose a method (1 Google OAuth, 2 a Google Cloud project) with the arrow keys and Enter; a browser opens; sign in; the page shows a code; paste it into the terminal; then a few options to confirm | needs typing, arrow keys and pasting |
| `claude` | `claude auth login --claudeai`: a browser opens; if the browser shows a code instead of coming back, paste it at the prompt | |
| `codex` | `codex login`: a browser opens; `codex login --device-auth` is an option for sign-in without a local browser callback (its help gives no description; assumed to show a link and a code to enter in the browser) | the device-auth behaviour is not run yet |
| `opencode` | `opencode auth login` (its free models need no login at all) | |

Not known yet: whether the options `agy` shows after signing in can be skipped, and whether leaving them unanswered
stops it from running headless. This needs a quick test before the sign-in screen is final.

## What exists in the UI today

- **Add AI member**, four steps: type, connect, identity and limits, permissions and review. In step 2, for a local
  runner, the board looks for the CLI and shows its path, version and "Signed in as", then asks for a working folder
  and a model. A note says the login token stays in the CLI's own keychain.
- **Settings → Board AI**: pick which AI member is the Board AI.
- **Members page and member profile** with a health chip (`ok`, `not_logged_in`, `runner_missing`, `rate_limited`, ...).
- Types today: Claude Code, Antigravity (listed, but "no headless mode": it only gets work through MCP), Anthropic,
  OpenAI, Gemini, Custom (API key) and Other MCP client.

## What to design

Please keep the look of the existing AI screens (the Add AI member modal and stepper, `ai-card`, `ai-chip`).

1. **AI accounts list** (a tab or section next to the AI members; the designer chooses the place). One row per
   account: name, CLI, "signed in as" (email and plan when the CLI reports them), status chip, number of members using
   it, actions (sign in again, rename, remove). Group or filter by CLI. Empty state ("No accounts yet"). Removing an
   account that members use: say which, and ask what happens to them.
2. **Add account**: choose the CLI → name it → sign in. A short stepper in the style of Add AI member.
3. **Sign-in panel with a terminal** (the main new screen).
   - A terminal pane where the CLI runs for real. Keyboard goes to the terminal; Esc must still be able to leave the
     panel (think about focus). Links printed in the terminal should be clickable (open in the browser) and copyable.
   - A side area, outside the terminal, that says in plain words what the person is expected to do now and updates
     with the CLI: "Starting…", "Choose how to sign in", "Finish in your browser", "Paste the code from the browser"
     (with a Paste button, because pasting into a terminal is awkward), "Signed in as …".
   - States: starting, waiting for you, signed in (detected by the board; Done button), failed or timed out (Try
     again), terminal closed early, cancelled. The CLI may take a while; the panel must not look stuck.
   - A line on where the login is kept: a file inside the account's folder (readable by programs running as the
     person), not the system keychain; Claude on macOS is the exception, it uses the keychain. Plain wording, no scare.
4. **Add AI member, step 2**: an account picker above the working folder. Choices: "My CLI as it is (current
   behaviour)", each account of this CLI, "Add account…" (opens 3). "Signed in as" shows the chosen account. A
   signed-out account shows an inline Sign in action.
5. **Step 1 type cards**: new local types Codex and opencode, and Antigravity now runnable (remove the "no headless
   mode" warning). Each needs its glyph and colour, install steps and models. opencode's free models need a visible
   note: some of them may use prompts to improve the model, so keep confidential data out of them.
6. **Member profile and members page**: which account the member uses; the signed-out state with a Sign in action;
   change account.
7. **Shared account hint**: when several members use one account, say so ("3 members share this account and its
   limits"), since they share its rate limits.
8. **Run blocked by a signed-out account**: the run panel and the Inbox show "needs sign-in" with an action, not a
   generic failure.
9. **Copy to fix**: "the login token stays in the CLI's own keychain" is no longer true for every account.

Out of scope: API-key members, the permission model, budgets, schedules.

## Questions for the designer and product

- Where does the accounts list live (Settings, the AI members page, both)?
- Terminal as a modal, a side panel or a full page? Is a terminal wanted at all for first use, or only as a fallback
  when the guided steps are not enough?
- Is a usage indicator per account wanted (runs today, last rate limit)? The board already tracks rate limits per member.

## Build notes (for the developer)

- Server module `server/services/ai/profiles.py`, **standard library only**, next to `cli.py`: profile folders, the
  environment each CLI needs, login and status commands. `ai_profile.py` shrinks to a thin front that calls it, so
  the logic lives in one place. The env variables per CLI are in `.claude/scripts/ai_profile.md`.
- Data: an `ai_account` table (cli, name, folder, last status, label) and `ai_member.account_id` (null = the CLI's own
  login). The server starts the CLI of a run with that account's environment (today: `child_env()` in `cli.py`).
- Terminal: a pseudo-terminal on the server (`pty` on macOS and Linux; Windows needs ConPTY, which has to be checked),
  streamed over a WebSocket to a terminal component (xterm.js) in the UI. The app has no terminal or pty dependency yet.
- Status: poll the CLI's own status command until it says signed in; do not read the token.
- MCP: read-only tools (list accounts, status) plus assigning a member to an account; no sign-in tool.
- `agy` runs: `-p` with `--output-format stream-json` exists, so Antigravity can become a runner like Claude Code,
  with its own output parser.
- Order: server module and tests; data and API; MCP tools; UI once the designs are in.
