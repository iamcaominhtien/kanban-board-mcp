//! The board plugin's `PreToolUse` hook (docs/specs/ai-v2.md section 2): the one safety rule of a run that cannot wait
//! for the model to behave. It refuses a `git push --force` to the main branch and a recursive `rm` outside the run's
//! folder (its worktree), and nothing else.
//!
//! The CLI hands the hook the tool call as JSON on stdin. The hook denies by printing the JSON a PreToolUse hook
//! answers with (`permissionDecision: deny` and a reason, which Claude Code shows the model; it carries on with something
//! else) and exits 0. It does not use exit code 2, so a script that fails to parse can never block a tool. Every other
//! outcome, including any error of the script itself, prints nothing and is not a refusal. The run's folder arrives in
//! `KANBAN_WORKTREE`, set by `launch.prepare` next to the run token.
//!
//! The shell script uses only `sed`, `grep`, `tr` and `git`, which exist on macOS and Linux; Windows runs the same rules in
//! PowerShell. Both read a command the way a person reads it, not as a shell does: a `rm` hidden behind `$(...)` or a
//! variable is not seen (the deny rules in `--settings` and the worktree are the other layers).

/// The shell script of the hook (`hook_guard.POSIX`), as it is written to the plugin.
pub const POSIX: &str = r####"#!/bin/sh
# Refuses `git push --force` to the main branch and a recursive `rm` outside the run's folder (AI v2). A refusal is
# the JSON a PreToolUse hook answers with, on exit 0; every other outcome, errors included, is silent exit 0: this
# never stops a run by itself.
input=$(cat 2>/dev/null) || exit 0
case "$input" in *'"Bash"'*) ;; *) exit 0 ;; esac
cmd=$(printf '%s' "$input" | sed -nE 's/.*"command"[[:space:]]*:[[:space:]]*"(([^"\\]|\\.)*)".*/\1/p' | head -n 1 \
  | sed -e 's/\\"/"/g' -e 's/\\n/;/g' -e 's/\\t/ /g' -e 's/\\\\/\\/g')
[ -n "$cmd" ] || exit 0
wt="${KANBAN_WORKTREE:-}"
wt2=""
branch=""
if [ -n "$wt" ]; then
  wt2=$(cd "$wt" 2>/dev/null && pwd -P)
  branch=$(git -C "$wt" symbolic-ref --short HEAD 2>/dev/null)
fi

# one `rm` command line: prints why it must be refused, or nothing
check_rm() {
  rec=0
  args=""
  for t in "$@"; do
    case "$t" in
      --recursive) rec=1 ;;
      --*) ;;
      -*) case "$t" in *r* | *R*) rec=1 ;; esac ;;
      *) args="$args $t" ;;
    esac
  done
  [ "$rec" = 1 ] || return 0
  for t in $args; do
    t=$(printf '%s' "$t" | tr -d "\"'")
    case "/$t/" in
      */../*) echo "rm -r of $t, which leaves the run's folder"; return 0 ;;
    esac
    case "$t" in
      "~"* | '$'*) echo "rm -r of $t, which is outside the run's folder"; return 0 ;;
      /*)
        [ -n "$wt" ] || continue
        case "$t" in
          "$wt" | "$wt"/* | "$wt2" | "$wt2"/*) ;;
          *) echo "rm -r of $t, which is outside the run's folder"; return 0 ;;
        esac
        ;;
    esac
  done
}

# one command line (split at ; & |): prints why it must be refused, or nothing
check_line() {
  line="$1"
  set -f
  # shellcheck disable=SC2086
  set -- $line
  [ "$1" = sudo ] && shift
  if printf '%s' "$line" | grep -Eq '(^|[[:space:]])git[[:space:]].*push([[:space:]]|$)'; then
    if printf '%s' "$line" | grep -Eq '(^|[[:space:]])(--force([[:space:]=]|$)|--force-with-lease|-[a-zA-Z]*f[a-zA-Z]*([[:space:]]|$)|\+[^[:space:]])'; then
      if printf '%s' "$line" | grep -Eq '(^|[[:space:]:/+])(main|master)([[:space:]]|$)' || [ "$branch" = main ] || [ "$branch" = master ]; then
        echo "git push --force to the main branch"
        return 0
      fi
    fi
  fi
  if [ "$1" = rm ]; then
    shift
    check_rm "$@"
  fi
}

reason=$(printf '%s\n' "$cmd" | tr ';&|' '\n\n\n' | while IFS= read -r one; do
  why=$(check_line "$one")
  if [ -n "$why" ]; then
    echo "$why"
    break
  fi
done 2>/dev/null)
if [ -n "$reason" ]; then
  reason=$(printf '%s' "$reason" | tr -d '"\\')
  printf '%s\n' "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"Refused by the board: $reason. Work inside the ticket's folder and leave the main branch's history alone.\"}}"
fi
exit 0
"####;

/// The PowerShell script of the hook (`hook_guard.POWERSHELL`), as it is written to the plugin.
pub const POWERSHELL: &str = r####"# Refuses `git push --force` to the main branch and a recursive delete outside the run's folder (AI v2). A refusal is
# the JSON a PreToolUse hook answers with, on exit 0; every other outcome, errors included, is silent exit 0.
try {
  $raw = [Console]::In.ReadToEnd()
  $call = $raw | ConvertFrom-Json
  if ($call.tool_name -notin @('Bash', 'PowerShell')) { exit 0 }
  $cmd = [string]$call.tool_input.command
  if (-not $cmd) { exit 0 }
  $wt = $env:KANBAN_WORKTREE
  $wtFull = $null
  $branch = ''
  if ($wt -and (Test-Path -LiteralPath $wt)) {
    $wtFull = [System.IO.Path]::GetFullPath($wt).TrimEnd('\')
    $branch = (& git -C $wt symbolic-ref --short HEAD 2>$null)
  }
  $reason = $null
  foreach ($line in ($cmd -split '[;&|\r\n]+')) {
    $line = $line.Trim()
    if (-not $line) { continue }
    if ($line -match '(^|\s)git\s.*push(\s|$)') {
      $forced = $line -match '(^|\s)(--force(\s|=|$)|--force-with-lease|-[a-zA-Z]*f[a-zA-Z]*(\s|$)|\+\S)'
      $main = ($line -match '(^|[\s:/+])(main|master)(\s|$)') -or ($branch -in @('main', 'master'))
      if ($forced -and $main) { $reason = 'git push --force to the main branch'; break }
    }
    $tokens = $line -split '\s+'
    if ($tokens[0] -eq 'sudo' -and $tokens.Count -gt 1) { $tokens = $tokens[1..($tokens.Count - 1)] }
    if ($tokens[0] -in @('rm', 'rmdir', 'rd', 'del', 'erase', 'ri', 'Remove-Item') -and $wtFull) {
      $rec = $false
      $paths = @()
      foreach ($t in $tokens[1..($tokens.Count - 1)]) {
        if ($t -match '^(--recursive|-[a-zA-Z]*[rR][a-zA-Z]*|/[sS]|-Recurse)$') { $rec = $true }
        elseif ($t -match '^(-|/[a-zA-Z]$)') { }
        elseif ($t) { $paths += $t.Trim('"', "'") }
      }
      if ($rec) {
        foreach ($p in $paths) {
          if ($p -match '^[~$]') { $reason = "recursive delete of $p, which is outside the run's folder"; break }
          $q = $p -replace '^/([a-zA-Z])/', '$1:\'
          $full = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($wtFull, $q))
          if (-not ($full -eq $wtFull -or $full.StartsWith($wtFull + '\', [System.StringComparison]::OrdinalIgnoreCase))) {
            $reason = "recursive delete of $p, which is outside the run's folder"; break
          }
        }
        if ($reason) { break }
      }
    }
  }
  if ($reason) {
    $msg = "Refused by the board: $reason. Work inside the ticket's folder and leave the main branch's history alone."
    @{ hookSpecificOutput = @{ hookEventName = 'PreToolUse'; permissionDecision = 'deny'; permissionDecisionReason = $msg } } | ConvertTo-Json -Compress -Depth 4
  }
} catch { }
exit 0
"####;
