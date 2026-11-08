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
    var c = { ok: true, off: fn.off, len: CFG_LEN, sub: f.sub, rs: f.rs };
    c.patchedBytes = configuredPatched(im, c).toString('hex');
    var cur = buf.toString('hex', c.off, c.off + c.len);
    /* stock when it still tail-jumps to subscribeEvents and never jumps/calls
     * requestStream in the owned window. */
    var stock = scan(buf, fn.off, fn.end, [0xe9]).some(function (p) { return im.rel(p + 1, p + 5) === f.sub; }) &&
        !im.calls(fn.off, fn.off + CFG_LEN).some(function (x) { return x.to === f.rs; });
    c.state = cur === c.patchedBytes ? 'patched' : stock ? 'stock' : 'unknown';
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
    return out;
}

module.exports = { locate: locate };
