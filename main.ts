// Lossless PNG re-encoder for 1280x720 RGBA screenshots.
//
// For every instance the program decodes the stored PNG to RGBA pixels,
// then searches a fixed, deterministic set of lossless encodings:
//   - colour-type reduction (palette, grey, grey+alpha, RGB, RGBA,
//     with tRNS only where it stays pixel-exact),
//   - per-row PNG filter choices (None/Sub/Up/Avg/Paeth) picked by
//     several deterministic heuristics,
//   - several zlib settings at level 9.
// The smallest valid PNG wins. Work is budgeted by a fixed number of
// trials, never by the clock, so two runs are byte-identical.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync, constants as ZC } from 'node:zlib';

const inputRoot = process.argv[2] || '/input';
const outputRoot = process.argv[3] || '/output';
const MAX_OUT = 4194304;

// ---------- CRC-32 (PNG polynomial) ----------
const crcTable = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c;
}
function crc32(buf, start, len) {
  let c = -1;
  for (let i = start; i < start + len; i++) c = crcTable[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ---------- PNG reading ----------
function parsePng(buf) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) throw new Error('bad signature');
  let pos = 8;
  let ihdr = null;
  let plte = null;
  let trns = null;
  const idatParts = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const dataStart = pos + 8;
    if (type === 'IHDR') {
      ihdr = {
        w: buf.readUInt32BE(dataStart),
        h: buf.readUInt32BE(dataStart + 4),
        bitDepth: buf[dataStart + 8],
        colorType: buf[dataStart + 9],
        interlace: buf[dataStart + 12],
      };
    } else if (type === 'PLTE') {
      plte = buf.subarray(dataStart, dataStart + len);
    } else if (type === 'tRNS') {
      trns = buf.subarray(dataStart, dataStart + len);
    } else if (type === 'IDAT') {
      idatParts.push(buf.subarray(dataStart, dataStart + len));
    } else if (type === 'IEND') {
      break;
    }
    pos = dataStart + len + 4;
  }
  if (!ihdr) throw new Error('no IHDR');
  return { ...ihdr, plte, trns, idat: Buffer.concat(idatParts) };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function unfilter(raw, w, h, bpp) {
  const stride = w * bpp;
  const out = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const up = dst - stride;
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? out[dst + i - bpp] : 0;
      const above = y > 0 ? out[up + i] : 0;
      const upperLeft = y > 0 && i >= bpp ? out[up + i - bpp] : 0;
      let pred = 0;
      if (ft === 1) pred = left;
      else if (ft === 2) pred = above;
      else if (ft === 3) pred = (left + above) >> 1;
      else if (ft === 4) pred = paeth(left, above, upperLeft);
      out[dst + i] = (raw[src + i] + pred) & 255;
    }
  }
  return out;
}

function decodeToRgba(png) {
  if (png.bitDepth !== 8 || png.interlace !== 0) throw new Error('unsupported png');
  const bppByType = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const bpp = bppByType[png.colorType];
  if (!bpp) throw new Error('unsupported colour type');
  const raw = inflateSync(png.idat);
  const px = unfilter(raw, png.w, png.h, bpp);
  const n = png.w * png.h;
  const rgba = new Uint8Array(n * 4);
  const trns = png.trns;
  for (let i = 0; i < n; i++) {
    const s = i * bpp;
    const d = i * 4;
    if (png.colorType === 6) {
      rgba[d] = px[s]; rgba[d + 1] = px[s + 1]; rgba[d + 2] = px[s + 2]; rgba[d + 3] = px[s + 3];
    } else if (png.colorType === 2) {
      rgba[d] = px[s]; rgba[d + 1] = px[s + 1]; rgba[d + 2] = px[s + 2];
      let a = 255;
      if (trns && trns.length >= 6) {
        const tr = (trns[0] << 8) | trns[1];
        const tg = (trns[2] << 8) | trns[3];
        const tb = (trns[4] << 8) | trns[5];
        if (px[s] === tr && px[s + 1] === tg && px[s + 2] === tb) a = 0;
      }
      rgba[d + 3] = a;
    } else if (png.colorType === 0) {
      const g = px[s];
      rgba[d] = g; rgba[d + 1] = g; rgba[d + 2] = g;
      let a = 255;
      if (trns && trns.length >= 2 && g === (((trns[0] << 8) | trns[1]) & 255)) a = 0;
      rgba[d + 3] = a;
    } else if (png.colorType === 4) {
      const g = px[s];
      rgba[d] = g; rgba[d + 1] = g; rgba[d + 2] = g; rgba[d + 3] = px[s + 1];
    } else {
      const idx = px[s];
      rgba[d] = png.plte[idx * 3];
      rgba[d + 1] = png.plte[idx * 3 + 1];
      rgba[d + 2] = png.plte[idx * 3 + 2];
      rgba[d + 3] = trns && idx < trns.length ? trns[idx] : 255;
    }
  }
  return rgba;
}

// ---------- image analysis ----------
function analyze(rgba, n) {
  const counts = new Map();
  let allGrey = true;
  let allOpaque = true;
  let alphaBinary = true;
  const transparentRgb = new Set();
  const transparentGrey = new Set();
  for (let i = 0; i < n; i++) {
    const d = i * 4;
    const r = rgba[d], g = rgba[d + 1], b = rgba[d + 2], a = rgba[d + 3];
    const key = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
    counts.set(key, (counts.get(key) || 0) + 1);
    if (r !== g || g !== b) allGrey = false;
    if (a !== 255) allOpaque = false;
    if (a !== 0 && a !== 255) alphaBinary = false;
    if (a === 0) {
      transparentRgb.add(((r << 16) | (g << 8) | b) >>> 0);
      transparentGrey.add(r);
    }
  }
  let rgbTrns = null;
  if (alphaBinary && transparentRgb.size === 1) {
    const rgb = transparentRgb.values().next().value;
    const opaqueKey = (((rgb >> 16) & 255) << 24 | (((rgb >> 8) & 255) << 16) | ((rgb & 255) << 8) | 255) >>> 0;
    if (!counts.has(opaqueKey)) rgbTrns = rgb;
  }
  let greyTrns = null;
  if (allGrey && alphaBinary && transparentGrey.size === 1) {
    const gv = transparentGrey.values().next().value;
    const opaqueKey = ((gv << 24) | (gv << 16) | (gv << 8) | 255) >>> 0;
    if (!counts.has(opaqueKey)) greyTrns = gv;
  }
  return { counts, allGrey, allOpaque, alphaBinary, rgbTrns, greyTrns };
}

// ---------- candidate encodings ----------
function buildEncodings(rgba, w, h, info) {
  const n = w * h;
  const encodings = [];

  if (info.counts.size <= 256) {
    const entries = [...info.counts.entries()].map(([key, count]) => ({
      key, count,
      r: (key >>> 24) & 255, g: (key >>> 16) & 255, b: (key >>> 8) & 255, a: key & 255,
    }));
    const orderings = [
      [...entries].sort((x, y) => y.count - x.count || x.key - y.key),
      [...entries].sort((x, y) => x.key - y.key),
    ];
    for (const order of orderings) {
      const indexOf = new Map();
      const plte = new Uint8Array(order.length * 3);
      let lastAlpha = -1;
      order.forEach((e, i) => {
        indexOf.set(e.key, i);
        plte[i * 3] = e.r; plte[i * 3 + 1] = e.g; plte[i * 3 + 2] = e.b;
        if (e.a < 255) lastAlpha = i;
      });
      let trns = null;
      if (lastAlpha >= 0) {
        trns = new Uint8Array(lastAlpha + 1);
        order.forEach((e, i) => { if (i <= lastAlpha) trns[i] = e.a; });
      }
      const raw = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        const d = i * 4;
        const key = ((rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3]) >>> 0;
        raw[i] = indexOf.get(key);
      }
      encodings.push({ colorType: 3, bpp: 1, plte, trns, raw });
    }
  }

  if (info.allGrey && info.allOpaque) {
    const raw = new Uint8Array(n);
    for (let i = 0; i < n; i++) raw[i] = rgba[i * 4];
    encodings.push({ colorType: 0, bpp: 1, plte: null, trns: null, raw });
  }
  if (info.allGrey && info.greyTrns !== null) {
    const raw = new Uint8Array(n);
    for (let i = 0; i < n; i++) raw[i] = rgba[i * 4];
    const trns = new Uint8Array([0, info.greyTrns]);
    encodings.push({ colorType: 0, bpp: 1, plte: null, trns, raw });
  }
  if (info.allGrey && !info.allOpaque) {
    const raw = new Uint8Array(n * 2);
    for (let i = 0; i < n; i++) { raw[i * 2] = rgba[i * 4]; raw[i * 2 + 1] = rgba[i * 4 + 3]; }
    encodings.push({ colorType: 4, bpp: 2, plte: null, trns: null, raw });
  }
  if (info.allOpaque) {
    const raw = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      raw[i * 3] = rgba[i * 4]; raw[i * 3 + 1] = rgba[i * 4 + 1]; raw[i * 3 + 2] = rgba[i * 4 + 2];
    }
    encodings.push({ colorType: 2, bpp: 3, plte: null, trns: null, raw });
  }
  if (info.rgbTrns !== null) {
    const raw = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      raw[i * 3] = rgba[i * 4]; raw[i * 3 + 1] = rgba[i * 4 + 1]; raw[i * 3 + 2] = rgba[i * 4 + 2];
    }
    const t = info.rgbTrns;
    const trns = new Uint8Array([0, (t >>> 16) & 255, 0, (t >>> 8) & 255, 0, t & 255]);
    encodings.push({ colorType: 2, bpp: 3, plte: null, trns, raw });
  }
  encodings.push({ colorType: 6, bpp: 4, plte: null, trns: null, raw: rgba });
  return encodings;
}

// ---------- filtering ----------
// Computes all five filtered variants of every row plus three scores
// per (row, filter): signed-absolute sum, squared sum, and a histogram
// entropy estimate. Filter preference order breaks ties: Paeth, Sub,
// Up, Avg, None.
const FILTER_PREF = [4, 1, 2, 3, 0];

function filterVariants(raw, w, h, bpp) {
  const stride = w * bpp;
  const variants = [];
  for (let f = 0; f < 5; f++) variants.push(new Uint8Array(stride * h));
  const msad = new Float64Array(h * 5);
  const zeros = new Float64Array(h * 5);
  const ent = new Float64Array(h * 5);
  const hist = new Int32Array(256);
  for (let y = 0; y < h; y++) {
    const rowOff = y * stride;
    const upOff = rowOff - stride;
    for (let f = 0; f < 5; f++) {
      const out = variants[f];
      let m = 0;
      hist.fill(0);
      for (let i = 0; i < stride; i++) {
        const cur = raw[rowOff + i];
        const left = i >= bpp ? raw[rowOff + i - bpp] : 0;
        const above = y > 0 ? raw[upOff + i] : 0;
        const upperLeft = y > 0 && i >= bpp ? raw[upOff + i - bpp] : 0;
        let pred = 0;
        if (f === 1) pred = left;
        else if (f === 2) pred = above;
        else if (f === 3) pred = (left + above) >> 1;
        else if (f === 4) pred = paeth(left, above, upperLeft);
        const v = (cur - pred) & 255;
        out[rowOff + i] = v;
        m += v < 128 ? v : 256 - v;
        hist[v]++;
      }
      let e = 0;
      for (let k = 0; k < 256; k++) if (hist[k] > 0) e += hist[k] * Math.log2(hist[k]);
      msad[y * 5 + f] = m;
      zeros[y * 5 + f] = -hist[0] * 4096 + m; // most zero bytes, then MSAD
      ent[y * 5 + f] = -e; // smaller (more negative) = lower entropy
    }
  }
  return { variants, msad, zeros, ent, stride };
}

function assembleFiltered(fv, h, mode) {
  const { variants, stride } = fv;
  const out = Buffer.alloc(h * (stride + 1));
  const fixed = mode.length === 2 && mode[0] === 'f' ? Number(mode[1]) : -1;
  const scores = mode === 'msad' ? fv.msad : mode === 'zeros' ? fv.zeros : fv.ent;
  for (let y = 0; y < h; y++) {
    let best = fixed;
    if (fixed < 0) {
      let bestScore = Infinity;
      for (const f of FILTER_PREF) {
        const s = scores[y * 5 + f];
        if (s < bestScore) { bestScore = s; best = f; }
      }
    }
    const dst = y * (stride + 1);
    out[dst] = best;
    out.set(variants[best].subarray(y * stride, (y + 1) * stride), dst + 1);
  }
  return out;
}

// ---------- PNG writing ----------
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  out.set(data, 8);
  out.writeUInt32BE(crc32(out, 4, 4 + data.length), 8 + data.length);
  return out;
}

function overheadOf(enc) {
  let n = 8 + 25 + 12 + 12; // signature, IHDR, IDAT frame, IEND
  if (enc.plte) n += 12 + enc.plte.length;
  if (enc.trns) n += 12 + enc.trns.length;
  return n;
}

function buildPng(enc, w, h, deflated) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = enc.colorType;
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr)];
  if (enc.plte) parts.push(chunk('PLTE', Buffer.from(enc.plte)));
  if (enc.trns) parts.push(chunk('tRNS', Buffer.from(enc.trns)));
  parts.push(chunk('IDAT', deflated));
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

// ---------- search ----------
// Fixed filter streams matter: screenshots repeat whole rows and blocks,
// and an unfiltered or Sub-filtered stream keeps those exact repeats for
// the LZ77 matcher, which per-row adaptive heuristics can destroy. So
// the candidate set is every fixed filter plus two adaptive choices,
// ranked cheaply at zlib level 6, then finished at level 9.
const Z_RANK = { level: 6, memLevel: 8, strategy: ZC.Z_DEFAULT_STRATEGY };
const Z_BEST = { level: 9, memLevel: 8, strategy: ZC.Z_DEFAULT_STRATEGY };
const Z_ALT = { level: 9, memLevel: 9, strategy: ZC.Z_DEFAULT_STRATEGY };
const Z_FILT = { level: 9, memLevel: 8, strategy: ZC.Z_FILTERED };
const Z_RLE = { level: 9, memLevel: 8, strategy: ZC.Z_RLE };
const STREAM_MODES = ['f0', 'f1', 'f2', 'f4', 'msad', 'entropy', 'zeros', 'f3'];

// Per-row brute force: pick the filter whose row compresses smallest on
// its own at level 6. Row-local, so it cannot see cross-row repeats;
// it is one more candidate stream, ranked against the others globally.
function bruteStream(fv, h) {
  const { variants, stride } = fv;
  const out = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    let best = 4;
    let bestLen = Infinity;
    for (const f of FILTER_PREF) {
      const row = variants[f].subarray(y * stride, (y + 1) * stride);
      const len = deflateSync(row, Z_RANK).length;
      if (len < bestLen) { bestLen = len; best = f; }
    }
    const dst = y * (stride + 1);
    out[dst] = best;
    out.set(variants[best].subarray(y * stride, (y + 1) * stride), dst + 1);
  }
  return out;
}

function pruneEncodings(encodings, info) {
  const hasPalette = encodings.some((e) => e.colorType === 3);
  if (hasPalette) return encodings.filter((e) => e.colorType === 3 || e.colorType === 0 || e.colorType === 4);
  if (info.allGrey) return encodings.filter((e) => e.colorType === 0 || e.colorType === 4);
  return encodings;
}

function squeeze(rgba, w, h) {
  const info = analyze(rgba, w * h);
  const encodings = pruneEncodings(buildEncodings(rgba, w, h, info), info);

  // Phase A: rank every (encoding, filter stream) pair at level 6.
  const pairs = [];
  for (const enc of encodings) {
    const fv = filterVariants(enc.raw, w, h, enc.bpp);
    for (const mode of STREAM_MODES) {
      const stream = assembleFiltered(fv, h, mode);
      const deflated = deflateSync(stream, Z_RANK);
      pairs.push({ enc, stream, size: overheadOf(enc) + deflated.length });
    }
    const brute = bruteStream(fv, h);
    pairs.push({ enc, stream: brute, size: overheadOf(enc) + deflateSync(brute, Z_RANK).length });
  }
  pairs.sort((a, b) => a.size - b.size);
  const finalists = pairs.slice(0, 3);

  // Phase B: level 9 on the finalists, extra settings on the top two.
  let best = null;
  let second = null;
  for (const p of finalists) {
    const deflated = deflateSync(p.stream, Z_BEST);
    const size = overheadOf(p.enc) + deflated.length;
    if (!best || size < best.size) { second = best; best = { enc: p.enc, stream: p.stream, size, deflated }; }
    else if (!second || size < second.size) second = { enc: p.enc, stream: p.stream, size, deflated };
  }
  const tryExtra = (cand, z) => {
    const deflated = deflateSync(cand.stream, z);
    const size = overheadOf(cand.enc) + deflated.length;
    if (size < best.size) best = { enc: cand.enc, stream: cand.stream, size, deflated };
  };
  tryExtra(best, Z_ALT);
  tryExtra(best, Z_FILT);
  if (best.enc.bpp === 1) tryExtra(best, Z_RLE);
  if (second) tryExtra(second, Z_FILT);
  return buildPng(best.enc, w, h, best.deflated);
}

// ---------- main ----------
for (let n = 1; n <= 8; n++) {
  const id = 'i00' + n;
  const inputBytes = readFileSync(join(inputRoot, id, 'image.png'));
  const png = parsePng(inputBytes);
  const rgba = decodeToRgba(png);
  let out = squeeze(rgba, png.w, png.h);
  if (out.length > MAX_OUT) out = inputBytes.length <= MAX_OUT ? inputBytes : out;
  mkdirSync(join(outputRoot, id), { recursive: true });
  writeFileSync(join(outputRoot, id, 'image.png'), out);
}
