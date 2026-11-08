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
- [ ] **Immediate appearance** — port ONLY waze-cluster-autostart's `configured`
      edit (+ `throws` guard): `projectionBridgeConfigured` also calls
      `requestStream()` once at the CarPlay session, so the map starts without a
      route. **Do NOT port `unlatch` or `modes`.** Those re-fire `requestStream`
      mid-session (modes on every mode change incl. speech; unlatch lets
      onSuggestUi re-fire), and a re-ShowUI **while the map is already showing**
      is what makes the phone re-lay-out with the offset applied twice (the
      double shift). `configured` fires once and then the stream status latches
      STREAMING, so nothing re-fires on a showing map. Port
      `autostart_locate.js` locate + `autostart_patch.js` apply into
      `carplay_locate.js` / `carplay_patch.js`. JS only.
- [ ] **kWaiting → re-trigger** (the retry, done right, in the render): when
      `MapFeed` stays `kWaiting` (blank) N ms after the stream should be live,
      the render re-triggers the projection start, and stops once a picture
      flows. This recovers a missed first keyframe WITHOUT the double shift: a
      re-trigger while blank has no laid-out scene to double-offset (the phone
      builds it fresh), and it never fires on a showing map. C++ — needs the
      native render rebuilt (toolchain / emulator per idrive-apps AGENTS.md).
      This is why the retry belongs in the fork, not in a carplay-only tool.
- [ ] **Rebrand** repo + titles to yandex-on-cluster, keep component ids.
- [ ] **Publish privately** + install/channel steps (same branch-channel scheme
      as the safearea beta).

## Build / test

Native render + app build per idrive-apps AGENTS.md (emulator). JS patcher edits
are tested against the car's real carplay 22.28.3 image (build-id 5de62156…),
as the add-on tools were.

[cluster-yandex-safearea-fix]: https://github.com/usharafiev/cluster-yandex-safearea-fix
[waze-cluster-autostart]: https://github.com/usharafiev/waze-cluster-autostart
