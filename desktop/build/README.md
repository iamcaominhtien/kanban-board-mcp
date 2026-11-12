# Build Assets

Place app icons here for electron-builder:
- `icon.icns` — macOS app icon (512×512 minimum)
- `icon.ico` — Windows app icon
- `icon.png` — Linux app icon (512×512)

Without icons, electron-builder uses its default Electron icon.

## macOS Notarization

`hardenedRuntime: true` is configured, which is required for Apple notarization.
To notarize before public release, add `afterSign` hook and `notarize` package to desktop/package.json.
See: https://www.electron.build/code-signing
Without notarization, macOS users must right-click → Open to bypass Gatekeeper on first launch.

## Bundled server

`../scripts/build-server.sh` builds the Rust programs `kanban-server` and `kanban-mcp-stdio` (`server-rs/`) into
`dist-server/kanban-mcp-stdio/`, and `package.json` copies that folder into the app's Resources (`extraResources` of
`mac` and `win`). The programs are signed with the app when a signing identity is set; `entitlements.mac.plist`
applies to the whole app, Electron's helpers included.
