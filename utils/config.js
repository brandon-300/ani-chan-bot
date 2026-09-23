// ─── Central Bot Config ────────────────────────────────────────────────────
// Single source of truth for app-level configuration. Any file that needs
// the bot's identity, the command prefix, the menu image, the Chromium path,
// registration/news policy values, or news operational settings should
// import them from here instead of reading process.env directly.
//
// To rename the bot, change its prefix, retarget policies, or tune the news
// broadcast's operational behavior: change the value in .env — nothing in
// this file, or in any file that imports from it, needs to change.
//
// Falls back to the hardcoded defaults below only if the corresponding
// variable is missing from .env.

// ─── Bot Identity ──────────────────────────────────────────────────────────
// Used by: startup banner, .help/.stats/.ping text, sticker pack names, the
// AI persona's system prompt, shop titles, etc.
const BOT_NAME = process.env.BOT_NAME || 'Ani-Chan Bot';

// Command prefix. Historical note: the very first .env.example shipped with
// this bot called this variable PREFIX= — the code has always read
// BOT_PREFIX, so PREFIX= was silently ignored. BOT_PREFIX is the real name;
// both are accepted here so old .env files keep working.
const BOT_PREFIX = process.env.BOT_PREFIX || process.env.PREFIX || '.';

// Optional image shown by menu-bearing commands. Empty string means "no
// menu image" — consumers must treat '' as absent, not as a URL.
const MENU_IMAGE_URL = process.env.MENU_IMAGE_URL || '';

// ─── Chromium (whatsapp-web.js / puppeteer) ────────────────────────────────
// Termux default path for the Chromium binary whatsapp-web.js launches.
// Overridable via .env for non-Termux deployments (VPS, desktop).
const PUPPETEER_EXECUTABLE_PATH =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  '/data/data/com.termux/files/usr/bin/chromium-browser';

// ─── Registration / Age Verification ───────────────────────────────────────
// See the registration gate in index.js, .setname/.setdob/.bio/.setpic in
// commands/economy.js, and models/AgeVerification.js. Both env-configurable
// so these policies can be tuned without touching code.
//
// MIN_REGISTRATION_AGE: minimum age (calculated from .setdob) required to
// complete registration.
//
// AGE_VERIFICATION_LOCKOUT_DAYS: how long a denied (under-age) .setdob
// attempt is flagged for before the same WhatsApp id is allowed to try
// .setdob again. Enforced by models/AgeVerification.js's TTL index, which
// deletes the flag document automatically once this period elapses — no
// cron/interval needed (same reasoning as models/User.js's lazy daily
// interest check: this bot can't rely on an always-on scheduler firing at
// an exact time on Termux).
const MIN_REGISTRATION_AGE = parseInt(process.env.MIN_REGISTRATION_AGE, 10) || 18;
const AGE_VERIFICATION_LOCKOUT_DAYS = parseInt(process.env.AGE_VERIFICATION_LOCKOUT_DAYS, 10) || 30;

// ─── Anime News (.news + hourly auto-broadcast) ────────────────────────────
// Operational settings for commands/news.js. Source definitions and the
// ranking term lists live in utils/newsConfig.js — this section only holds
// values you might want to tune from .env without a code change.
//
// NEWS_RSS_QUERY: the Google News RSS search topic — covers anime, manga,
//   manhwa, and donghua (Chinese-produced anime) via Google News' OR search
//   syntax. UNCERTAINTY FLAGGED: untested against the live feed (no network
//   access in the environment this was written in) — if the OR syntax
//   doesn't behave as expected once deployed, this is the one value to
//   adjust.
//
// NEWS_USER_AGENT: sent with every feed request. Defaults to a normal
//   browser UA — these public RSS feeds respond better to that than to an
//   identifying bot UA (unlike Danbooru in utils/danbooru.js, which
//   requires a unique identifying UA per its API terms — these feeds have
//   no such requirement, it's just what works).
//
// NEWS_FETCH_TIMEOUT_MS: per-source HTTP timeout. Generous by default —
//   the connection on the phone is unstable, and a slow source is skipped
//   (not fatal) anyway.
//
// NEWS_SEND_DELAY_MS: pause between groups during an hourly broadcast, to
//   avoid hammering WhatsApp with a burst of sends.
//
// NEWS_MAX_ARTICLE_AGE_DAYS: feed items older than this are ignored, so a
//   first run (or a long offline stretch) can't flood groups with old
//   backlog.
const NEWS_RSS_QUERY = process.env.NEWS_RSS_QUERY || 'anime OR manga OR manhwa OR donghua';
const NEWS_USER_AGENT =
  process.env.NEWS_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const NEWS_FETCH_TIMEOUT_MS = parseInt(process.env.NEWS_FETCH_TIMEOUT_MS, 10) || 20000;
const NEWS_SEND_DELAY_MS = parseInt(process.env.NEWS_SEND_DELAY_MS, 10) || 2000;
const NEWS_MAX_ARTICLE_AGE_DAYS = parseInt(process.env.NEWS_MAX_ARTICLE_AGE_DAYS, 10) || 7;

module.exports = {
  BOT_NAME,
  BOT_PREFIX,
  MENU_IMAGE_URL,
  PUPPETEER_EXECUTABLE_PATH,
  MIN_REGISTRATION_AGE,
  AGE_VERIFICATION_LOCKOUT_DAYS,
  NEWS_RSS_QUERY,
  NEWS_USER_AGENT,
  NEWS_FETCH_TIMEOUT_MS,
  NEWS_SEND_DELAY_MS,
  NEWS_MAX_ARTICLE_AGE_DAYS,
};
