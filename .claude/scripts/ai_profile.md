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
| `agy` (Antigravity) | its own `HOME`, plus a login keychain inside it. `agy` keeps one Keychain entry per user (service `gemini`, account `antigravity`), so a plain `HOME` swap is not enough on macOS | `~/.agy-profiles/<name>/home` |
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
| `prepare()` | what must be true before each use (for `agy`: the keychain is unlocked; for `codex`: credentials go to a file) |
| `login_argv()` / `login_cwd()` | the command, and folder, that sign in |
| `status()` | whether the profile is signed in, as one line |
| `forget()` | what to remove outside the directory on `rm` (for `claude`: its keychain entry) |

To add another CLI: write a subclass, set its `cli` name, add it to `PROFILE_CLASSES` and `CLIS`, then check by hand
that two profiles answer at the same time and that `rm` leaves nothing behind. `status()` is the only method you
must write (the class is abstract, so Python refuses to create a subclass without it); the rest have defaults.

## What was tested

Only on macOS (agy 1.4.12, claude 2.1.316, codex 0.166.0, opencode 1.19.5). Linux, WSL and Windows are
**not tested**. From the vendors' docs:

- `claude`: credentials are `~/.claude/.credentials.json` on Linux and `%USERPROFILE%\.claude\.credentials.json` on
  Windows, kept under `CLAUDE_CONFIG_DIR` when it is set, so this should work there.
- `codex`: with the file store above it should work on any system.
- `opencode`: data lives under `~/.local/share/opencode` (`%USERPROFILE%\.local\share\opencode` on Windows);
  whether it honours `XDG_*` on Windows is not confirmed.
- `agy`: the macOS keychain approach does not exist elsewhere. Its binary has a file fallback ("OS credential
  manager unavailable; falling back to file-based secret storage"), but whether the Google login uses it is not
  confirmed. `agy new <name> --no-keychain` creates a profile without a keychain to try that (experimental).

## Things to know

- `claude` runs without `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY`: they outrank a
  saved login and would hide the profile's account.
- `agy` runs with `AGY_CLI_DISABLE_AUTO_UPDATE=1` inside a profile, and with the real `.gitconfig`, `.ssh` and
  `.config/gh` made visible. Other config (MCP servers, skills, `GEMINI.md`) is not shared: each profile starts empty.
- In non-interactive mode (`-p`) `agy` denies any tool that needs a permission prompt. Give it a prompt that
  needs no tool, or add an allow rule to the profile's `settings.json`.
- opencode's free models (`opencode/*-free`) need no login. Some of them may use prompts to improve the model,
  so keep personal or confidential data out of them; check opencode's Zen docs for each model's policy.
- Tokens never overwrite your normal login. `agy` keeps its token in the profile's own keychain, `codex` and
  `opencode` in a file inside the profile, and `claude` in your login keychain under its own entry
  (`Claude Code-credentials-<hash of the profile path>`). `rm` deletes them; for `claude` it logs the profile out first.
- Using more than one account of a service must stay within that service's terms.
