# ai-profile.sh

Run several accounts of the same AI CLI side by side. Each account is a profile with its own login, so
two processes can use two accounts at the same time.

```bash
.claude/scripts/ai-profile.sh claude new work
.claude/scripts/ai-profile.sh claude login work            # opens the browser; pick the right account
.claude/scripts/ai-profile.sh claude status work
.claude/scripts/ai-profile.sh claude run work -p "..."     # anything after the name goes to the CLI
.claude/scripts/ai-profile.sh list                         # every profile of every CLI
```

`<cli>` is `agy`, `claude`, `codex` or `opencode`. Commands: `new`, `login`, `run`, `status`, `list`, `rm`.

| CLI | What makes a profile separate | Profiles live in |
| --- | --- | --- |
| `agy` (Antigravity) | its own `HOME`, plus a login keychain inside it. `agy` keeps one Keychain entry per user (service `gemini`, account `antigravity`), so a plain `HOME` swap is not enough on macOS | `~/.agy-profiles/<name>/home` |
| `claude` | its own `CLAUDE_CONFIG_DIR` | `~/.claude-profiles/<name>` |
| `codex` | its own `CODEX_HOME` | `~/.codex-profiles/<name>` |
| `opencode` | its own `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME` | `~/.opencode-profiles/<name>` |

Override the root with `<CLI>_PROFILES_HOME` (for example `CLAUDE_PROFILES_HOME`) and the binary with
`<CLI>_BIN`.

## Things to know

- `agy` profiles work on macOS only; Linux and Windows need another keyring approach.
- `agy` runs with `AGY_CLI_DISABLE_AUTO_UPDATE=1` inside a profile, and with the real `.gitconfig`,
  `.ssh` and `.config/gh` made visible. Other config (MCP servers, skills, `GEMINI.md`) is not shared:
  each profile starts empty.
- In non-interactive mode (`-p`) `agy` denies any tool that needs a permission prompt. Give it a prompt that
  needs no tool, or add an allow rule to the profile's `settings.json`.
- opencode's free models (`opencode/*-free`) need no login. Some of them may use prompts to improve the model,
  so keep personal or confidential data out of them; check opencode's Zen docs for each model's policy.
- Tokens never overwrite your normal login. `agy` keeps its token in the profile's own keychain, `codex` and
  `opencode` in a file inside the profile, and `claude` in your login keychain under its own entry
  (`Claude Code-credentials-<hash of the profile path>`). `rm` deletes them; for `claude` it logs the profile out first.
- Using more than one account of a service must stay within that service's terms.
