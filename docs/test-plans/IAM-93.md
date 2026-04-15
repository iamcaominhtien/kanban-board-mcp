---
title: "Test Plan: IAM-93 CI/CD Auto Release Pipeline"
type: test
status: stable
ticket: IAM-93
version: 1.0.1
created: 2026-04-15
updated: 2026-04-15
authors: [GitHub Copilot (QC Agent)]
related:
  - .github/workflows/release.yml
---

# Test Plan: IAM-93 CI/CD Auto Release Pipeline

## Scope

Static verification of the GitHub Actions auto-release workflow defined in `.github/workflows/release.yml`.

This test plan does not execute GitHub Actions jobs. It verifies workflow logic, guards, matrix coverage, shell safety, and release artifact handling by reading the YAML file directly.

Out of scope:

- Runtime validation inside GitHub Actions
- Cross-runner behavior differences not visible from the workflow source alone
- Release artifact contents after build execution

## Test Method

- Source inspected: `.github/workflows/release.yml`
- Verification mode: static analysis and shell-logic review
- Result rule: each test case is marked `PASS` only if the workflow file currently implements the requirement as written

## Summary

| Metric | Value |
|---|---|
| Test cases reviewed | 12 |
| Passed | 12 |
| Failed | 0 |
| Overall result | PASS |

## Detailed Results

| ID | Requirement | Result | Evidence from Workflow | Edge Case Concerns |
|---|---|---|---|---|
| TC-01 | Workflow triggers on `push` to `main` only | ✅ PASS | `on:` defines only `push` with `branches: [main]`. No `pull_request`, `workflow_dispatch`, or other branch patterns are present. | No manual trigger exists, so recovery or re-run testing must be done by re-pushing or rerunning an existing run in GitHub. |
| TC-02 | `check-conditions` returns `should_release=false` when tag already exists | ✅ PASS | The shell guard checks `git tag --list "v$VERSION"`; if a match exists it logs a skip message and sets `SHOULD_RELEASE=false`, then writes `should_release=$SHOULD_RELEASE` to `$GITHUB_OUTPUT`. | Match logic is tied to the `v` prefix. If the project ever adopts non-`v` tags or prerelease tag formats, this guard will not catch them. |
| TC-03 | `check-conditions` returns `should_release=false` when `CHANGELOG.md` lacks `## [VERSION]` | ✅ PASS | The workflow runs `grep -q "## \[$VERSION\]" CHANGELOG.md`; on failure it logs a skip message and sets `SHOULD_RELEASE=false`. | The check assumes Keep a Changelog heading format. Alternate heading styles or extra spacing would incorrectly block releases. |
| TC-04 | When both guards pass, `should_release=true` and release notes are extracted | ✅ PASS | `SHOULD_RELEASE` starts as `true`; only the two guards can change it. When it remains `true`, the script extracts notes with `sed`, then writes a multiline `release_notes` output block. | The extraction command `sed -n "/^## \[$VERSION\]/,/^## \[/p" ... | sed '1d;$d'` can trim the final line incorrectly if the target changelog section is the last section in the file with no following `## [` header. |
| TC-05 | `update-readme` runs only when release is allowed, uses `[skip ci]`, and handles no-change commits safely | ✅ PASS | Job-level guard is `if: needs.check-conditions.outputs.should_release == 'true'`. Commit message is `chore: update README to v$VERSION [skip ci]`. Commit step ends with `|| echo "No changes to commit"`. | The job still performs `git push`; if branch protection blocks GitHub Actions pushes, the workflow will fail after the no-change-safe commit logic. |
| TC-06 | Build matrix covers macOS and Windows, Windows script steps use Bash, and `CSC_IDENTITY_AUTO_DISCOVERY=false` is set | ✅ PASS | Strategy matrix is `os: [macos-latest, windows-latest]`. The build script step explicitly uses `shell: bash`. Its `env` block sets `CSC_IDENTITY_AUTO_DISCOVERY: false`. | There is no Linux build leg. That is fine for the stated requirement, but any future Linux release target would need a matrix update. |
| TC-07 | Venv activation supports both Windows and Unix layouts | ✅ PASS | The build step checks `.venv/Scripts/activate` first, otherwise falls back to `.venv/bin/activate`, covering Windows and Unix activation paths. | This assumes Bash can source the Windows venv activation script on `windows-latest`, which is valid for Git Bash style runners but still worth watching if the shell environment changes. |
| TC-08 | Shell injection safety: release notes passed via env + `--notes-file`, and `VERSION` passed via env rather than direct GitHub expression in shell | ✅ PASS | `update-readme` defines `RELEASE_VERSION: ${{ needs.check-conditions.outputs.version }}` in `env` and assigns `VERSION="$RELEASE_VERSION"` inside the script. `create-release` follows the same pattern with `RELEASE_VERSION` and also writes `RELEASE_NOTES` to `/tmp/release_notes.md` before calling `gh release create --notes-file`. | The defensive pattern is now consistent across both shell steps that consume dynamic workflow outputs. |
| TC-09 | Artifact collection uses `mapfile` and a `find` expression that handles spaces safely | ✅ PASS | The release step uses `mapfile -t ARTIFACTS < <(find release-artifacts/ \( -name "*.dmg" -o -name "*.exe" \) -type f)` and then expands `"${ARTIFACTS[@]}"` into `gh release create`. | If the build produces no matching files, the array will be empty and release creation behavior depends on how `gh release create` handles that runner state. |
| TC-10 | Workflow declares `permissions: contents: write` at the top level | ✅ PASS | The workflow root defines `permissions:` with `contents: write`. | This grants the whole workflow content write access. If the workflow grows, job-level permission narrowing may become preferable. |
| TC-11 | `create-release` has an explicit `should_release == 'true'` guard | ✅ PASS | The `create-release` job includes `if: needs.check-conditions.outputs.should_release == 'true'`. | `create-release` also depends on `build`; a failed build will still block release even when the guard passes, which is correct but worth keeping in mind during triage. |
| TC-12 | `check-conditions` fetches full history with `fetch-depth: 0` | ✅ PASS | The `actions/checkout@v4` step inside `check-conditions` sets `fetch-depth: 0`. | This is correct for tag checks, but it increases checkout cost versus shallow clones. That trade-off is appropriate here. |

## Findings

No open findings after re-verifying TC-08 against the current workflow source.

## Overall Assessment

The workflow now satisfies all 12 of 12 requested checks. TC-08 is fixed because both `update-readme` and `create-release` pass the version through step-level `env` blocks and reference it inside the shell script as `VERSION="$RELEASE_VERSION"`. The release notes handling in `create-release` also remains on the safer `env` plus `--notes-file` path.

## Execution Record

- Execution date: 2026-04-15
- Execution mode: static analysis only, including TC-08 re-verification
- Workflow file reviewed: `.github/workflows/release.yml`
- Playwright usage: not used, per requirement for YAML-only verification