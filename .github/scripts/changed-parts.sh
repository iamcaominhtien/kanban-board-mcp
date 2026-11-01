#!/usr/bin/env bash
# Decide which CI jobs a change needs: backend (server/), frontend (ui/, and CHANGELOG.md, which the UI imports)
# and desktop (desktop/). Writes backend=, frontend= and desktop= (true/false) to $GITHUB_OUTPUT.
#
# Everything runs when CI itself changes (this script, ci.yml, sonar-project.properties) or when the range cannot
# be compared (a new branch, a force push). A push to main runs all three as soon as any of them is needed, so the
# SonarQube Cloud analysis of main always has every coverage report; otherwise main's coverage of the parts that
# were skipped would read 0%.
#
# Env: EVENT (push | pull_request), BASE and HEAD (the commits to compare). Also runs locally for a dry run:
#   EVENT=pull_request BASE=origin/main HEAD=HEAD GITHUB_OUTPUT=/dev/stdout bash .github/scripts/changed-parts.sh
set -euo pipefail

all=false
if [[ -z "${BASE:-}" || "$BASE" =~ ^0+$ ]] || ! files=$(git diff --name-only "$BASE...$HEAD" 2>/dev/null); then
  echo "Cannot compare ${BASE:-?}...${HEAD:-?}: running everything"
  all=true
  files=""
fi
if grep -qE '^(\.github/workflows/ci\.yml|\.github/scripts/changed-parts\.sh|sonar-project\.properties)$' <<<"$files"; then
  all=true
fi

touched() { $all || grep -qE "$1" <<<"$files"; }
backend=false; frontend=false; desktop=false
if touched '^server/'; then backend=true; fi
if touched '^(ui/|CHANGELOG\.md$)'; then frontend=true; fi
if touched '^desktop/'; then desktop=true; fi

if [[ "${EVENT:-}" == "push" ]] && { $backend || $frontend || $desktop; }; then
  backend=true; frontend=true; desktop=true
fi

{
  echo "backend=$backend"
  echo "frontend=$frontend"
  echo "desktop=$desktop"
} >> "$GITHUB_OUTPUT"

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "| Part | Runs |"
    echo "|---|---|"
    echo "| Backend | $backend |"
    echo "| Frontend | $frontend |"
    echo "| Desktop | $desktop |"
  } >> "$GITHUB_STEP_SUMMARY"
fi
echo "backend=$backend frontend=$frontend desktop=$desktop"
