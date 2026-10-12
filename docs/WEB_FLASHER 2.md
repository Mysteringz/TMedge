# TMflash in the browser (module 07)

`algo.hkumyseat.com/flash` does what the TMflash Mac app does, from a browser,
to the board plugged into the computer that browser runs on: write the release
firmware, set the node up over its serial console, read the settings back, ask
TMedge to admit it, and watch it come up.

## Using it

You need Chrome or Edge on a computer (Web Serial) and an Engineer or Admin
account. Nothing is installed or built on that computer: the firmware is the
latest release of <https://github.com/Mysteringz/TMsense>.

1. **Board.** Click **Connect a board**. The browser shows its own list of USB
   serial devices; the page can reach only the one you pick, and only until
   you disconnect it or close the tab. The page restarts the board and asks it
   what it runs. A board with no TMsense on it says nothing, and is flashed.
2. **Firmware.** Nothing to choose. The page shows the release it will write
   (version, tag, commit, when the console last confirmed it with GitHub) and
   where each image goes. **Check for a newer release** asks again. Turn
   **Write firmware** off to change only the settings of a board that already
   runs TMsense; that needs no release.
3. **Settings.** Node ID, uplink, network, gateway or cloud URL, signing key,
   frame rate. A field left blank keeps what the node has. The uplink starts
   from how the connected node is set up now.
4. **Flash.** With **Ask TMedge to admit this node** on, the job stops at
   **Admit this board**, showing the UID read from the board. Pressing it
   approves the request; **Decide later in Adoption** leaves it queued.

A job ends as **Done**, **Set up, with something to check** (it is set up as
asked, and the list says what is missing: it did not join Wi-Fi, it has no
key), or **Failed** with the reason. If the bootloader cannot be reached, hold
the board's **PRG** button, tap **RST**, and try again.

Opening a board's serial port restarts it, so reading an installed node stops
its reports for a few seconds.

## What it will not do

- **It never erases a board.** NVS holds the node's settings and its boot
  counter, and a boot counter that returns to zero makes TMedge reject the
  node's packets as replays. The write plan is an allow-list built from the
  partition table being flashed: the bootloader's space, the table's sector,
  the boot selector's partition and the first application slot. A build whose
  layout would put any write over an NVS partition is refused, not trimmed.
  No erase command is ever sent.
- **It does not flash anything but a TMsense release.** There is no file
  picker and no upload: the page cannot be handed an image, and neither can
  the console. See "Where the firmware comes from" below.
- **It does not send secrets to the server.** The Wi-Fi password and the
  signing key go from the page to the USB port. They are kept in memory only,
  masked in the log and scrubbed from any error. The page remembers the
  uplink, network name, gateway and cloud URL in the browser's local storage,
  and nothing else.
- **It does not admit a node by itself.** It queues the same request the Mac
  app does (`POST /api/adoption/requests`, Engineer or Admin, signed in) and
  waits for a person. See "Adoption" below.
- **It does not rewrite the build.** The four images reach the board byte for
  byte as the release published them, and each region is read back as an MD5
  before the job is called done. A bootloader built for a flash size other
  than 8 MB is refused.
- **It does not build firmware, flash a local or unreleased build, scan for
  Wi-Fi, or flash several boards at once.** Those are the Mac app's.

## Adoption

`docs/ADOPTION.md` describes the Mac app's flow: its session buys a pending
request, and a person in Adoption types the UID and request code shown on the
Mac to approve it. That typing binds a request to a physical board across two
machines.

In the browser there is one machine and one person. The UID was read over USB
from the board in front of whoever is signed in, so the page sends the UID and
code it was just given, when that person presses **Admit this board**. The
server checks them exactly as it does for a typed approval, the capability
required is the same (`nodes.admin`), and the audit line names the account.
What is admitted is still an identity with no floor and no pose.

When `DEVICE_KEYS_FILE` is enabled, approval is refused until the board's key
is enrolled, here as everywhere.

## Where the firmware comes from

One place: the latest release of `Mysteringz/TMsense` on GitHub
(`TMSENSE_REPOSITORY` in `src/shared/flasher/release.ts`).

**Publishing.** TMsense's `Release` workflow is run by hand from `main`. It
runs the host tests, builds the `tmflash` environment (`TM_NO_NODE_CONFIG`, so
no Wi-Fi password or key is compiled in), and publishes `bootloader.bin`,
`partitions.bin`, `firmware.bin` and `tmflash-manifest.json`, which names each
file by size and SHA-256 and records the version and commit. The tag is
derived from `TM_FW_VERSION` (`tmsense-1.5` is release `v1.5`), and a version
that is already released is refused: a version a node reports names one image.
**Publishing a release is what puts firmware on newly flashed nodes.**

**Fetching.** A browser cannot download a GitHub release itself: the download
host sends no CORS header, and the console's CSP allows connections to its own
origin only. So the edge fetches it (`GitHubReleaseSource`), with no token,
from `github.com` and GitHub's download hosts only, over https; a redirect
anywhere else ends the fetch. It checks every file against the manifest's size
and SHA-256, then builds the flash plan from the three: an ESP32-S3
bootloader for 8 MB flash, a partition table whose checksum holds and whose
writes clear NVS, and an application that reports the version the release
claims. A release that fails any check is not offered at all, and an older
one is not offered in its place. The result is held in memory and re-confirmed
with GitHub at most once a minute; if GitHub is unreachable, the release
already checked stays on offer, with the time it was last confirmed.

**Serving.** `GET /api/flash/firmware` describes the release and
`GET /api/flash/firmware/<tag>/<file>` returns a file, to signed-in members.
Both are read-only. The page checks each file's SHA-256 again and builds the
same plan before it touches the board. The edge needs outbound https to
GitHub; without it the page says the release could not be reached, and
settings-only setup still works.

What this trusts: GitHub's TLS, and whoever may run the Release workflow on
that repository. The release is not signed beyond that. Add required
reviewers to the workflow's `firmware-release` environment to make publishing
need a second person.

Only the latest release is offered; there is no picking an older one.

## Code

```
src/shared/flasher/settings.ts      what is written, its limits, the console commands
src/shared/flasher/node-console.ts  show / set / save / reboot, verification, the provisioning order
src/shared/flasher/images.ts        the write plan and the never-erases-NVS check
src/shared/flasher/md5.ts           MD5, to compare flash with what was sent
algo-app/src/console/Flash.tsx      the page
algo-app/src/console/flash/serial.ts       Web Serial: the chooser, the console link, the reset
algo-app/src/console/flash/esp.ts          esptool-js: connect, write, verify
algo-app/src/console/flash/release.ts      the release: download from the console, re-check, plan
algo-app/src/console/flash/api.ts          the adoption calls
src/shared/flasher/release.ts       the release manifest, read strictly (writer: TMsense tools/release_manifest.py)
src/infrastructure/firmware-release/github-release-source.ts  the edge's fetch from GitHub, checks, one-minute memory
src/modules/firmware/routes/published-release-router.ts       /api/flash
```

`src/shared/flasher` mirrors `TMflash/Sources/TMflashCore` (NodeSettings,
NodeConsole, Pipeline) and both speak the console protocol of
`TMsense/src/tm_settings.cpp`. A change to a `show` field name or a `set`
reply has to reach all three.

`esptool-js` is Espressif's loader, pinned to an exact version in
`algo-app/package.json`. It is loaded when a flash starts, not with the page.

## Tests

- `test/flasher.test.ts` (in `npm test`): the provisioning order, read-back
  verification, refusals, secrets never reaching the log or an error, the
  write plan, and every way a plan is refused. With a PlatformIO build of
  `../TMsense` on the machine it also checks the plan against PlatformIO's own
  flash metadata, byte for byte.
- `test/flasher-release.test.ts` (in `npm test`): the release source against
  `test/fake-github.ts`. Only GitHub is contacted, a redirect elsewhere ends
  the fetch, a file that differs from its manifest or a release that is not
  flashable TMsense is never offered, no release is said plainly, and the
  routes accept nothing. With `TMSENSE_DIR` pointing at a TMsense checkout
  that has a `tmflash` build, a release packaged by TMsense's own tool goes
  through this reader.
- `test/web-flasher.test.mjs` (in `npm run test:algo-mobile`): the real page
  and the real esptool-js against `test/fake-esp32.ts`, a board that records
  every loader command and every region erased, with the firmware arriving
  from the fake GitHub through the real edge.
- `test/algoconsole.test.ts`: who may queue a request, and that queuing admits
  nothing.

None of these involves a physical board. Before relying on a change to
`esp.ts`, `serial.ts` or `images.ts`, flash a real one.
