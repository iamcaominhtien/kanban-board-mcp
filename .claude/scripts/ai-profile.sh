#!/usr/bin/env bash
# Run several accounts of the same AI CLI side by side, each in its own profile.
#
#   ai-profile.sh <cli> new <name>
#   ai-profile.sh <cli> login <name> [login args]
#   ai-profile.sh <cli> run <name> [cli args]     run the CLI as that account
#   ai-profile.sh <cli> status <name>
#   ai-profile.sh <cli> list
#   ai-profile.sh <cli> rm <name>
#   ai-profile.sh list                            profiles of every CLI
#
# <cli>: agy | claude | codex | opencode
#
# How a profile isolates the login:
#   agy       own HOME and own login keychain inside it (macOS only)
#   claude    own CLAUDE_CONFIG_DIR
#   codex     own CODEX_HOME
#   opencode  own XDG_*_HOME dirs (the free models need no login at all)
#
# Env: <CLI>_PROFILES_HOME (default ~/.<cli>-profiles), <CLI>_BIN (default: the CLI on PATH)
set -euo pipefail

REAL_HOME="$HOME"
CLIS="agy claude codex opencode"

die() { echo "ai-profile: $*" >&2; exit 1; }

usage() { sed -n '2,20p' "$0"; exit 2; }

upper() { echo "$1" | tr '[:lower:]' '[:upper:]'; }

root_of() { # <cli>
  local v; v="$(upper "$1")_PROFILES_HOME"
  echo "${!v:-$REAL_HOME/.$1-profiles}"
}

bin_of() { # <cli>
  local v; v="$(upper "$1")_BIN"
  local b="${!v:-$(command -v "$1" || true)}"
  [ -n "$b" ] || die "$1 not found on PATH (set $v)"
  echo "$b"
}

dir_of() { # <cli> <name>
  [ -n "${2:-}" ] || die "missing profile name"
  case "$2" in *[!A-Za-z0-9._-]*|.*) die "bad profile name: $2" ;; esac
  echo "$(root_of "$1")/$2"
}

need_dir() { [ -n "${2:-}" ] || die "missing profile name"; [ -d "$(dir_of "$1" "$2")" ] || die "no such $1 profile: $2"; }

# --- agy: HOME spoofing + a login keychain per profile (macOS) ---------------

agy_home() { echo "$1/home"; }
agy_kc() { echo "$(agy_home "$1")/Library/Keychains/login.keychain-db"; }

agy_exec() { # <dir> cmd...
  local d="$1"; shift
  HOME="$(agy_home "$d")" GIT_CONFIG_GLOBAL="$REAL_HOME/.gitconfig" \
    AGY_CLI_DISABLE_AUTO_UPDATE=1 "$@"
}

agy_unlock() {
  agy_exec "$1" security unlock-keychain -p "" "$(agy_kc "$1")" >/dev/null 2>&1 \
    || die "cannot unlock the keychain of this profile (was it created with 'new'?)"
}

# --- per-CLI adapters ----------------------------------------------------------
# Each does its own setup, so `exec_in` stays one case.

exec_in() { # <cli> <dir> cmd...
  local cli="$1" d="$2"; shift 2
  case "$cli" in
    agy) agy_unlock "$d"; agy_exec "$d" "$@" ;;
    claude) CLAUDE_CONFIG_DIR="$d" "$@" ;;
    codex) CODEX_HOME="$d" "$@" ;;
    opencode)
      XDG_DATA_HOME="$d/data" XDG_CONFIG_HOME="$d/config" \
      XDG_CACHE_HOME="$d/cache" XDG_STATE_HOME="$d/state" "$@" ;;
  esac
}

cmd_new() { # <cli> <name>
  local cli="$1" d; d="$(dir_of "$1" "${2:-}")"
  [ ! -e "$d" ] || die "$cli profile '$2' already exists"
  mkdir -p "$d"
  case "$cli" in
    agy)
      mkdir -p "$d/home/Library/Keychains" "$d/home/.config"
      local kc; kc="$(agy_kc "$d")"
      agy_exec "$d" security create-keychain -p "" "$kc"
      agy_exec "$d" security set-keychain-settings "$kc"      # never auto-lock
      agy_exec "$d" security unlock-keychain -p "" "$kc"
      agy_exec "$d" security default-keychain -s "$kc"
      agy_exec "$d" security list-keychains -s "$kc"
      # Read-only things other tools expect under HOME.
      local f
      for f in .ssh .config/gh; do
        if [ -e "$REAL_HOME/$f" ]; then ln -s "$REAL_HOME/$f" "$d/home/$f"; fi
      done ;;
    opencode) mkdir -p "$d/data" "$d/config" "$d/cache" "$d/state" ;;
  esac
  echo "created $cli profile '$2' at $d"
  case "$cli" in
    opencode) echo "free models need no login: $0 opencode run $2 run -m opencode/<model>-free \"...\"" ;;
    *) echo "next: $0 $cli login $2" ;;
  esac
}

cmd_login() { # <cli> <name> [args]
  local cli="$1" name="${2:-}"; shift $(( $# < 2 ? $# : 2 ))
  need_dir "$cli" "$name"; local d bin; d="$(dir_of "$cli" "$name")"; bin="$(bin_of "$cli")"
  case "$cli" in
    agy)
      echo "Sign in as the Google account for '$name' (choose it in the browser; a private window helps)."
      cd "$(agy_home "$d")"
      exec_in agy "$d" "$bin" ;;
    claude) exec_in claude "$d" "$bin" auth login --claudeai "$@" ;;
    codex) exec_in codex "$d" "$bin" login "$@" ;;
    opencode) exec_in opencode "$d" "$bin" auth login "$@" ;;
  esac
}

cmd_run() { # <cli> <name> [args]
  local cli="$1" name="${2:-}"; shift $(( $# < 2 ? $# : 2 ))
  need_dir "$cli" "$name"
  exec_in "$cli" "$(dir_of "$cli" "$name")" "$(bin_of "$cli")" "$@"
}

cmd_status() { # <cli> <name>
  local cli="$1" name="${2:-}"; need_dir "$cli" "$name"
  local d bin; d="$(dir_of "$cli" "$name")"; bin="$(bin_of "$cli")"
  case "$cli" in
    agy)
      if exec_in agy "$d" "$bin" models </dev/null >/dev/null 2>&1; then
        echo "$name: signed in"
      else
        echo "$name: not signed in"; return 1
      fi ;;
    claude)
      exec_in claude "$d" "$bin" auth status --json </dev/null | python3 -I -c '
import sys, json
d = json.load(sys.stdin)
ok = d.get("loggedIn")
print("%s: %s (%s%s)" % (sys.argv[1], "signed in" if ok else "not signed in",
      d.get("authMethod"), ", " + d["subscriptionType"] if d.get("subscriptionType") else ""))
sys.exit(0 if ok else 1)' "$name" ;;
    codex)
      local out; out="$(exec_in codex "$d" "$bin" login status </dev/null 2>&1 | head -1)" || true
      echo "$name: $out"
      case "$out" in Logged\ in*) return 0 ;; *) return 1 ;; esac ;;
    opencode)
      local n
      n="$(exec_in opencode "$d" "$bin" auth list </dev/null 2>&1 | sed 's/\x1b\[[0-9;]*m//g' \
        | grep -m1 -oE '[0-9]+ credentials?' | grep -oE '^[0-9]+')" || n=0
      echo "$name: ${n:-0} stored credential(s); free models need none" ;;
  esac
}

cmd_list() { # [<cli>]
  local cli r d
  for cli in ${1:-$CLIS}; do
    r="$(root_of "$cli")"
    [ -d "$r" ] || continue
    for d in "$r"/*/; do
      [ -d "$d" ] && echo "$cli $(basename "$d")"
    done
  done
  return 0
}

cmd_rm() { # <cli> <name>
  local cli="$1" name="${2:-}"; need_dir "$cli" "$name"
  local d; d="$(dir_of "$cli" "$name")"
  # Claude also keeps a keychain entry outside the profile directory.
  if [ "$cli" = claude ]; then exec_in claude "$d" "$(bin_of claude)" auth logout >/dev/null 2>&1 || true; fi
  printf "delete %s profile '%s' and its login? [y/N] " "$cli" "$name"; read -r a
  [ "$a" = y ] || exit 0
  rm -rf "$d"
}

[ $# -ge 1 ] || usage
if [ "$1" = list ]; then cmd_list; exit 0; fi
cli="$1"; sub="${2:-}"; shift $(( $# < 2 ? $# : 2 )) || true
case " $CLIS " in *" $cli "*) ;; *) usage ;; esac
[ "$cli" != agy ] || [ "$(uname -s)" = Darwin ] || die "agy profiles are macOS only for now"
case "$sub" in
  new|login|run|status|rm) "cmd_$sub" "$cli" "$@" ;;
  list) cmd_list "$cli" ;;
  *) usage ;;
esac
