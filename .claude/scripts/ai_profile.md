# ai_profile.py

Run several accounts of the same AI CLI side by side. Each account is a profile with its own login, so
two processes can use two accounts at the same time. Python 3.9+, standard library only.

```bash
.claude/scripts/ai_profile.py claude new work
.claude/scripts/ai_profile.py claude login work            # opens the browser; pick the right account
.claude/scripts/ai_profile.py claude status work
.claude/scripts/ai_profile.py claude run work -p "..."     # anything after the name goes to the CLI
.claude/scripts/ai_profile.py list                         # every profile of every CLI
```

`<cli>` is `agy`, `claude`, `codex` or `opencode`. Commands: `new`, `login`, `run`, `status`, `list`, `rm [-y]`.

| CLI | What makes a profile separate | Profiles live in |
| --- | --- | --- |
| `agy` (Antigravity) | its own `HOME`. `agy` tries the OS keychain first (on macOS one entry per user: service `gemini`, account `antigravity`). Under a swapped `HOME` it finds no keychain and keeps the login in a file inside the profile, `.gemini/antigravity-cli/antigravity-oauth-token` (mode `0600`) | `~/.agy-profiles/<name>/home` |
| `claude` | its own `CLAUDE_CONFIG_DIR` (the documented way to keep several logins) | `~/.claude-profiles/<name>` |
| `codex` | its own `CODEX_HOME`, with `cli_auth_credentials_store = "file"` written into the profile's `config.toml`, so the login is a file in the profile and not a shared OS keyring entry | `~/.codex-profiles/<name>` |
| `opencode` | its own `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME` | `~/.opencode-profiles/<name>` |

Override the root with `<CLI>_PROFILES_HOME` (for example `CLAUDE_PROFILES_HOME`) and the binary with
`<CLI>_BIN`.

## How it works

A profile is a directory. Running a CLI "as" a profile starts it with an environment that points its config and
login at that directory, so profiles never share a login and can run at the same time. The caller's own
environment (PATH, proxies, working directory) is kept; only the variables in the table above are changed, and a
few that would override the login are removed (see "Things to know").

In the code, each CLI is a `Profile` subclass in `ai_profile.py`:

| Method | Says |
| --- | --- |
| `env()` / `dropped_env()` | which variables to set / remove |
| `create()` | what `new` builds in the profile directory |
| `prepare()` | what must be true before each use (for `codex`: credentials go to a file; for an old `agy` profile: its keychain is unlocked) |
| `login_argv()` / `login_cwd()` | the command, and folder, that sign in |
| `status()` | whether the profile is signed in, as one line |
| `forget()` | what to remove outside the directory on `rm` (for `claude`: its keychain entry) |

To add another CLI: write a subclass, set its `cli` name, add it to `PROFILE_CLASSES` and `CLIS`, then check by hand
that two profiles answer at the same time and that `rm` leaves nothing behind. `status()` is the only method you
must write (the class is abstract, so Python refuses to create a subclass without it); the rest have defaults.

## What was tested

On macOS (agy 1.4.12, claude 2.1.316, codex 0.166.0, opencode 1.19.5), and on Linux (x86_64, Python 3.13, the same
agy, codex and opencode versions) in a container with no desktop keyring. WSL and Windows are **not tested**.

On Linux:

- `claude`: two logins (two accounts) in two profiles, each with its own `.credentials.json` (mode `0600`) inside
  `CLAUDE_CONFIG_DIR`; both answered at the same time.
- `codex`: `login --device-auth` signed in; the login is `auth.json` in the profile; `status` and a prompt worked.
- `agy`: the Google login ended up as the file `.gemini/antigravity-cli/antigravity-oauth-token` (mode `0600`) in the
  profile's `HOME`, and `agy -p` answered. Nothing was written outside the profile. The container had no desktop
  keyring and no `DBUS_SESSION_BUS_ADDRESS`, so a Linux desktop where agy can reach a keyring over D-Bus is **not
  tested**.
- `opencode`: `new` and `status` work and its data stays inside the profile. A prompt to a free model was not
  verified: the server answered "Free usage limit reached".

Not tested, from the vendors' docs:

- `claude`: credentials are `%USERPROFILE%\.claude\.credentials.json` on Windows, kept under `CLAUDE_CONFIG_DIR` when
  it is set, so this should work there.
- `codex`: with the file store above it should work on any system.
- `opencode`: data lives under `%USERPROFILE%\.local\share\opencode` on Windows; whether it honours `XDG_*` on
  Windows is not confirmed.
- `agy`: on macOS and on Linux without a keyring, with no keychain under the swapped `HOME`, the Google login ends up
  as a file in the profile (the binary has a "falling back to file-based secret storage" path). The script removes
  `DBUS_SESSION_BUS_ADDRESS` so that a desktop keyring is not used, but a systemd user bus may still be found.
  **Not supported on Windows**: the Windows credential store belongs to the Windows user, not to `HOME`, so profiles
  might share one login; `new` refuses there.

## Things to know

- `claude` runs without `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY`: they outrank a
  saved login and would hide the profile's account.
- `agy` profiles made by an earlier version have a keychain of their own inside the profile. They keep working: the
  script unlocks that keychain before each use. New profiles have none.
- `agy` runs with `AGY_CLI_DISABLE_AUTO_UPDATE=1` inside a profile, and with the real `.gitconfig`, `.ssh` and
  `.config/gh` made visible. Other config (MCP servers, skills, `GEMINI.md`) is not shared: each profile starts empty.
- In non-interactive mode (`-p`) `agy` denies any tool that needs a permission prompt. Give it a prompt that
  needs no tool, or add an allow rule to the profile's `settings.json`.
- opencode's free models (`opencode/*-free`) need no login. Some of them may use prompts to improve the model,
  so keep personal or confidential data out of them; check opencode's Zen docs for each model's policy.
- Tokens never overwrite your normal login. `agy`, `codex` and `opencode` keep theirs in a file inside the profile
  (mode `0600`, readable by any program running as you, so keep `~/.*-profiles` out of backups and synced folders),
  and `claude` in your login keychain under its own entry
  (`Claude Code-credentials-<hash of the profile path>`). `rm` deletes them; for `claude` it logs the profile out first.
- Using more than one account of a service must stay within that service's terms.
