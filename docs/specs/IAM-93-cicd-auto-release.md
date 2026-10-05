# BA Spec: IAM-93 — CI/CD Auto Release Pipeline

## Overview
Implement a GitHub Actions workflow that automatically creates a GitHub Release every time a PR is merged into `main`, provided all guard conditions are satisfied.

## Trigger
- **Event:** `push` to `main` branch (fires after PR squash merge)

## Guard Conditions (both must pass)
1. `desktop/package-lock.json` version does **not** already have a corresponding git tag (e.g., `v1.3.4` tag must not exist)
2. `CHANGELOG.md` must contain an entry matching `## [X.Y.Z]` for the current version

If either condition fails → workflow exits early, no release created.

## Behavior

### Step 1 — Check Release Conditions (`ubuntu-latest`)
- Read version from `desktop/package-lock.json`
- Check if git tag `v<VERSION>` already exists (`git tag --list`)
- Check if `CHANGELOG.md` contains `## [VERSION]`
- Extract release notes block for that version from CHANGELOG
- Output: `should_release`, `version`, `release_notes`

### Step 2 — Auto-update README (`ubuntu-latest`)
- Only runs if `should_release == true`
- Detect old version string in `README.md` (pattern: `vX.Y.Z`)
- Replace all occurrences with new version
- If changes detected → commit with message `chore: update README to vX.Y.Z [skip ci]` and push
- The `[skip ci]` in commit message prevents re-triggering the workflow

### Step 3 — Build macOS (`macos-latest`)
- Depends on Steps 1 & 2
- Setup: Node 20, Python 3.11
- Create Python venv: `cd server && python -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt`
- Run `bash build-desktop.sh`
- Disable code signing: `CSC_IDENTITY_AUTO_DISCOVERY=false`
- Upload artifacts: `dist-desktop/*.dmg`

### Step 4 — Build Windows (`windows-latest`)
- Depends on Steps 1 & 2
- Setup: Node 20, Python 3.11
- Create Python venv (Windows path): `python -m venv .venv` then `source .venv/Scripts/activate`
- Run `bash build-desktop.sh` (Git Bash available on Windows runners)
- Disable code signing: `CSC_IDENTITY_AUTO_DISCOVERY=false`
- Upload artifacts: `dist-desktop/*.exe` (NSIS installer)

### Step 5 — Create GitHub Release (`ubuntu-latest`)
- Depends on Steps 3 & 4 both succeeding
- Download artifacts from both builds
- Run: `gh release create "v$VERSION" <artifacts> --title "vX.Y.Z" --notes "<CHANGELOG block>"`
- Uses `GITHUB_TOKEN` (built-in secret)

## File to Create
`.github/workflows/release.yml`

## Acceptance Criteria
- [ ] Workflow triggers on push to main
- [ ] No release created if CHANGELOG entry missing
- [ ] No release created if tag already exists
- [ ] README.md auto-updated if version references are stale (with `[skip ci]` to prevent loop)
- [ ] macOS DMG artifact attached to release
- [ ] Windows NSIS `.exe` artifact attached to release
- [ ] Release title = `vX.Y.Z`, notes = CHANGELOG block for that version

## Known Risks
- **macOS code signing**: Skipped in CI (`CSC_IDENTITY_AUTO_DISCOVERY=false`). Builds will succeed but produce unsigned DMGs.
- **Windows Python venv path**: `Scripts/activate` vs `bin/activate` — must use correct path per OS.
- **build-desktop.sh Windows compatibility**: Script uses bash — available via Git Bash on Windows runners; `shell: bash` required on Windows steps.
