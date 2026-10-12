# TMflash Mac app download (module 08)

Devices contains two separate pages: **TMflash web** (`/flash`, module 07)
for browser USB flashing, and **TMflash download** (`/tmflash-download`,
module 08) for the portable Mac application. Both keep their own navigation
state, landing-page cards and search entries. The browser flasher's device
access and Engineer/Admin permissions are unchanged. Any signed-in portal
member may read the Mac download page and download the application.

The native app uses the existing black tile and white lightning mark. The
page offers one download button, current version, size and Mac requirements,
features, three installation steps, and opening instructions for builds that
are not notarized. Install by opening the DMG and dragging TMflash onto
Applications. Intel and Apple Silicon, macOS 14 or later. Firmware and tools
are included; no Python, PlatformIO, Xcode, Homebrew or source folder is needed.
Included firmware flashing works offline; account sign-in and cloud adoption
still need internet access. Downloading grants no adoption permission.

## Updates without another portal deployment

TMflash's `Publish portable DMG` workflow tests and builds every update merged
to `master`, then publishes an immutable release named `build-<full commit>`.
It attaches the universal DMG, `.dmg.sha256` and `tmflash-app.json`, marks it
latest, and refuses to publish a stale master build or replace an existing
release. The current workflow publishes ad-hoc signed, unnotarized apps; a
Developer ID certificate and Apple notarization are separate signing setup.

TMedge reads only
`https://github.com/Mysteringz/TMflash/releases/latest/download/tmflash-app.json`.
The manifest contract is `src/shared/tmflash-release.ts`, written by
`TMflash/scripts/release_manifest.py`. It names a clean source commit, unique
build tag, app version, universal DMG filename, size, SHA-256, architectures,
minimum macOS version, included firmware version, notarization status and
build time. Unknown formats, wrong projects, dirty builds, traversal names,
oversized files and incomplete metadata are refused.

`GitHubTMflashSource` follows HTTPS redirects itself and allows only GitHub
and its download hosts; it sends no credential. It streams at most 128 MiB
to a temporary file, verifies size, SHA-256 and the DMG's UDIF trailer, then
atomically publishes the checked cache pointer. Concurrent readers share one
check. Large downloads are served from disk rather than held in memory.

The cache is under `DATA_DIR/tmflash-download/`, outside deployment releases,
and needs the existing service data-directory write access. It retains the
current and one preceding file so a page already displaying the older build
can still finish that download. A restart verifies cached bytes before use.
No DMG is committed to TMedge, copied into its deployment archive or uploaded
through the portal. No new environment variable or runtime dependency is needed.

The server checks the latest manifest at most once per minute when asked.
An open download page asks every minute and on **Check for updates**. Publishing
a new app therefore changes the portal after its next check, without a new
TMedge PR or deploy. The first check may take up to two minutes while the
DMG is downloaded and checked. No release is a clear unavailable state.
Temporary GitHub failures retain a labelled last verified build; a missing or
invalid newest release removes the download offer. Failures are briefly
cached to avoid making every open page retry the same failed request.

## HTTP and tests

Both routes are mounted after human sign-in and accept only GET:

- `/api/tmflash-download/release`: checked metadata; no-store.
- `/api/tmflash-download/files/:tag/:filename`: only a known, checked local
  file, served as a DMG attachment with range support and private/no-store.

Tests use the real reader against a fake GitHub and assert automatic version
replacement, shared fetches, restart/outage behavior, checksums, size bounds,
DMG structure, redirect restrictions, cache cleanup and read-only routes.
Browser checks cover desktop/phone navigation, logo, installation guidance,
authenticated downloads, automatic refresh and unavailable states. They do
not depend on GitHub having a release during CI.

Rollout order: merge the TMflash PR to publish the first compatible app
release, then merge/deploy the TMedge PR through the existing approval gate.
Future TMflash master updates need no further portal deployment. Before the
first app release exists, module 08 explains that it has not been published.
