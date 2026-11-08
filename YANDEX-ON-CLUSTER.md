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
      — no separate safe-area tool, no boot service. (carplay_patch.js,
      waze_cluster_control.js, + test/fixture/readme literals.)
- [ ] **Immediate appearance** (from waze-cluster-autostart's `configured`
      edit): a 5th carplay edit so `projectionBridgeConfigured` also calls
      `requestStream()` — the cluster map starts at the CarPlay session, without
      a route. Port `autostart_locate.js`'s locate + `autostart_patch.js`'s apply
      into `carplay_locate.js` / `carplay_patch.js` as edit `configured`
      (+ `throws` guard so an early ShowUI cannot throw). JS only.
- [ ] **kWaiting → re-trigger** (the "waiting" idea, done right, in the render):
      when `MapFeed` stays `kWaiting` (blank) N ms after the stream should be
      live, the render re-triggers the projection start. C++ — needs the native
      render rebuilt (toolchain / emulator per idrive-apps AGENTS.md).
- [ ] **Rebrand** repo + titles to yandex-on-cluster, keep component ids.
- [ ] **Publish privately** + install/channel steps (same branch-channel scheme
      as the safearea beta).

## Build / test

Native render + app build per idrive-apps AGENTS.md (emulator). JS patcher edits
are tested against the car's real carplay 22.28.3 image (build-id 5de62156…),
as the add-on tools were.

[cluster-yandex-safearea-fix]: https://github.com/usharafiev/cluster-yandex-safearea-fix
[waze-cluster-autostart]: https://github.com/usharafiev/waze-cluster-autostart
