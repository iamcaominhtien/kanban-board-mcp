---
name: release-process
description: Guidelines for semantic versioning, CHANGELOG updates, building desktop artifacts, and creating GitHub releases.
applyTo: "**"
---

# Release Process

Follow this exact order for desktop app releases to ensure consistency and artifact integrity.

## Workflow Execution Order

1. **Audit:** Check `CHANGELOG.md` and existing tags/releases to determine the current state.
2. **Version Selection:** Decide the next semantic version conservatively. Prefer **patch** unless a minor/major change is explicitly justified.
3. **Changelog:** Update `CHANGELOG.md` with the new version and summary of changes.
4. **Metadata:** Update version fields in `desktop/package.json`.
5. **Build:** Run the build script (e.g., `build-desktop.sh`) locally.
6. **Artifact Verification:** Verify that expected binaries exist in `dist-desktop/`.
7. **Documentation (REQUIRED):** Update `README.md` — replace every version number reference and download link with the new version. This step is mandatory, not optional.
8. **GitHub Release:** Create the GitHub release using the exact tag/version decided in step 2.
9. **Asset Upload:** Manually upload the built artifacts from `dist-desktop/` to the GitHub release.
10. **Final Check:** Verify the release page shows the binary assets, not just the default source code archives.

## Guardrails

- **No Build, No Release:** Never create a GitHub release before the local build succeeds.
- **No README, No Release:** Never create a GitHub release without first updating README.md version references.
- **No Blind Versioning:** Never infer the next version without inspecting the changelog and existing tags.
- **Recovery Protocol:** If fixing a failed release, inspect existing assets and tags thoroughly before deleting or recreating anything.
