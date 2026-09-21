// ─── Image candidate validation & scoring ──────────────────────────────────
// Everything repairCardImages.js needs to turn a raw Google Custom Search
// result into a decision: is this actually a usable, on-character image?
//
// Deliberately does NOT trust any single signal on its own — not the
// search result's claimed size, not its domain, not even Gemini Vision's
// opinion. Each of those is one input into a combined score, matching the
// principle that a search/AI system should propose candidates but the
// bot's own code decides. See scoreCandidate() below for the actual rubric.
//
// No new npm dependency was added for image-dimension reading (an
// `image-size`-style package would be the normal choice, but this project
// deliberately avoids adding packages that need a fresh `npm install` over
// unstable Termux data — see utils/gemini.js's own header comment for the
// same reasoning). getImageDimensions() below is a small hand-written
// sniffer for PNG/JPEG/GIF/WEBP instead, verified against real generated
// test files (all four formats, plus a progressive JPEG and a lossless
// VP8L WEBP) before this was written into the project.
const axios = require('axios');
const crypto = require('crypto');
const { generateVision } = require('./gemini');

const DOWNLOAD_TIMEOUT_MS = 15000;
// Hard cap on downloaded bytes — protects Termux's limited RAM from a
// mislabeled multi-hundred-MB "image" and keeps a single bad candidate
// from stalling a long batch run.
const MAX_IMAGE_BYTES = 12 * 1024 * 1024; // 12MB

// Most sites don't block a plain axios request, but several do (Pinterest,
// some CDNs, some official studio sites with basic bot protection) —
// they return a 403 to anything that doesn't look like a browser. A
// realistic desktop User-Agent avoids that for the sites where it's just a
// blunt "no scripts" rule rather than deliberate hotlink protection.
const DOWNLOAD_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
};

// ─── Format sniffing + dimensions (no external library) ───────────────────
function detectFormat(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 6 && buf.toString('ascii', 0, 3) === 'GIF') return 'gif';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function readPngDims(buf) {
  // IHDR is always the first chunk, right after the 8-byte PNG signature:
  // 4-byte length, 4-byte "IHDR", then 4-byte width + 4-byte height (BE).
  if (buf.length < 24) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function readGifDims(buf) {
  // Logical Screen Descriptor starts right after the 6-byte signature;
  // width/height are 2-byte little-endian fields.
  if (buf.length < 10) return null;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

function readJpegDims(buf) {
  // Walk marker segments until an SOFn (start-of-frame) marker, which
  // carries height/width right after its 2-byte length + 1-byte precision.
  let pos = 2;
  while (pos + 9 <= buf.length) {
    if (buf[pos] !== 0xff) { pos++; continue; }
    const marker = buf[pos + 1];
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      pos += 2;
      continue;
    }
    const isSOF = (marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    const length = buf.readUInt16BE(pos + 2);
    if (isSOF) {
      return { height: buf.readUInt16BE(pos + 5), width: buf.readUInt16BE(pos + 7) };
    }
    pos += 2 + length;
  }
  return null;
}

function readWebpDims(buf) {
  if (buf.length < 30) return null;
  const fourCC = buf.toString('ascii', 12, 16);
  if (fourCC === 'VP8X') {
    return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  }
  if (fourCC === 'VP8 ') {
    // 3-byte frame tag + 3-byte start code (0x9D 0x01 0x2A), then width/
    // height as 2-byte LE values with a 2-bit scale factor in the top bits
    // that has to be masked off.
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (fourCC === 'VP8L') {
    // 1-byte signature (0x2F) then a 4-byte LE bitfield: 14 bits width-1,
    // 14 bits height-1.
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return null;
}

// Returns { format, width, height } or null if the buffer isn't a
// recognizable image at all (most commonly: the URL actually served an
// HTML error/login/block page instead of the image it claimed to be).
function getImageDimensions(buf) {
  const format = detectFormat(buf);
  if (!format) return null;
  const dims =
    format === 'png' ? readPngDims(buf) :
    format === 'jpeg' ? readJpegDims(buf) :
    format === 'gif' ? readGifDims(buf) :
    readWebpDims(buf);
  if (!dims || !dims.width || !dims.height) return null;
  return { format, width: dims.width, height: dims.height };
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ─── Download ───────────────────────────────────────────────────────────────
// Throws on any failure (network error, non-2xx, oversized) — the caller
// treats a thrown error as "this candidate is unusable", not a hard stop.
async function downloadImageBuffer(url) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: DOWNLOAD_TIMEOUT_MS,
    headers: DOWNLOAD_HEADERS,
    maxContentLength: MAX_IMAGE_BYTES,
    maxBodyLength: MAX_IMAGE_BYTES,
    validateStatus: (s) => s >= 200 && s < 300,
  });
  const buffer = Buffer.from(res.data);
  if (buffer.length > MAX_IMAGE_BYTES) {
    const err = new Error(`Image is ${(buffer.length / 1024 / 1024).toFixed(1)}MB, over the ${MAX_IMAGE_BYTES / 1024 / 1024}MB cap`);
    err.code = 'IMAGE_TOO_LARGE';
    throw err;
  }
  return { buffer, contentType: res.headers['content-type'] || null };
}

// ─── Domain reputation (STARTING POINT — tune from what you actually see) ──
// UNCERTAINTY FLAG: there's no way to verify from this sandbox (no network
// access here) how well these specific lists perform against real search
// results for your catalogue's characters. Treat this as a first draft:
// after a few --limit=10 dry runs, check the audit log's domain/score
// breakdown and add/remove domains based on what you actually see turning
// up good vs. bad art. This is intentionally simple substring matching
// (matching utils/danbooru.js's own normalizeForMatch style) rather than
// a smarter reputation system — that's a reasonable place to improve this
// later once you have real data on what's showing up.
const PREFERRED_DOMAINS = [
  'crunchyroll.com', 'funimation.com', 'aniplex.co.jp', 'aniplex.com',
  'shonenjump.com', 'viz.com', 'toei-animation.co.jp', 'madhouse.co.jp',
  'mappa.co.jp', 'ufotable.com', 'bones.co.jp', 'amazon.com', 'amazon.co.jp',
];
const ACCEPTABLE_DOMAINS = [
  'myanimelist.net', 'anidb.net', 'fandom.com', 'wikipedia.org',
  'animenewsnetwork.com', 'anilist.co', 'zerochan.net',
];
const PENALIZED_DOMAINS = [
  'pinterest.', 'pinimg.com', 'deviantart.com', 'pixiv.net', 'pximg.net',
  'tumblr.com', 'twitter.com', 'x.com', 'twimg.com', 'instagram.com',
  'cdninstagram.com', 'reddit.com', 'redd.it', 'artstation.com', 'weheartit.com',
];

function classifyDomain(hostnameOrDisplayLink) {
  const h = String(hostnameOrDisplayLink || '').toLowerCase();
  if (!h) return 'unknown';
  if (PENALIZED_DOMAINS.some(d => h.includes(d))) return 'penalized';
  if (PREFERRED_DOMAINS.some(d => h.includes(d))) return 'preferred';
  if (ACCEPTABLE_DOMAINS.some(d => h.includes(d))) return 'acceptable';
  return 'neutral';
}

// ─── Character/series text match (search title+snippet only — cheap, no
// download needed, same normalize-and-substring approach as utils/
// danbooru.js's seriesMatchesCopyright, just applied to free text instead
// of Danbooru copyright tags) ────────────────────────────────────────────
function normalizeForMatch(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}
function textMentions(haystackNorm, needle) {
  const n = normalizeForMatch(needle);
  return n.length >= 3 && haystackNorm.includes(n);
}
function matchTextSignal(name, series, title, snippet) {
  const haystack = normalizeForMatch(`${title || ''} ${snippet || ''}`);
  const nameHit = textMentions(haystack, name);
  const seriesHit = textMentions(haystack, series);
  if (nameHit && seriesHit) return 'both';
  if (nameHit) return 'name';
  return 'none';
}

// ─── Gemini Vision identity check ───────────────────────────────────────────
// Downloads happen in repairCardImages.js (it needs the buffer either way,
// to hash + measure it), so this takes the buffer directly rather than a
// URL. Returns null (not an error) on ANY failure — a vision-check outage
// should never crash the batch, it just means that candidate is scored on
// domain/resolution/text-match alone, same as if vision were disabled.
const VISION_PROMPT_TEMPLATE = (name, series) => `You are checking a single candidate image for an anime trading-card catalogue.

CANONICAL CHARACTER: ${name}
CANONICAL SERIES: ${series}

These two values are already confirmed correct — do not second-guess them, only judge whether the image matches them.

Look at the image and answer:
- matches: does this image actually depict this exact character from this exact series? (not a lookalike, not a different character who happens to share the name)
- isFanArt: does this look like unofficial fan art (visible artist signature/watermark, amateur art style, obviously a fan commission) rather than official/promotional artwork?
- hasWatermark: any visible watermark, stamp, or website logo overlaid on the image?
- isGroupImage: does the image show multiple characters rather than focusing on this one?
- isScreenshotOrPanel: is this a video screenshot, manga panel, or similar rather than standalone artwork?
- confidence: your confidence in the "matches" judgment, 0 to 1.

Respond with ONLY a raw JSON object, no markdown fences, no commentary:
{"matches": true|false, "isFanArt": true|false, "hasWatermark": true|false, "isGroupImage": true|false, "isScreenshotOrPanel": true|false, "confidence": 0.0}`;

function parseJsonObject(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const parsed = JSON.parse(cleaned);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('response was not a JSON object');
  }
  return parsed;
}

async function visionCheckCandidate({ buffer, mimeType, name, series }) {
  try {
    const raw = await generateVision({
      prompt: VISION_PROMPT_TEMPLATE(name, series),
      base64Image: buffer.toString('base64'),
      mimeType: mimeType || 'image/jpeg',
      maxOutputTokens: 300,
    });
    const parsed = parseJsonObject(raw);
    return {
      matches: parsed.matches === true ? true : parsed.matches === false ? false : null,
      isFanArt: !!parsed.isFanArt,
      hasWatermark: !!parsed.hasWatermark,
      isGroupImage: !!parsed.isGroupImage,
      isScreenshotOrPanel: !!parsed.isScreenshotOrPanel,
      confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5,
    };
  } catch (err) {
    console.warn(`[imageValidator] Vision check failed, scoring without it: ${err.message}`);
    return null;
  }
}

// ─── Combined score ─────────────────────────────────────────────────────────
// Returns { score (0-100), hardReject (bool), reasons (string[]) } — reasons
// is written straight into the audit log so a human reviewing needs_review
// entries can see exactly why something did or didn't pass, instead of a
// bare number.
//
// STARTING-POINT WEIGHTS — same uncertainty flag as the domain lists above:
// these numbers are a reasonable-looking first draft, not something that's
// been tuned against real results. Adjust after watching a few dry runs.
function scoreCandidate({ candidate, dims, domainTier, textMatch, vision, formatMismatch }) {
  let score = 40;
  const reasons = [];
  let hardReject = false;

  if (formatMismatch) {
    score -= 30;
    hardReject = true;
    reasons.push('claimed content-type did not match the actual downloaded file — likely a blocked/error page, not real image data (-30, hard reject)');
  }

  if (domainTier === 'preferred') { score += 25; reasons.push('preferred domain (+25)'); }
  else if (domainTier === 'acceptable') { score += 10; reasons.push('acceptable domain (+10)'); }
  else if (domainTier === 'penalized') { score -= 30; reasons.push('penalized domain — known fan-art/repost platform (-30)'); }

  if (textMatch === 'both') { score += 15; reasons.push('search result text mentions both name and series (+15)'); }
  else if (textMatch === 'name') { score += 6; reasons.push('search result text mentions the name only (+6)'); }
  else { score -= 8; reasons.push('search result text does not clearly mention name or series (-8)'); }

  if (dims) {
    const minSide = Math.min(dims.width, dims.height);
    const ratio = dims.width / dims.height;
    if (minSide >= 800) { score += 15; reasons.push(`high resolution ${dims.width}x${dims.height} (+15)`); }
    else if (minSide >= 450) { score += 6; reasons.push(`acceptable resolution ${dims.width}x${dims.height} (+6)`); }
    else { score -= 20; reasons.push(`low resolution ${dims.width}x${dims.height} (-20)`); }

    if (ratio > 3 || ratio < 0.2) {
      score -= 15;
      reasons.push(`extreme aspect ratio ${dims.width}x${dims.height} — likely a banner/collage, not a portrait (-15)`);
    }
  } else {
    score -= 5;
    reasons.push('could not read image dimensions (-5)');
  }

  if (vision) {
    if (vision.matches === false) {
      score -= 60;
      hardReject = true;
      reasons.push('Gemini Vision says this does NOT depict the canonical character (-60, hard reject)');
    } else if (vision.matches === true) {
      const bonus = Math.round(15 * vision.confidence);
      score += bonus;
      reasons.push(`Gemini Vision confirms character match at ${Math.round(vision.confidence * 100)}% confidence (+${bonus})`);
    }
    if (vision.isFanArt) { score -= 15; reasons.push('Gemini Vision flagged this as likely fan art (-15)'); }
    if (vision.hasWatermark) { score -= 12; reasons.push('Gemini Vision detected a watermark (-12)'); }
    if (vision.isGroupImage) { score -= 15; reasons.push('Gemini Vision detected a group image, not a solo portrait (-15)'); }
    if (vision.isScreenshotOrPanel) { score -= 15; reasons.push('Gemini Vision detected a screenshot/manga panel (-15)'); }
  } else {
    reasons.push('no Gemini Vision check performed for this candidate (scored on domain/resolution/text only)');
  }

  score = Math.max(0, Math.min(100, score));
  return { score, hardReject, reasons };
}

module.exports = {
  downloadImageBuffer,
  getImageDimensions,
  sha256Hex,
  classifyDomain,
  matchTextSignal,
  visionCheckCandidate,
  scoreCandidate,
  PREFERRED_DOMAINS,
  ACCEPTABLE_DOMAINS,
  PENALIZED_DOMAINS,
};
