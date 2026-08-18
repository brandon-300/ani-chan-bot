// Turns a CardCatalogue entry (name/series/tier/description + a raw AniList
// artwork URL) into a finished, professionally-styled trading card PNG,
// instead of the bot sending that raw AniList image directly.
//
// ── Why Puppeteer/HTML/SVG instead of FFmpeg ────────────────────────────────
// This project already has a proven, zero-new-dependency way to composite
// text + images on this exact phone: reusing the WhatsApp session's own
// Chromium instance (client.pupBrowser) to render HTML/CSS/inline-SVG and
// screenshot it — see utils/memeRender.js (captions on images) and
// commands/cards.js's .cg command (a multi-card grid, same pattern applied
// to card art specifically). Chromium renders real fonts, word-wrap,
// gradients, and SVG natively; FFmpeg's drawtext/overlay filters can't do
// any of that. So this reuses the same pattern rather than adding a second,
// separate FFmpeg-based compositing pipeline. FFmpeg itself is completely
// untouched — it still only handles actual media transcoding elsewhere in
// the bot (converter.js, downloaders, fishAudio.js). No Sharp anywhere.
//
// ── Why the source image is fetched with axios first, not <img src="url"> ──
// .cg loads AniList images directly in the browser because it only ever
// *displays* them. This renderer also needs to read the image's raw pixels
// (for hair-color extraction), and drawing a cross-origin image onto a
// <canvas> then calling getImageData() throws a SecurityError ("tainted
// canvas") unless the remote server sends the right CORS headers — not
// guaranteed for AniList's CDN. Fetching the bytes in Node first (axios,
// already a project dependency) and embedding them as a data: URI sidesteps
// that entirely, since a data: URI is never treated as cross-origin. It also
// means the Puppeteer page itself never touches the network — one less
// thing that can time out on an unstable mobile connection mid-render.
//
// ── Caching ──────────────────────────────────────────────────────────────
// A card's artwork lives on CardCatalogue (shared by every owner of that
// card — see models/Card.js), so the rendered PNG is cached there too:
// renderedUrl / renderVersion / renderedAt. CARD_RENDER_VERSION is the one
// source of truth for the design version — bump it here (nowhere else) to
// invalidate every cached card at once. Cloudinary writes use a
// deterministic public_id (card id + version, no bot name in the path) so a
// second render of the same card/version overwrites the same file instead
// of piling up orphans. Cloudinary is best-effort: if it's not configured,
// or the upload fails, the freshly rendered buffer is still returned and
// sent — caching just won't kick in until Cloudinary succeeds on some
// future call.
//
// An in-flight render map (per cardId+version) makes concurrent requests
// for the *same uncached card* (e.g. two people viewing a card the instant
// it drops) share one render instead of racing two separate ones.
//
// ── Temp files ───────────────────────────────────────────────────────────
// This pipeline never writes a temp file at all: the source image is held
// as a data: URI string, the finished card is a PNG Buffer in memory from
// page.screenshot(), and uploadBufferToCloud() (utils/cloudinary.js)
// streams that buffer straight to Cloudinary with no intermediate file.
// There is nothing to name uniquely and nothing to clean up on disk — the
// only external resource is the Puppeteer page, which is always closed in
// a finally block below, success or failure.
//
// Every failure inside renderCardImage()/renderCard() throws a plain Error.
// This module never sends a WhatsApp message and never decides on a
// fallback — that stays commands/cards.js's job, which already has an
// established fallback chain (raw AniList image -> text-only) that this
// slots in ahead of, unchanged.

const axios = require('axios');
const { CardCatalogue } = require('../models/Card');
const { TIER_ORDER, cleanDescription } = require('./helpers');
const { BOT_NAME } = require('./config');
const { uploadBufferToCloud, isCloudConfigured } = require('./cloudinary');

const CARD_RENDER_VERSION = 1; // bump this — and only this — to force every cached card to re-render

// ─── Fixed canvas + layout (all bands sum exactly to INNER_H — see math below) ─
const CARD_WIDTH = 1080;
const CARD_HEIGHT = 1440; // 3:4 portrait, identical for every card
const FRAME = 22; // outer frame thickness
const CUT_OUTER = 40; // octagon corner-cut size, outer frame
const CUT_INNER = 30; // octagon corner-cut size, inner content area
const INNER_W = CARD_WIDTH - FRAME * 2; // 1036
const INNER_H = CARD_HEIGHT - FRAME * 2; // 1396

const BANNER_H = 148;
const ART_H = 628;
const DIVIDER_H = 96;
const PANEL_H = INNER_H - BANNER_H - ART_H - DIVIDER_H; // 524 — 148+628+96+524 = 1396 = INNER_H

const STAR_SIZE = 80;
const MIN_NAME_FONT_PX = 30;
const MIN_DESC_FONT_PX = 20;
const DESC_MAX_CHARS = 280; // pre-truncated before the in-page auto-shrink even runs

const IMAGE_FETCH_TIMEOUT_MS = 15000;
const PAGE_TIMEOUT_MS = 20000;

// key: `${identity}:${version}` -> Promise<Buffer>
const inFlightRenders = new Map();

// ─── HTML escaping (same 5-entity rule already used by memeRender.js / cards.js) ─
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncateText(text, maxChars) {
  const t = text || '';
  if (t.length <= maxChars) return t;
  const cut = t.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  const trimmed = lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut;
  return trimmed.trim() + '…';
}

// ─── Color math ─────────────────────────────────────────────────────────────
function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function hslToRgb(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(255 * f(0)), Math.round(255 * f(8)), Math.round(255 * f(4))];
}

function hslToHex(h, s, l) {
  const [r, g, b] = hslToRgb(h, s, l);
  return '#' + [r, g, b].map((v) => clamp(v, 0, 255).toString(16).padStart(2, '0')).join('');
}

// WCAG relative luminance — used to pick readable text color against a
// given accent background rather than assuming light-on-dark or vice versa.
function relativeLuminance([r, g, b]) {
  const lin = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// Turns one extracted hue/sat/light triple into the full card palette. The
// clamp() calls here are the "too dark / too gray / too bright -> adjust
// it" normalization step (rule 5) — applied regardless of whether the hue
// came from the hair region, the whole-image fallback, or the fixed safe
// default, so every card ends up with a usable, readable accent.
//
// isNeutral matters: when the source saturation is already near zero, hue
// is essentially noise (black/gray/silver/white hair has no real "color").
// Forcing that noisy hue up to 42-88% saturation would manufacture a fake,
// arbitrary color out of what should be a charcoal or silver card — the
// opposite of rule 26 ("black hair -> charcoal frame", "silver/white hair
// -> silver/gray frame"). So neutral input takes a different clamp range
// that stays desaturated and pushes lightness toward true dark or true
// light instead of a washed-out middle gray, with the "glow" accent
// deliberately hue-shifted for a cool contrasting highlight (rule 26's
// "brighter secondary accent") rather than just a paler version of gray.
function buildPalette(h, s, l) {
  const isNeutral = s < 12;

  const nS = isNeutral ? clamp(s, 0, 14) : clamp(s, 42, 88);
  const nL = isNeutral
    ? (l < 30 ? clamp(l, 12, 22) : clamp(l, 55, 80))
    : clamp(l, 36, 62);

  const primary = hslToHex(h, nS, nL);
  const dark = hslToHex(h, nS, clamp(nL - (isNeutral ? 12 : 20), 6, 90));
  const light = hslToHex(h, nS, clamp(nL + (isNeutral ? 18 : 20), 10, 92));
  const glow = isNeutral
    ? hslToHex((h + 200) % 360, 55, 78)
    : hslToHex(h, clamp(nS - 18, 0, 95), clamp(nL + 32, 10, 96));

  const bannerRgb = hslToRgb(h, nS, nL);
  const textOnBanner = relativeLuminance(bannerRgb) > 0.5 ? '#171717' : '#ffffff';

  return { primary, dark, light, glow, textOnBanner };
}

// Fixed, non-random fallback if hair-region AND whole-image sampling both
// come back empty (e.g. a fully solid/transparent source image). Rule 6
// says never fall back to a random color — this is a deliberate constant.
const SAFE_DEFAULT_HSL = { h: 178, s: 55, l: 46 }; // teal, in the spirit of the reference design

// ─── Tier -> star count ─────────────────────────────────────────────────────
// TIER_ORDER (utils/helpers.js) is the single existing source of truth for
// tier ordering — stars are just "position in that order, 1-indexed". This
// does NOT create a second rarity system; it reads the existing one. An
// unrecognized tier value (shouldn't happen — the schema enum restricts it
// — but never trust that alone) falls back to 1 star instead of crashing.
function starCountForTier(tier) {
  const idx = TIER_ORDER.indexOf(tier);
  return idx === -1 ? 1 : idx + 1;
}

function monogramFromBotName(name) {
  const match = String(name || '').match(/[A-Za-z0-9]/);
  return match ? match[0].toUpperCase() : 'A';
}

// ─── Inline SVG star (radial gradient + drop shadow, not a flat Unicode glyph) ─
// idSuffix is an index (0,1,2...), not Math.random() — SVG gradient ids only
// need to be unique WITHIN one document, and using a deterministic index
// keeps a given Card + renderer version producing byte-identical output
// (rule 31), which a random id would break for no visual benefit.
function starSvg(size, colorLight, colorDark, idSuffix) {
  const cx = size / 2, cy = size / 2;
  const points = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? size / 2 - 2 : size / 2 / 2.35;
    const angle = (Math.PI / 2) * 3 + (i * Math.PI) / 5;
    points.push(`${(cx + r * Math.cos(angle)).toFixed(1)},${(cy + r * Math.sin(angle)).toFixed(1)}`);
  }
  const gradId = `starGrad${idSuffix}`;
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="filter:drop-shadow(0 3px 5px rgba(0,0,0,.5))">
    <defs><radialGradient id="${gradId}" cx="50%" cy="32%" r="70%">
      <stop offset="0%" stop-color="${colorLight}"/>
      <stop offset="100%" stop-color="${colorDark}"/>
    </radialGradient></defs>
    <polygon points="${points.join(' ')}" fill="url(#${gradId})" stroke="rgba(0,0,0,.4)" stroke-width="1.5"/>
  </svg>`;
}

function octagonClipPath(w, h, c) {
  return `polygon(${c}px 0, ${w - c}px 0, ${w}px ${c}px, ${w}px ${h - c}px, ${w - c}px ${h}px, ${c}px ${h}px, 0 ${h - c}px, 0 ${c}px)`;
}

// ─── Full card HTML ─────────────────────────────────────────────────────────
// All dynamic text (name/series/description/bot name) is escaped before it
// ever touches this template — rule 21. imageDataUri is base64 (its
// alphabet can never contain a quote or angle bracket), so it's safe to
// drop directly into an attribute/url() with no escaping needed.
function buildCardHtml({ name, series, tier, description, botName, imageDataUri, colors }) {
  const safeName = escapeHtml(name || 'Unknown');
  const safeSeries = escapeHtml(series || 'Unknown');
  const safeBotName = escapeHtml(botName || 'Bot');
  const safeDesc = escapeHtml(truncateText(description || '', DESC_MAX_CHARS));
  const monogram = escapeHtml(monogramFromBotName(botName));

  const starCount = starCountForTier(tier);
  const isSSS = tier === 'SSS';
  const starsHtml = Array.from({ length: starCount }, (_, i) => starSvg(STAR_SIZE, colors.glow, colors.primary, i)).join('');

  const outerClip = octagonClipPath(CARD_WIDTH, CARD_HEIGHT, CUT_OUTER);
  const innerClip = octagonClipPath(INNER_W, INNER_H, CUT_INNER);
  const starOverlap = Math.round(STAR_SIZE * 0.45);

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0;
    width: ${CARD_WIDTH}px; height: ${CARD_HEIGHT}px;
    overflow: hidden; background: #000;
    font-family: Arial, Helvetica, sans-serif;
  }
  .card {
    width: ${CARD_WIDTH}px; height: ${CARD_HEIGHT}px;
    position: relative; padding: ${FRAME}px;
    background: linear-gradient(150deg, ${colors.dark}, ${colors.primary} 45%, ${colors.dark} 100%);
    clip-path: ${outerClip};
    box-shadow: 0 0 0 2px rgba(255,255,255,.08) inset;
  }
  .card.sss {
    box-shadow: 0 0 46px 6px ${colors.glow}, 0 0 0 3px rgba(255,255,255,.18) inset;
  }
  .cardInner {
    width: ${INNER_W}px; height: ${INNER_H}px;
    position: relative; background: #0c0c10;
    clip-path: ${innerClip};
    display: flex; flex-direction: column; overflow: hidden;
  }
  .banner {
    height: ${BANNER_H}px; flex-shrink: 0;
    display: flex; align-items: center; gap: 18px;
    padding: 0 30px 0 22px;
    background: linear-gradient(90deg, ${colors.dark}, ${colors.primary} 80%);
    clip-path: polygon(0 0, calc(100% - 34px) 0, 100% 50%, calc(100% - 34px) 100%, 0 100%);
    box-shadow: 0 4px 10px rgba(0,0,0,.35);
    position: relative; z-index: 3;
  }
  .logo {
    flex-shrink: 0; font-size: 46px; font-weight: 900; font-style: italic;
    color: ${colors.textOnBanner}; text-shadow: 0 2px 3px rgba(0,0,0,.4);
  }
  .bannerNameWrap {
    flex: 1; min-width: 0;
    display: flex; align-items: center; justify-content: center; overflow: hidden;
  }
  .bannerName {
    font-size: 58px; font-weight: 900; letter-spacing: 2px;
    color: ${colors.textOnBanner}; text-transform: uppercase; white-space: nowrap;
    text-shadow: 0 2px 4px rgba(0,0,0,.35);
  }
  .artwork {
    height: ${ART_H}px; flex-shrink: 0; position: relative;
    background-image: url('${imageDataUri}');
    background-size: cover; background-position: center 22%; background-repeat: no-repeat;
  }
  .artwork::after {
    content: ''; position: absolute; inset: 0;
    background: linear-gradient(180deg, rgba(0,0,0,.28) 0%, transparent 16%, transparent 78%, rgba(0,0,0,.55) 100%);
  }
  .divider {
    height: ${DIVIDER_H}px; flex-shrink: 0; position: relative;
    background: linear-gradient(90deg, transparent, ${colors.primary} 18%, ${colors.light} 50%, ${colors.primary} 82%, transparent);
    display: flex; align-items: center; justify-content: center; z-index: 2;
  }
  .starsRow {
    display: flex; gap: 10px; align-items: center;
    margin-top: -${starOverlap}px;
  }
  .infoPanel {
    height: ${PANEL_H}px; flex-shrink: 0;
    display: flex; flex-direction: column;
    padding: 40px 44px 32px;
    background: linear-gradient(180deg, rgba(22,22,28,.97), rgba(9,9,13,.99));
  }
  .cardDesc {
    flex: 1; min-height: 0; overflow: hidden;
    display: flex; align-items: center; justify-content: center; text-align: center;
    color: #ececec; font-size: 32px; line-height: 1.45; font-weight: 500;
  }
  .footer {
    flex-shrink: 0; display: flex; justify-content: space-between; align-items: flex-end;
    margin-top: 16px;
  }
  .series {
    font-size: 34px; font-weight: 900; letter-spacing: 1px; text-transform: uppercase;
    color: ${colors.light}; max-width: 68%; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; text-shadow: 0 2px 3px rgba(0,0,0,.5);
  }
  .infoLabel {
    flex-shrink: 0; transform: rotate(-6deg);
    background: linear-gradient(135deg, ${colors.primary}, ${colors.dark});
    color: ${colors.textOnBanner};
    padding: 8px 20px; font-size: 24px; font-weight: 900; letter-spacing: 3px;
    border-radius: 4px; box-shadow: 0 3px 6px rgba(0,0,0,.4);
  }
</style>
</head>
<body>
  <div class="card${isSSS ? ' sss' : ''}">
    <div class="cardInner">
      <div class="banner">
        <div class="logo">${monogram}</div>
        <div class="bannerNameWrap" id="cardNameWrap">
          <div class="bannerName" id="cardNameText">${safeName}</div>
        </div>
      </div>
      <div class="artwork"></div>
      <div class="divider"><div class="starsRow">${starsHtml}</div></div>
      <div class="infoPanel">
        <div class="cardDesc" id="cardDesc">${safeDesc}</div>
        <div class="footer">
          <div class="series">${safeSeries}</div>
          <div class="infoLabel">INFO</div>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;
  // Note: safeBotName isn't printed elsewhere on the face — the monogram
  // logo IS the bot-branding element (rule 53: bot branding stays a small
  // supporting identity, not a second large text block). It's still
  // resolved above from the real BOT_NAME/.env value, escaped, and passed
  // in — nothing about it is hard-coded.
}

// ─── Hair-color extraction (runs inside the Chromium page) ─────────────────
async function extractAccentHsl(page) {
  const raw = await page.evaluate(() => {
    function rgbToHsl(r, g, b) {
      r /= 255; g /= 255; b /= 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      let h, s;
      const l = (max + min) / 2;
      if (max === min) {
        h = 0; s = 0;
      } else {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
          case r: h = (g - b) / d + (g < b ? 6 : 0); break;
          case g: h = (b - r) / d + 2; break;
          default: h = (r - g) / d + 4;
        }
        h *= 60;
      }
      return [h, s * 100, l * 100];
    }

    // Samples a horizontal band of the image (yStart/yEnd as fractions of
    // height), bucketing similar colors together and returning the most
    // frequent bucket's average RGB. Deliberately downsamples to a small
    // fixed canvas first — plenty for a representative color, and cheap on
    // phone-class hardware regardless of the source image's real size.
    function scanRegion(img, yStart, yEnd) {
      const cw = 80, ch = 80;
      const canvas = document.createElement('canvas');
      canvas.width = cw; canvas.height = ch;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, cw, ch);

      const rowStart = Math.floor(ch * yStart);
      const rowEnd = Math.max(rowStart + 1, Math.floor(ch * yEnd));
      const data = ctx.getImageData(0, rowStart, cw, rowEnd - rowStart).data;

      const buckets = new Map();
      let sampled = 0;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
        if (a < 200) continue;
        const maxc = Math.max(r, g, b), minc = Math.min(r, g, b);
        if (maxc > 236 && minc > 212) continue; // near-white
        if (maxc < 20) continue;                // near-black
        if (maxc - minc < 20) continue;         // low-saturation / gray
        const key = `${Math.round(r / 18)}_${Math.round(g / 18)}_${Math.round(b / 18)}`;
        const entry = buckets.get(key) || { count: 0, r: 0, g: 0, b: 0 };
        entry.count++; entry.r += r; entry.g += g; entry.b += b;
        buckets.set(key, entry);
        sampled++;
      }
      if (!sampled) return null;
      let best = null;
      for (const entry of buckets.values()) {
        if (!best || entry.count > best.count) best = entry;
      }
      return { r: best.r / best.count, g: best.g / best.count, b: best.b / best.count, sampled };
    }

    try {
      const img = document.getElementById('src');
      if (!img || !img.naturalWidth) return { h: null, method: 'no-image' };

      // Primary: the top ~5-42% of the image — typical hair-region band for
      // an AniList character portrait.
      let winner = scanRegion(img, 0.05, 0.42);
      let method = 'hair-region';

      // Fallback: not enough usable pixels in that band (e.g. cropped-in
      // portrait with no visible hair up top) — sample the whole image.
      if (!winner || winner.sampled < 30) {
        winner = scanRegion(img, 0, 1);
        method = 'whole-image';
      }
      if (!winner) return { h: null, method: 'none' };

      const [h, s, l] = rgbToHsl(winner.r, winner.g, winner.b);
      return { h, s, l, method };
    } catch (e) {
      return { h: null, method: 'error: ' + (e && e.message) };
    }
  });

  if (raw && raw.h !== null && !Number.isNaN(raw.h)) {
    console.log(`[CARD RENDER] Hair color source: ${raw.method}`);
    return { h: raw.h, s: raw.s, l: raw.l };
  }
  console.log(`[CARD RENDER] Hair color extraction fallback (${raw ? raw.method : 'unknown'}) — using safe default.`);
  return SAFE_DEFAULT_HSL;
}

// ─── Fetch source art as a data: URI (see file header for why) ─────────────
async function fetchImageAsDataUri(url) {
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await axios.get(url, { responseType: 'arraybuffer', timeout: IMAGE_FETCH_TIMEOUT_MS });
      const contentType = (res.headers['content-type'] || '').split(';')[0].trim();
      const mime = contentType.startsWith('image/') ? contentType : 'image/jpeg';
      return `data:${mime};base64,${Buffer.from(res.data).toString('base64')}`;
    } catch (err) {
      lastErr = err;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 800));
    }
  }
  throw new Error(`failed to fetch source artwork — ${lastErr.message}`);
}

// ─── Core render: catalogue doc -> PNG buffer (+ best-effort cache write) ──
async function renderCardImage(client, catalogue) {
  if (!client.pupBrowser) {
    throw new Error("Card renderer needs the WhatsApp browser session, which isn't ready yet.");
  }
  if (!catalogue.imageUrl) {
    throw new Error('renderCardImage: catalogue entry has no source artwork (imageUrl).');
  }

  const identity = catalogue.cardId || String(catalogue._id);
  const startedAt = Date.now();
  console.log(`[CARD RENDER] Rendering card ${identity} (${catalogue.name})`);

  const imageDataUri = await fetchImageAsDataUri(catalogue.imageUrl);

  const page = await client.pupBrowser.newPage();
  try {
    await page.setViewport({ width: CARD_WIDTH, height: CARD_HEIGHT, deviceScaleFactor: 1 });

    // Phase 1: image only, so extractAccentHsl has something to sample.
    await page.setContent(
      `<!DOCTYPE html><html><body style="margin:0;background:#000"><img id="src" src="${imageDataUri}"></body></html>`,
      { waitUntil: 'load', timeout: PAGE_TIMEOUT_MS }
    );
    const { h, s, l } = await extractAccentHsl(page);
    const colors = buildPalette(h, s, l);
    console.log(`[CARD RENDER] Accent: ${colors.primary} | Tier: ${catalogue.tier}`);

    // Phase 2: the real card composition.
    const html = buildCardHtml({
      name: catalogue.name,
      series: catalogue.series,
      tier: catalogue.tier,
      description: catalogue.description ? cleanDescription(catalogue.description) : '',
      botName: BOT_NAME,
      imageDataUri,
      colors,
    });
    await page.setContent(html, { waitUntil: 'load', timeout: PAGE_TIMEOUT_MS });

    // Shrink the name banner to fit on one line; only wrap as a last resort.
    await page.evaluate((minPx) => {
      const el = document.getElementById('cardNameText');
      const wrap = document.getElementById('cardNameWrap');
      if (!el || !wrap) return;
      let size = parseInt(getComputedStyle(el).fontSize, 10) || 58;
      let guard = 0;
      while (el.scrollWidth > wrap.clientWidth && size > minPx && guard < 40) {
        size -= 2;
        el.style.fontSize = size + 'px';
        guard++;
      }
      if (el.scrollWidth > wrap.clientWidth) {
        el.style.whiteSpace = 'normal';
        el.style.lineHeight = '1.05';
        el.style.fontSize = minPx + 'px';
      }
    }, MIN_NAME_FONT_PX);

    // Shrink the description to fit its panel; if still overflowing at the
    // font floor, trim the text itself rather than clipping mid-line.
    await page.evaluate((minPx) => {
      const el = document.getElementById('cardDesc');
      if (!el) return;
      let size = parseInt(getComputedStyle(el).fontSize, 10) || 32;
      let guard = 0;
      while (el.scrollHeight > el.clientHeight && size > minPx && guard < 30) {
        size -= 1;
        el.style.fontSize = size + 'px';
        guard++;
      }
      guard = 0;
      while (el.scrollHeight > el.clientHeight && el.textContent.length > 40 && guard < 40) {
        const t = el.textContent;
        el.textContent = t.slice(0, Math.floor(t.length * 0.9)).trim() + '…';
        guard++;
      }
    }, MIN_DESC_FONT_PX);

    const buffer = await page.screenshot({ type: 'png' });
    console.log(`[CARD RENDER] Render complete in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

    // Best-effort cache write — a Cloudinary hiccup never fails the render
    // itself, since the buffer above is already good to send.
    if (isCloudConfigured()) {
      try {
        const { url } = await uploadBufferToCloud(buffer, {
          folder: 'card-renders',
          publicId: `card_${identity}_v${CARD_RENDER_VERSION}`,
        });
        await CardCatalogue.updateOne(
          { _id: catalogue._id },
          { $set: { renderedUrl: url, renderVersion: CARD_RENDER_VERSION, renderedAt: new Date() } }
        );
        console.log(`[CARD RENDER] Cached to Cloudinary: ${identity}`);
      } catch (err) {
        console.error('[CARD RENDER] Cloudinary cache write failed (non-fatal):', err.message);
      }
    }

    return buffer;
  } finally {
    await page.close().catch(() => {});
  }
}

// ─── Public entry point ─────────────────────────────────────────────────────
// Returns { buffer, url, cached }:
//   - cache hit    -> { buffer: null, url: <cloudinary url>, cached: true }
//   - fresh render -> { buffer: <PNG Buffer>, url: null, cached: false }
// Throws on failure (browser not ready, fetch failed, page timeout, etc.) —
// the caller (commands/cards.js) decides the fallback.
async function renderCard(client, catalogue) {
  if (!catalogue) throw new Error('renderCard: no catalogue entry provided.');

  if (catalogue.renderedUrl && catalogue.renderVersion === CARD_RENDER_VERSION) {
    console.log(`[CARD RENDER] Cache hit: ${catalogue.cardId || catalogue._id}`);
    return { buffer: null, url: catalogue.renderedUrl, cached: true };
  }
  console.log(`[CARD RENDER] Cache miss: ${catalogue.cardId || catalogue._id}`);

  const key = `${catalogue.cardId || catalogue._id}:${CARD_RENDER_VERSION}`;
  if (inFlightRenders.has(key)) {
    const buffer = await inFlightRenders.get(key);
    return { buffer, url: null, cached: false };
  }

  const renderPromise = renderCardImage(client, catalogue).finally(() => {
    inFlightRenders.delete(key);
  });
  inFlightRenders.set(key, renderPromise);

  const buffer = await renderPromise;
  return { buffer, url: null, cached: false };
}

module.exports = { renderCard, CARD_RENDER_VERSION };
