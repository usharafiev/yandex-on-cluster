# yandex-on-cluster

A fork of [idrive-apps](https://github.com/robertnisipeanu/idrive-apps)'s
waze-on-cluster, tuned for **Yandex Maps** on the BMW iDrive 7 (MGU) CarPlay
instrument cluster. It folds two former add-on tools
([cluster-yandex-safearea-fix] and [waze-cluster-autostart]) back into
waze-on-cluster itself, so there is nothing to fight with on every update.

**Drop-in:** component ids stay `waze-on-cluster` (and the app's), so a car
installs this as an update of waze-on-cluster **from this fork's source**, not
as a parallel component. Only the repo is named yandex-on-cluster.

## What it changes vs upstream

- [x] **Yandex safe area by default.** `carplay_patch.js` `SAFE_DEFAULT` x = 433
      (was 286), and the app's `SAFE` constant matches, so **Enable map** writes
      the Yandex offset directly and the app shows *Patched*, not *Update needed*
      — no separate safe-area tool, no boot service.
- [x] **Immediate appearance** — waze-cluster-autostart's `configured` edit
      (+ `throws` guard), ported as an **optional** carplay edit in a new
      `immediate_locate.js` and the `--immediate` / `--no-immediate` flag of
      `carplay_patch.js`. `projectionBridgeConfigured` also calls
      `requestStream()` once at the CarPlay session, so the map starts without a
      route; it fires once and the stream status then latches, so nothing
      re-fires on a showing map. `unlatch` and `modes` are deliberately NOT
      ported (those cause the double shift). Tested 13/13 on the car's carplay
      22.28.3 image.
- [x] **A menu checkbox for it.** patchd keeps the choice (`immediate.conf`,
      not MAP_STATE), passes `--immediate`/`--no-immediate` on every apply and
      reports `immediate` / `immediate_available` in status; the app has
      `immediateOn()/toggleImmediate()` and a `wocImmediate` checkbox
      ("Show map immediately"). Toggling re-applies only when the map is
      enabled, so it never enables the map for someone who turned it off.
      **The RHMI model + app build are validated on the emulator** (not on
      Windows). Kept in its own commit so it can be reverted without touching
      the working map.
- [~] **kWaiting → re-trigger: NOT DONE — not feasible.** The idea (the render,
      on a blank `MapFeed`/`kWaiting`, re-triggers the projection start) has no
      path: the "waiting" state lives in the render, but `requestStream` is
      called only inside carplay, and nothing on the head-unit side (patchd,
      the app, the render) can reach carplay to trigger it — patchd only
      *observes* the DLT markers (`CARPLAY_MARKERS`), it cannot send them. So a
      missed first keyframe (cold-start AVB late-join, rare) still needs a
      CarPlay reconnect. The immediate start itself (configured) is unaffected.
- [x] **Drop-in, repo named yandex-on-cluster.** Component ids stay
      `waze-on-cluster` / `robertn_waze_cluster`.

## Publish for mgu-store (this fork)

This repo keeps upstream's release pipeline, and it already resolves itself
as `github:usharafiev/yandex-on-cluster` (`node release/release.js list`), so
no catalog URL has to be set by hand. The Store installs from the **releases
channel**: a run of the pipeline builds each component, uploads it as a
release asset, and publishes a `catalog.json` the Store reads over HTTPS.

**Keep the repo private.** Private is the "me-only" channel — nobody else can
point a Store at a repo they cannot see. The pipeline publishes a private
repo the same way (`MGU_PUBLISH_VISIBILITY=any`), and the car downloads the
assets by their GitHub API URL with the owner's token, so the Store source
has to be signed in to GitHub.

**To publish** (component ids stay the same as upstream, so this lands as an
*update* of `waze-on-cluster` / the app from this source, not a parallel
component):

1. GitHub → **Actions → Release → Run workflow**, on the `yandex` branch
   (the default). Leave *Component ids* empty to release every changed
   component, or list `cluster-render waze-on-cluster robertn_waze_cluster`
   on the first run. Tick **Dry run** first to see what it would stamp/build
   without pushing or publishing.
2. A real run stamps the next versions (the app's CHANGELOG `## Unreleased`
   becomes the release notes), pushes the `release:` commit, builds each
   component twice, uploads the new versions and the catalog, and tags each
   `<id>@<version>`.
3. On the car, in the Store, point the `waze-on-cluster` source at this repo
   (releases channel) and update. The native render is unchanged from
   upstream, so only `waze-on-cluster` and the app actually change.

A USB/offline catalog instead of GitHub Releases:
`MGU_PUBLISH=dir:<folder> node release/release.js publish` (needs the POSIX
build toolchain — it cross-builds the native component, which does not run on
Windows).

## Build / install (the car)

The native render is **unchanged from upstream** (no C++ edits), so it builds as
upstream does. The changes are all JS (the carplay patcher + patchd + the app +
one RHMI component). Build and publish a release from this fork the way upstream
does (`release/release.js publish`, idrive-apps AGENTS.md), then install
`waze-on-cluster` (and the app) from that release on the car. The JS patcher
edits are tested against the car's real carplay 22.28.3 image (build-id
`5de62156…`); the RHMI checkbox and the app build want an emulator pass.

If the checkbox misbehaves on the head unit, revert the single
`immediate map: the menu checkbox (wocImmediate)` commit — the map keeps working.

[cluster-yandex-safearea-fix]: https://github.com/usharafiev/cluster-yandex-safearea-fix
[waze-cluster-autostart]: https://github.com/usharafiev/waze-cluster-autostart
