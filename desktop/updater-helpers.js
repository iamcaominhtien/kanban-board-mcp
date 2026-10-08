const RELEASE_REPO = 'iamcaominhtien/kanban-board-mcp';
const LATEST_RELEASE_URL = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;
const DOWNLOAD_PREFIX = `https://github.com/${RELEASE_REPO}/releases/download/`;

/** Parses "v1.2.3" / "1.2.3" into [1, 2, 3]; returns null when it is not a plain x.y.z version. */
function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(value || '').trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** True only when `latest` is strictly newer than `current`. Unparseable input is never "newer". */
function isNewerVersion(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/**
 * Picks the installer for this OS/CPU from a GitHub release.
 *   macOS arm64 -> "*-arm64.dmg", macOS x64 -> "*.dmg" without "arm64", Windows -> "*Setup*.exe".
 */
function pickAsset(release, platform, arch) {
  const assets = Array.isArray(release && release.assets) ? release.assets : [];
  const usable = assets.filter((a) => a && typeof a.name === 'string' && a.browser_download_url);
  if (platform === 'darwin') {
    const dmgs = usable.filter((a) => a.name.endsWith('.dmg'));
    return dmgs.find((a) => a.name.includes('arm64') === (arch === 'arm64')) || null;
  }
  if (platform === 'win32') {
    return usable.find((a) => /Setup.*\.exe$/i.test(a.name)) || null;
  }
  return null;
}

/** Only installers served from this project's GitHub releases may be downloaded and run. */
function isTrustedDownloadUrl(url) {
  return typeof url === 'string' && url.startsWith(DOWNLOAD_PREFIX);
}

/** GitHub exposes "sha256:<hex>" as `digest`; returns the lowercase hex or null. */
function expectedSha256(asset) {
  const match = /^sha256:([0-9a-f]{64})$/i.exec((asset && asset.digest) || '');
  return match ? match[1].toLowerCase() : null;
}

/**
 * Turns a GitHub release payload into the update info the UI needs,
 * or null when there is nothing newer / nothing installable for this machine.
 */
function buildUpdateInfo(release, { currentVersion, platform, arch }) {
  if (!release || release.draft || release.prerelease) return null;
  if (!isNewerVersion(release.tag_name, currentVersion)) return null;
  const asset = pickAsset(release, platform, arch);
  if (!asset || !isTrustedDownloadUrl(asset.browser_download_url)) return null;
  return {
    version: String(release.tag_name).replace(/^v/, ''),
    notes: typeof release.body === 'string' ? release.body.trim() : '',
    releaseUrl: release.html_url || null,
    assetName: asset.name,
    assetUrl: asset.browser_download_url,
    assetSize: asset.size || 0,
    sha256: expectedSha256(asset),
  };
}

module.exports = {
  LATEST_RELEASE_URL,
  parseVersion,
  isNewerVersion,
  pickAsset,
  isTrustedDownloadUrl,
  expectedSha256,
  buildUpdateInfo,
};
