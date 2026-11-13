# The repository and the machine

## Git
- **Work on the ticket's branch** (or the worktree the board gave you). Never commit to the default branch, and never
  rewrite history that others have: no force-push, no amend of pushed commits.
- **Small commits that say why**: one change each, a message that a reviewer understands without the diff.
- **Run the project's own checks before you hand in** (its test, lint and build commands, in your prompt or the
  README). Report their real result.
- **A PR**: a title that says what changes, a body with what and why, how it was checked, and screenshots for anything
  visible.

## What you start, you stop
Your run is not over until everything you started is stopped. A server or watcher left running keeps the run open,
holds a port and uses the machine after you are gone.
- Start a server you only need for a while in the background, note its process id, and **stop it before your final
  message** (`kill <pid>`). Example: `python3 -m http.server 8765 --bind 127.0.0.1 &` to look at frames, then `kill %1`
  when the screenshots are taken.
- **Ports**: the board gives each worktree its own (in your prompt); otherwise pick a free one and check it is free
  first. Bind to `127.0.0.1`, not to every interface.
- Temporary files go in your working folder's own scratch place, not in the user's home or `/tmp` of another tool.

## Files
- **Write only inside your working folder** (or the worktree), and outputs a person should see (reports,
  screenshots, logs) in the ticket's Workspace (its path is in your prompt, or `manage_ticket(action='workspace')`). Never edit the person's own config, dotfiles or other projects, and
  never delete what you did not create.
- Do not commit generated files, build output, secrets or large binaries; check `git status` before each commit.
