# "appear and stay" — a bounded ShowUI retry in carplay

**Status: IMPLEMENTED behind `--retry` (OFF by default), EXPERIMENTAL, UNVERIFIED
ON THE CAR.** The patcher mechanics (apply / status / revert) are byte-tested
against the real carplay 22.28.3 image and revert byte-identically. What is NOT
verified is the runtime behaviour: whether keyframes arrive during the black
screen, whether N=6 is right, and whether `[this+0x51]` is truly a free object
byte. **The car is the test. Keep the backup; revert if anything misbehaves.**

## How to turn it on (on the head unit)
```
node carplay_patch.js apply --panel high --retry --yes     # immediate + bounded retry
node carplay_patch.js apply --panel high --no-retry --yes  # keep immediate, drop retry
node carplay_patch.js status                               # shows "retry map: ON/off"
node carplay_patch.js revert --yes                         # back to stock carplay
```
`--retry` implies `--immediate`. It writes three edits on top of the immediate
map: the `unlatch` byte, the `modesChanged` slot (counter stub), and the
configured handler's "reset" variant (inits the counter). `N` (re-ShowUI budget
per session) is `RETRY_DEFAULT_N` in `immediate_locate.js` (default 6).

**First on-car step:** reproduce the black screen and check the carplay DLT log
for **"Key frame emitted"** (see below) — it confirms the premise before trusting
the retry. Then test parked (map should come up and STAY) and driving (change
modes after it's up — the banner must NOT shift).

---

_Original design notes below._

**The new "stop" and its storage still need on-car iteration. Do NOT trust it
blind.**

Goal: on a parked/no-route map the phone stays **connected but black** (it
sends a frame only ~every 10 s, or the first keyframe was missed on a cold
AVB join). A repeated **ShowUI + ForceKeyframe** makes it draw. We want that
retry **to stop the instant the map is really up**, so it never re-ShowUIs a
drawing map — that re-ShowUI is what produced the old "double shift".

This builds on the two **proven** waze-cluster-autostart edits (`modes`,
`unlatch`) and adds the one thing they lacked: a **stop**.

## Confirmed anchors (carplay 22.28.3, build-id 5de62156…, x86-64)

| what | addr (va) | notes |
|---|---|---|
| `AlternateDisplays::requestStream()` | `0x181810` | issues ShowUI + ForceKeyframe + setStreamStatus |
| the guard in requestStream | `0x18186c` | `cmp dword[rbx+0x48],2 ; je 0x181928` — skips the ShowUI body while status==STREAMING(2); `rbx = this` |
| ShowUI body entry (past the guard) | `0x181876` | force-redraw entry point |
| final `setStreamStatus(STREAMING)` arg store | in requestStream | `mov dword[rsp+8],2` — **unlatch** flips the `02`→`01` |
| `setStreamStatus()` | `0x181560` | its message is **inert outside carplay** (never reaches the phone) |
| `onSuggestUi()` | `0x1816f0` | stock trigger; also skips while STREAMING |
| `onStreamCommandChanged()` | `0x181b50` | HU command handler; carplay is a *client* of ProjectedModeGuiding → HU cannot send it without impersonating BMW nav |
| `onStartStreaming()` | `0x180ee0` | fires when streaming starts; stock = log only |
| `OnKeyFrame()` (projection bridge) | `0x1fc810` | "Key frame emitted"; different object (no path to AlternateDisplays `this`) |
| `modesChanged` slot | located structurally | the repeating trigger (see below) |
| the `configured` flag | `[this+0x50]` byte | set by the projectionBridgeConfigured handler (already patched for immediate map) |

Only `onSuggestUi` and `onStreamCommandChanged` call requestStream in stock;
**neither repeats** during the black window → nothing retries. That is why
the map stays black.

## The three edits

### E1 — trigger (port autostart `modes`, proven)
Rewrite the `modesChanged` slot (12 owned bytes) to re-run requestStream while
configured:
```
cmp byte [rdi+0x50], 0      ; configured?
je  <ret>
jmp requestStream           ; rdi is still `this`; tail jmp keeps the stack
```
`modesChanged` fires repeatedly through a session (screen/audio/speech/phone/
turn-by-turn ownership), so it re-ShowUIs during startup. Locator: autostart
`locateModes` (reuse verbatim).

### E2 — bypass the status latch (port autostart `unlatch`, proven)
The one-byte flip of requestStream's final `setStreamStatus` argument
`0x02`(STREAMING) → `0x01`(AVAILABLE), so the guard at `0x18186c` does not latch
and E1's re-runs actually reach ShowUI. Inert outside carplay. Locator:
autostart `locateUnlatch` (reuse verbatim).

### E3 — the NEW stop (what the old pair lacked → the whole point)
E1+E2 alone re-ShowUI **forever** (modesChanged keeps firing after the map is
up) → re-ShowUI on a drawing map → **double shift**. Add a stop. Two options,
pick on-car:

**E3-A — bounded counter (deterministic, ship this first).**
A small counter `N` (e.g. 3–5, tuned on-car). The projectionBridgeConfigured
handler (already ours) resets it to `N` per session. E1 becomes:
```
cmp byte [rdi+0x50], 0      ; configured?
je  <ret>
cmp byte [COUNTER], 0       ; retries left?
je  <ret>
dec byte [COUNTER]
jmp requestStream
```
After `N` mode-changes it stops — the startup window is covered, steady-state
mode changes no longer re-ShowUI. We jmp away from the slot immediately, so the
rest of the slot body is a code cave with room for this stub.
*Open item:* `COUNTER` storage — a RIP-relative writable byte. Candidates:
(a) a spare byte in the AlternateDisplays object past `[this+0x50]` (needs a
confirmed-free offset), or (b) a writable global in .bss referenced RIP-relative.
Must be picked and verified against the real image.

**E3-B — latch on real streaming (cleaner, validate timing).**
Keep E2 (requestStream stores AVAILABLE), and instead patch `onStartStreaming`
(`0x180ee0`, stock log-only) to store `[this+0x48]=2` (STREAMING). Then: while
black the status stays AVAILABLE → E1 re-fires; when the stream **really**
starts → onStartStreaming latches STREAMING → the guard blocks further ShowUI →
auto-stop, tied to real drawing, no counter. *Risk:* only works if
onStartStreaming fires at true first-frame, not optimistically — confirm on-car.

### Reset per session
The projectionBridgeConfigured handler (the `configured` edit) runs at each new
CarPlay session; extend it to reset the stop state (E3-A: COUNTER=N; E3-B:
nothing extra — the status naturally re-opens). Re-arms the retry on every
reconnect.

## Why no double shift
Every retry fires only while the map is **not yet up** (E3-A: within the first
N mode-changes of a session; E3-B: while status != STREAMING). The moment it is
up, retries stop. No ShowUI reaches a drawing map → the safe-area offset is
applied exactly once.

## On-car validation (required before shipping)
1. **Confirm the premise:** reproduce the black screen, check the carplay DLT
   log for **"Key frame emitted"** during it.
   - present → keyframes arrive (black frames) → this design is valid.
   - absent → the phone sends nothing; E1/modesChanged still fires on mode
     changes, but confirm a retry actually un-blacks it.
2. Flash E1+E2+E3-A with a conservative `N`, parked, no route: the map should
   come up within a few mode-changes and **stay put** (no rightward creep).
3. Drive a route, change audio/screen modes repeatedly **after** the map is up:
   the banner must **not** shift → confirms the stop works.
4. If E3-A stops too early/late, tune `N`; then try E3-B and compare.

## Packaging / rollback
Ship as **optional edits** of the immediate-map feature (extend
`immediate_locate.js` with the `modes`/`unlatch`/stop sites, gate behind the
existing `--immediate` or a new `--retry` flag), each in **its own commit** so
it reverts without touching the working map. Validate on the emulator where
possible; the stream behaviour itself only shows on the car.
