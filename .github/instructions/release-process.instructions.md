---
name: release-process
description: Guidelines for semantic versioning, CHANGELOG updates, building desktop artifacts, and creating GitHub releases.
applyTo: "**"
---

# Release Process

There are two release modes: **Auto** (recommended) via CI/CD, and **Manual** for hotfixes or special cases.

---

## Auto Release via CI/CD (Recommended)

Merging a PR to `main` automatically triggers `.github/workflows/release.yml`, which builds macOS + Windows artifacts and publishes a GitHub Release — **but only if both guard conditions are met.**

### Pre-merge Checklist (must complete before merging)

1. **Version bump:** Update `desktop/package.json` and `desktop/package-lock.json` to the new version (`X.Y.Z`).
2. **Changelog entry:** Add `## [X.Y.Z] - YYYY-MM-DD` section to `CHANGELOG.md` with a summary of changes.

That's it. After merge, CI handles the rest automatically:
- Extracts release notes from `CHANGELOG.md`
- Auto-updates `README.md` version references (commits with `[skip ci]`)
- Builds DMG (macOS arm64 + x64) and NSIS installer (Windows x64)
- Creates the GitHub Release and attaches all artifacts

### Guard Conditions (CI will skip release if either fails)

- Tag `v<VERSION>` must **not** already exist in git
- `CHANGELOG.md` must contain `## [X.Y.Z]` for the current version

### Versioning Rules

- Prefer **patch** unless a minor/major change is explicitly justified
- Never infer the next version without inspecting the changelog and existing tags

---

## Manual Release (Hotfix / Special Cases)

Use this only when the auto pipeline is unavailable or broken.

### Workflow Execution Order

1. **Audit:** Check `CHANGELOG.md` and existing tags/releases to determine the current state.
2. **Version Selection:** Decide the next semantic version conservatively. Prefer **patch** unless a minor/major change is explicitly justified.
3. **Changelog:** Update `CHANGELOG.md` with the new version and summary of changes.
4. **Metadata:** Update version fields in `desktop/package.json` and `desktop/package-lock.json`.
5. **Build:** Run the build script (e.g., `build-desktop.sh`) locally.
6. **Artifact Verification:** Verify that expected binaries exist in `dist-desktop/`.
7. **Documentation (REQUIRED):** Update `README.md` — replace every version number reference and download link with the new version. This step is mandatory, not optional.
8. **GitHub Release:** Create the GitHub release using the exact tag/version decided in step 2.
9. **Asset Upload:** Manually upload the built artifacts from `dist-desktop/` to the GitHub release.
10. **Final Check:** Verify the release page shows the binary assets, not just the default source code archives.

### Guardrails

- **No Build, No Release:** Never create a GitHub release before the local build succeeds.
- **No README, No Release:** Never create a GitHub release without first updating README.md version references.
- **No Blind Versioning:** Never infer the next version without inspecting the changelog and existing tags.
- **Recovery Protocol:** If fixing a failed release, inspect existing assets and tags thoroughly before deleting or recreating anything.
