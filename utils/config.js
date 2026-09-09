// ─── Central Bot Identity Config ───────────────────────────────────────────
// Single source of truth for the bot's display name. Any file that needs to
// show the bot's name anywhere — startup banner, .help/.stats/.ping text,
// sticker pack names, the AI persona's system prompt, shop titles, etc. —
// should import BOT_NAME from here instead of typing "AniChan" / "Ani-Chan
// Bot" directly. To rename the bot everywhere at once, change BOT_NAME in
// .env — nothing in this file, or in any file that imports from it, needs
// to change.
//
// Falls back to 'Ani-Chan Bot' only if BOT_NAME is missing from .env.
const BOT_NAME = process.env.BOT_NAME || 'Ani-Chan Bot';

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

// ─── Anime News (.news + daily auto-broadcast) ─────────────────────────────
// See commands/news.js. The Google News RSS search topic — overridable so
// it can be retargeted without a code change. Covers anime, manga, manhwa,
// and donghua (Chinese-produced anime) via Google News' OR search syntax.
// UNCERTAINTY FLAGGED: untested against the live feed (no network access
// in the environment this was written in) — if the OR syntax doesn't
// behave as expected once deployed, this is the one line to adjust.
const NEWS_RSS_QUERY = process.env.NEWS_RSS_QUERY || 'anime OR manga OR manhwa OR donghua';

module.exports = {
  BOT_NAME,
  MIN_REGISTRATION_AGE,
  AGE_VERIFICATION_LOCKOUT_DAYS,
  NEWS_RSS_QUERY,
};
