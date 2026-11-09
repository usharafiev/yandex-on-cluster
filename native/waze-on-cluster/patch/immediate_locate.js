// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 yandex-on-cluster contributors
// Derived from carplay_locate.js and waze-cluster-autostart's autostart_locate.js
// (Copyright (C) 2026 Robert Nisipeanu / waze-cluster-autostart contributors),
// GPL-3.0-or-later. The ELF/function-table helpers are carplay_locate.js's; the
// site locators below are waze-cluster-autostart's `configured` and `throws`.
/* immediate_locate.js — finds the two sites the "immediate map" option edits on
 * top of waze-on-cluster's patch, in a carplay build, by code and data
 * structure. It carries only these two (the `unlatch` and `modes` retry edits
 * of waze-cluster-autostart are deliberately NOT here: a re-run of
 * requestStream while the map already shows makes the phone re-lay-out with the
 * offset applied twice — the retry is the render's kWaiting re-trigger instead):
 *
 *   configured  AlternateDisplays' projectionBridgeConfigured handler: the
 *               small function that sets its "configured" flag [this+0x50]=1
 *               and tail-calls subscribeEvents(). Retarget it to also call
 *               requestStream() once, so the cluster stream starts when the
 *               projection bridge is configured (at the CarPlay session), not
 *               only when the phone later suggests its UI (onSuggestUi, which on
 *               some phones happens only once guidance begins).
 *   throw1/2    the two throwOnCinemoError calls in requestStream(), after
 *               ShowUI() and ForceKeyframe(). Turn each into a branch to the
 *               function's normal return, so a ShowUI/ForceKeyframe error at the
 *               earlier, bridge-time start returns quietly instead of throwing.
 *
 * Each site is found exactly once and verified before any write; a build where
 * one is missing or reads as neither stock nor this edit is refused. It only
 * reads the buffer. Node 8 on the unit, no dependencies.
 */
'use strict';

/* ---- ELF helpers (from carplay_locate.js) ------------------------------- */

function u64(buf, off) { return buf.readUInt32LE(off + 4) === 0 ? buf.readUInt32LE(off) >>> 0 : null; }

function parseElf(buf) {
    if (buf.length < 64 || buf.readUInt32BE(0) !== 0x7f454c46) return { reason: 'not an ELF file' };
    if (buf[4] !== 2 || buf[5] !== 1 || buf.readUInt16LE(18) !== 62) return { reason: 'not a 64-bit little-endian x86-64 ELF' };
    var phoff = u64(buf, 0x20), phentsize = buf.readUInt16LE(0x36), phnum = buf.readUInt16LE(0x38);
    if (phoff === null || phoff + phnum * phentsize > buf.length) return { reason: 'ELF program headers out of range' };
    var elf = { load: [], exec: null, eh: null, notes: [] };
    for (var i = 0; i < phnum; i++) {
        var o = phoff + i * phentsize, type = buf.readUInt32LE(o);
        var seg = { off: u64(buf, o + 8), va: u64(buf, o + 16), size: u64(buf, o + 32) };
        if (seg.off === null || seg.va === null || seg.size === null || seg.off + seg.size > buf.length) continue;
        if (type === 1) {
            elf.load.push(seg);
            if ((buf.readUInt32LE(o + 4) & 1) && !elf.exec) elf.exec = { off: seg.off, end: seg.off + seg.size };
        } else if (type === 0x6474e550) elf.eh = seg;
        else if (type === 4) elf.notes.push(seg);
    }
    if (!elf.exec) return { reason: 'no executable ELF segment' };
    return elf;
}

function buildId(buf, notes) {
    for (var n = 0; n < notes.length; n++) {
        for (var o = notes[n].off, end = o + notes[n].size; o + 12 <= end;) {
            var namesz = buf.readUInt32LE(o), descsz = buf.readUInt32LE(o + 4);
            var desc = o + 12 + ((namesz + 3) & ~3);
            if (desc + descsz > end) break;
            if (buf.readUInt32LE(o + 8) === 3 && namesz === 4 && buf.toString('latin1', o + 12, o + 16) === 'GNU\0')
                return buf.toString('hex', desc, desc + descsz);
            o = desc + ((descsz + 3) & ~3);
        }
    }
    return null;
}

function Image(buf, elf) {
    this.buf = buf;
    this.load = elf.load;
    this.exec = elf.exec;
    this.starts = funcStarts(buf, elf.eh);
}
Image.prototype.va = function (off) {
    for (var i = 0; i < this.load.length; i++) { var s = this.load[i]; if (off >= s.off && off < s.off + s.size) return s.va + (off - s.off); }
    return null;
};
Image.prototype.off = function (va) {
    for (var i = 0; i < this.load.length; i++) { var s = this.load[i]; if (va >= s.va && va < s.va + s.size) return s.off + (va - s.va); }
    return null;
};
Image.prototype.func = function (off) {
    var va = this.va(off), s = this.starts, lo = 0, hi = s.length - 1, at = -1;
    while (lo <= hi) { var mid = (lo + hi) >> 1; if (s[mid] <= va) { at = mid; lo = mid + 1; } else hi = mid - 1; }
    if (at < 0) return null;
    var start = this.off(s[at]);
    var end = at + 1 < s.length ? this.off(s[at + 1]) : this.exec.end;
    return start === null || end === null || end > this.exec.end ? null : { off: start, end: end };
};
Image.prototype.rel = function (pos, next) { var va = this.va(next); return va === null ? null : this.off((va + this.buf.readInt32LE(pos)) >>> 0); };
Image.prototype.calls = function (start, end) {
    var out = [];
    for (var p = start; p + 5 <= end; p++) if (this.buf[p] === 0xe8) { var to = this.rel(p + 1, p + 5); if (to !== null) out.push({ at: p, to: to }); }
    return out;
};

function funcStarts(buf, eh) {
    if (!eh || eh.size < 12 || buf.readUInt32BE(eh.off) !== 0x011b033b) return [];
    var count = buf.readUInt32LE(eh.off + 8), table = eh.off + 12;
    if (table + count * 8 > eh.off + eh.size) return [];
    var starts = [];
    for (var i = 0; i < count; i++) starts.push((eh.va + buf.readInt32LE(table + i * 8)) >>> 0);
    return starts.sort(function (a, b) { return a - b; });
}

function scan(buf, start, end, pat) {
    var out = [];
    for (var i = start; i + pat.length <= end; i++) {
        if (buf[i] !== pat[0]) continue;
        for (var j = 1; j < pat.length && (pat[j] === null || buf[i + j] === pat[j]); j++);
        if (j === pat.length) out.push(i);
    }
    return out;
}
function any(n) { var a = []; while (n--) a.push(null); return a; }
function stringAt(buf, off) { var end = buf.indexOf(0, off); return buf.toString('latin1', off, end < 0 ? buf.length : end); }

function namedString(buf, key, re, label) {
    var found = [], k = Buffer.from(key, 'latin1');
    for (var i = buf.indexOf(k); i >= 0; i = buf.indexOf(k, i + 1)) {
        var s = i;
        while (s > 0 && buf[s - 1] >= 0x20 && buf[s - 1] < 0x7f) s--;
        if (found.indexOf(s) < 0 && re.test(stringAt(buf, s))) found.push(s);
    }
    if (found.length === 1) return { off: found[0] };
    return { err: label + (found.length ? ' string found ' + found.length + ' times' : ' string not found') };
}

function leaRefs(im, offs) {
    var want = {}, out = {}, buf = im.buf;
    offs.forEach(function (o) { var va = im.va(o); if (va !== null) { want[va] = o; out[o] = []; } });
    for (var p = im.exec.off + 1; p + 6 <= im.exec.end; p++) {
        if (buf[p] !== 0x8d || (buf[p - 1] & 0xfb) !== 0x48 || (buf[p + 1] & 0xc7) !== 0x05) continue;
        var va = im.va(p + 6);
        var t = va === null ? null : want[(va + buf.readInt32LE(p + 2)) >>> 0];
        if (t !== undefined && t !== null) out[t].push(p - 1);
    }
    return out;
}

function funcOfString(im, refs, str, label) {
    if (str.err) return str;
    var sites = refs[str.off] || [];
    if (!sites.length) return { err: label + ' string not referenced' };
    var f = im.func(sites[0]);
    for (var i = 1; f && i < sites.length; i++) { var g = im.func(sites[i]); if (!g || g.off !== f.off) return { err: label + ' used by several functions' }; }
    return f || { err: label + ' outside the function table' };
}

function hex32(n) { return Buffer.from([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]).toString('hex'); }

/* ---- names ----- */
var NAMES = {
    ss: ['AlternateDisplays::setStreamStatus(', /^void [\w:]*AlternateDisplays::setStreamStatus\(/, 'setStreamStatus'],
    rs: ['AlternateDisplays::requestStream()', /^void [\w:]*AlternateDisplays::requestStream\(\)$/, 'requestStream'],
    sub: ['AlternateDisplays::subscribeEvents()', /^void [\w:]*AlternateDisplays::subscribeEvents\(\)$/, 'subscribeEvents'],
    showUi: ['mCinemoCarPlay->ShowUI(', /^mCinemoCarPlay->ShowUI\(/, 'ShowUI'],
    keyframe: ['mCinemoCarPlay->ForceKeyframe(', /^mCinemoCarPlay->ForceKeyframe\(/, 'ForceKeyframe'],
};

/* ---- requestStream + setStreamStatus + subscribeEvents ------------------ */
/* requestStream must reference ShowUI and ForceKeyframe and call
 * setStreamStatus (the same checks waze-on-cluster's self-start locator uses),
 * so this tool is pointing at the real stream-start function. */
function locateFuncs(im, str, refs) {
    if (!im.starts.length) return { err: 'no function table' };
    var ss = funcOfString(im, refs, str.ss, NAMES.ss[2]);
    var rs = funcOfString(im, refs, str.rs, NAMES.rs[2]);
    var sub = funcOfString(im, refs, str.sub, NAMES.sub[2]);
    var err = ss.err || rs.err || sub.err || str.showUi.err || str.keyframe.err;
    if (err) return { err: err };
    function inRs(o) { return (refs[o] || []).some(function (p) { return p >= rs.off && p < rs.end; }); }
    if (!inRs(str.showUi.off) || !inRs(str.keyframe.off)) return { err: 'requestStream lacks ShowUI/keyframe' };
    if (!im.calls(rs.off, rs.end).some(function (c) { return c.to === ss.off; })) return { err: 'requestStream lacks setStreamStatus' };
    return { ss: ss.off, rs: rs.off, rsEnd: rs.end, sub: sub.off };
}

/* ---- Edit A: the projectionBridgeConfigured handler --------------------- */
/* The small function that sets the configured flag and tail-jumps to
 * subscribeEvents: sub rsp,0x18 ; mov byte [rdi+0x50],1 ; (stack-cookie
 * prologue) ; add rsp,0x18 ; jmp subscribeEvents. It is the only function
 * that does `mov byte [rdi+0x50],1` and tail-jumps (e9) to subscribeEvents.
 * This tool rewrites it to call subscribeEvents and then jmp requestStream. */
var CFG_PROLOGUE = '4883ec18c6475001';   /* sub rsp,0x18 ; mov byte [rdi+0x50],1 */
var CFG_LEN = 30;                        /* the bytes our rewrite occupies */
/* The optional "retry" (bounded re-ShowUI) feature (see locateRetry below) adds
 * a per-session counter. It is stored in a free object byte at [this+0x51],
 * right after the configured flag at [this+0x50]; the configured handler's
 * rewrite initialises it (the +4-byte "reset" variant, 34 bytes), and the
 * modesChanged slot decrements it. EXPERIMENTAL: the 0x51 offset is padding on
 * this build as far as static analysis shows, but is confirmed only on the car. */
var CFG_LEN_RETRY = 34;                  /* the configured rewrite with the counter init */
var RETRY_COUNTER_OFF = 0x51;            /* [this+0x51] holds the retry counter */
var RETRY_DEFAULT_N = 6;                 /* mode-changes to re-ShowUI before latching off */
function locateConfigured(im, f) {
    var buf = im.buf;
    /* the function whose body starts with the configured-flag prologue and
     * references subscribeEvents (stock: a tail jmp e9; our patch: a call e8). */
    var found = [];
    for (var p = im.exec.off; p + 8 <= im.exec.end; p++) {
        if (buf.toString('hex', p, p + 8) !== CFG_PROLOGUE) continue;
        var fn = im.func(p);
        if (fn && fn.off === p) found.push(fn);
    }
    if (found.length !== 1) return { ok: false, reason: 'configured: handler prologue ' + (found.length ? 'found ' + found.length + ' times' : 'not found') };
    var fn = found[0];
    var refsSub = im.calls(fn.off, fn.end).some(function (c) { return c.to === f.sub; }) ||
        scan(buf, fn.off, fn.end, [0xe9]).some(function (p) { return im.rel(p + 1, p + 5) === f.sub; });
    if (!refsSub) return { ok: false, reason: 'configured: handler does not reference subscribeEvents' };
    /* We own only the 30 bytes our rewrite occupies at the function start; the
     * stock bytes after our `jmp requestStream` become dead code (the function
     * table and unwind info still span the whole function unchanged). */
    var c = { ok: true, off: fn.off, len: CFG_LEN, sub: f.sub, rs: f.rs, fnEnd: fn.end };
    c.patchedBytes = configuredPatched(im, c).toString('hex');
    /* the "reset" variant (immediate + retry): initialises the retry counter at
     * [this+0x51]; only usable when the function is long enough (it is: 64 B). */
    c.retryFits = fn.end - fn.off >= CFG_LEN_RETRY;
    c.patchedBytesRetry = c.retryFits ? configuredResetPatched(im, c, RETRY_DEFAULT_N).toString('hex') : null;
    var cur = buf.toString('hex', c.off, c.off + c.len);
    var curRetry = buf.toString('hex', c.off, c.off + CFG_LEN_RETRY);
    /* stock when it still tail-jumps to subscribeEvents and never jumps/calls
     * requestStream in the owned window. */
    var stock = scan(buf, fn.off, fn.end, [0xe9]).some(function (p) { return im.rel(p + 1, p + 5) === f.sub; }) &&
        !im.calls(fn.off, fn.off + CFG_LEN).some(function (x) { return x.to === f.rs; });
    c.retryApplied = c.patchedBytesRetry !== null && curRetry === c.patchedBytesRetry;
    c.state = c.retryApplied || cur === c.patchedBytes ? 'patched' : stock ? 'stock' : 'unknown';
    if (c.state === 'unknown') { c.ok = false; c.reason = 'configured: handler is neither stock nor this tool\'s patch'; }
    c.stockBytes = c.state === 'stock' ? cur : null;
    return c;
}

/* This tool's rewrite of the configured handler region (padded with int3):
 * sub rsp,0x18 ; mov byte[rdi+0x50],1 ; mov [rsp],rdi ; call subscribeEvents ;
 * mov rdi,[rsp] ; add rsp,0x18 ; jmp requestStream. Byte layout: prologue 8,
 * mov [rsp],rdi 4 (off+8), call 5 (off+12, next off+17), mov rdi,[rsp] 4
 * (off+17), add rsp,0x18 4 (off+21), jmp 5 (off+25, next off+30). */
function configuredPatched(im, c) {
    var callSub = 'e8' + hex32(im.va(c.sub) - im.va(c.off + 17));
    var jmpRs = 'e9' + hex32(im.va(c.rs) - im.va(c.off + 30));
    return Buffer.from(CFG_PROLOGUE + '48893c24' + callSub + '488b3c24' + '4883c418' + jmpRs, 'hex');
}

/* The "reset" variant: like configuredPatched but also inits the retry counter
 * `mov byte [rdi+0x51],N` after setting the configured flag. Layout: prologue 8,
 * mov byte[rdi+0x51],N 4 (off+8), mov [rsp],rdi 4 (off+12), call 5 (off+16,
 * next off+21), mov rdi,[rsp] 4 (off+21), add rsp,0x18 4 (off+25), jmp 5
 * (off+29, next off+34). */
function configuredResetPatched(im, c, n) {
    var setN = 'c647' + Buffer.from([RETRY_COUNTER_OFF]).toString('hex') + Buffer.from([n & 0xff]).toString('hex');
    var callSub = 'e8' + hex32(im.va(c.sub) - im.va(c.off + 21));
    var jmpRs = 'e9' + hex32(im.va(c.rs) - im.va(c.off + 34));
    return Buffer.from(CFG_PROLOGUE + setN + '48893c24' + callSub + '488b3c24' + '4883c418' + jmpRs, 'hex');
}

/* ---- Retry edit C: un-latch the stream status (from waze-cluster-autostart) --
 * requestStream ends with setStreamStatus(STREAMING=2): `mov dword [rsp+8],2`
 * before the call latches mStreamStatus to STREAMING, so a start the render
 * missed is never retried (the guard `cmp [this+0x48],2` skips). This flips the
 * low byte of that immediate 0x02->0x01 (AVAILABLE), so the guard does not latch
 * and a later trigger re-runs requestStream. Inert outside carplay. One byte. */
function locateUnlatch(im, f) {
    var buf = im.buf;
    var ssCall = im.calls(f.rs, f.rsEnd).filter(function (c) { return c.to === f.ss; });
    if (ssCall.length !== 1) return { ok: false, reason: 'unlatch: setStreamStatus call ' + (ssCall.length ? 'found ' + ssCall.length + ' times' : 'not found') };
    var at = ssCall[0].at;
    var stores = scan(buf, at - 24, at, [0xc7, 0x44, 0x24, 0x08]).filter(function (p) {
        if (p + 8 > at) return false;
        var v = buf.readUInt32LE(p + 4);
        return v === 2 || v === 1;
    });
    if (stores.length !== 1) return { ok: false, reason: 'unlatch: STREAMING argument store ' + (stores.length ? 'found ' + stores.length + ' times' : 'not found') };
    var off = stores[0] + 4, v = buf.readUInt32LE(off);
    return { ok: true, off: off, len: 1, stock: '02', patched: '01', state: v === 1 ? 'patched' : 'stock' };
}

/* ---- Retry edit D: the modesChanged slot (from waze-cluster-autostart, with a
 * bounded counter added) --------------------------------------------------- */
/* AlternateDisplays' slot for ICarPlayEvents::modesChanged. Stock: the only
 * function that compares `dword [rsi+0x14]` with 1, compares `byte [rdi+0x50]`
 * with 0 and calls setStreamStatus. Autostart rewrote it to re-run requestStream
 * on every mode change (which draws, but never stops -> double shift). This
 * tool's stub stops after N retries per session, using the counter at
 * [rdi+0x51] (init by the configured reset variant):
 *     cmp byte [rdi+0x50],0 ; je ret ; cmp byte [rdi+0x51],0 ; je ret ;
 *     dec byte [rdi+0x51] ; jmp requestStream ; ret         (21 bytes) */
var MODES_CMP_MODE = [0x83, 0x7e, 0x14, 0x01];   /* cmp dword [rsi+0x14],1 */
var MODES_CMP_CFG = [0x80, 0x7f, 0x50, 0x00];    /* cmp byte [rdi+0x50],0 */
var MODES_LEN = 21;
function modesPatched(im, off, rs) {
    /* 80 7f 50 00 (cfg?) ; 74 0e (je ret@0x14) ; 80 7f 51 00 (counter?) ;
     * 74 08 (je ret@0x14) ; fe 4f 51 (dec counter) ; e9 rel32 (jmp rs, next
     * 0x14) ; c3 (ret) */
    var jmpRs = 'e9' + hex32(im.va(rs) - im.va(off + 0x14));
    return Buffer.from('807f5000' + '740e' + '807f' + Buffer.from([RETRY_COUNTER_OFF]).toString('hex') + '00'
        + '7408' + 'fe4f' + Buffer.from([RETRY_COUNTER_OFF]).toString('hex') + jmpRs + 'c3', 'hex');
}
function locateModes(im, f) {
    var buf = im.buf, found = [];
    scan(buf, im.exec.off, im.exec.end, MODES_CMP_MODE).forEach(function (p) {
        var fn = im.func(p);
        if (!fn || found.some(function (g) { return g.off === fn.off; })) return;
        if (!scan(buf, fn.off, fn.end, MODES_CMP_CFG).length) return;
        if (!im.calls(fn.off, fn.end).some(function (c) { return c.to === f.ss; })) return;
        found.push(fn);
    });
    if (found.length > 1) return { ok: false, reason: 'modes: slot found ' + found.length + ' times' };
    if (found.length === 1) {
        var fn = found[0], want = modesPatched(im, fn.off, f.rs).toString('hex');
        if (fn.end - fn.off < MODES_LEN + 4) return { ok: false, reason: 'modes: slot too short' };
        var cur = buf.toString('hex', fn.off, fn.off + MODES_LEN);
        var st = cur === want ? 'patched' : /^4883ec28/.test(cur) ? 'stock' : 'unknown';   /* sub rsp,0x28 */
        if (st === 'unknown') return { ok: false, reason: 'modes: slot is neither stock nor this tool\'s patch' };
        return { ok: true, off: fn.off, len: MODES_LEN, patched: want, stockBytes: st === 'stock' ? cur : null, state: st };
    }
    /* patched: our stub at a function start (cmp cfg ; je ; cmp counter), the
     * stock body after it still holds `cmp dword [rsi+0x14],1`. */
    var pat = [];
    scan(buf, im.exec.off, im.exec.end, [0x80, 0x7f, 0x50, 0x00, 0x74, 0x0e, 0x80, 0x7f, RETRY_COUNTER_OFF]).forEach(function (p) {
        var fn = im.func(p);
        if (!fn || fn.off !== p) return;
        if (!scan(buf, fn.off, fn.end, MODES_CMP_MODE).length) return;
        pat.push(fn);
    });
    if (pat.length !== 1) return { ok: false, reason: 'modes: slot ' + (pat.length ? 'found ' + pat.length + ' times' : 'not found') };
    return { ok: true, off: pat[0].off, len: MODES_LEN, patched: modesPatched(im, pat[0].off, f.rs).toString('hex'), stockBytes: null, state: 'patched' };
}

/* ---- Edit B: the two throwOnCinemoError calls in requestStream ---------- */
/* The throw helper is the function called twice from requestStream, each call
 * preceded by `mov edi,eax` (the CinemoError result). Those two calls are the
 * sites; this tool turns each into `test eax,eax ; jne <return> ; nop`. */
function locateThrows(im, f) {
    var buf = im.buf;
    var calls = im.calls(f.rs, f.rsEnd);
    /* the setStreamStatus call in requestStream; the normal return path begins
     * at the instruction after it (its result is void). */
    var ssCall = calls.filter(function (c) { return c.to === f.ss; });
    if (ssCall.length !== 1) return { ok: false, reason: 'throw: setStreamStatus call ' + (ssCall.length ? 'found ' + ssCall.length + ' times' : 'not found') };
    var ret = im.va(ssCall[0].at + 5);
    if (ret === null) return { ok: false, reason: 'throw: return point out of range' };
    /* the throw helper: the function called twice from requestStream, each
     * call right after `mov edi,eax` (the CinemoError). On a patched binary
     * those calls are gone, so also accept our patched form in their place. */
    var counts = {};
    calls.forEach(function (c) { counts[c.to] = (counts[c.to] || 0) + 1; });
    var raw = calls.filter(function (c) { return counts[c.to] === 2 && buf[c.at - 2] === 0x89 && buf[c.at - 1] === 0xc7; });
    var sites;
    if (raw.length === 2 && raw[0].to === raw[1].to) {
        sites = raw.map(function (c) { return { at: c.at }; });
    } else {
        /* patched: `mov edi,eax ; test eax,eax ; jne ret ; nop` (89 c7 85 c0 75 .. 90) */
        var pat = scan(buf, f.rs, f.rsEnd, [0x89, 0xc7, 0x85, 0xc0, 0x75, null, 0x90]);
        if (pat.length !== 2) return { ok: false, reason: 'throw: expected 2 throwOnCinemoError calls, found ' + raw.length + ' stock / ' + pat.length + ' patched' };
        sites = pat.map(function (p) { return { at: p + 2 }; });   /* the test/jne/nop region, after mov edi,eax */
    }
    var out = sites.map(function (s) {
        var disp = ret - im.va(s.at + 4);   /* 85 c0 (2) ; 75 disp8 (2, next at at+4) ; 90 */
        if (disp < 0 || disp > 127) return null;
        var cur = buf.toString('hex', s.at, s.at + 5);
        var patched = '85c075' + Buffer.from([disp]).toString('hex') + '90';
        return { at: s.at, len: 5, patched: patched, stock: cur, state: cur === patched ? 'patched' : /^e8/.test(cur) ? 'stock' : 'unknown' };
    });
    if (out.indexOf(null) >= 0) return { ok: false, reason: 'throw: return out of jne range' };
    if (out.some(function (s) { return s.state === 'unknown'; })) return { ok: false, reason: 'throw: a call site is neither stock nor this tool\'s patch' };
    return { ok: true, sites: out, state: out.every(function (s) { return s.state === 'patched'; }) ? 'patched' : out.every(function (s) { return s.state === 'stock'; }) ? 'stock' : 'mixed' };
}

/* ---- top level ---------------------------------------------------------- */
function locate(buf) {
    var elf = parseElf(buf);
    if (!elf.load) return { elf: false, reason: elf.reason };
    var im = new Image(buf, elf), str = {}, offs = [];
    Object.keys(NAMES).forEach(function (k) { str[k] = namedString(buf, NAMES[k][0], NAMES[k][1], NAMES[k][2]); if (!str[k].err) offs.push(str[k].off); });
    var refs = leaRefs(im, offs);
    var f = locateFuncs(im, str, refs);
    var out = { elf: true, buildId: buildId(buf, elf.notes) };
    if (f.err) { out.ok = false; out.reason = f.err; return out; }
    out.configured = locateConfigured(im, f);
    out.throws = locateThrows(im, f);
    var fails = ['configured', 'throws'].filter(function (k) { return !out[k].ok; });
    out.ok = fails.length === 0;
    if (!out.ok) out.reason = fails.map(function (k) { return out[k].reason; }).join('; ');
    /* The optional "retry" feature (unlatch + modes-with-counter + the configured
     * reset variant). Not part of out.ok: the base immediate map works without it. */
    out.unlatch = locateUnlatch(im, f);
    out.modes = locateModes(im, f);
    out.retry = {
        ok: out.configured.ok && !!out.configured.retryFits && out.unlatch.ok && out.modes.ok,
        counterOff: RETRY_COUNTER_OFF, n: RETRY_DEFAULT_N,
        reason: [out.unlatch.reason, out.modes.reason,
            out.configured.ok && !out.configured.retryFits ? 'configured handler too short for the counter init' : null].filter(Boolean).join('; ') || null
    };
    out.retryApplied = !!(out.configured.retryApplied && out.unlatch.state === 'patched' && out.modes.state === 'patched');
    return out;
}

module.exports = { locate: locate };
