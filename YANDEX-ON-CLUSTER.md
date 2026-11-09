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
