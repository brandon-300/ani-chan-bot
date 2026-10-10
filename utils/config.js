// ─── Central Bot Config ────────────────────────────────────────────────────
const path = require('path');

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

// ─── Numeric env parser ────────────────────────────────────────────────────
// parseInt(x, 10) || fallback treats an EXPLICIT 0 in .env as "unset" (0 is
// falsy), silently substituting the default. envInt distinguishes the two
// cases: a missing/empty variable falls back, but an explicitly configured
// value — including 0 — is used as-is.
function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? fallback : n;
}

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
const MIN_REGISTRATION_AGE = envInt('MIN_REGISTRATION_AGE', 18);
const AGE_VERIFICATION_LOCKOUT_DAYS = envInt('AGE_VERIFICATION_LOCKOUT_DAYS', 30);

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
const NEWS_FETCH_TIMEOUT_MS = envInt('NEWS_FETCH_TIMEOUT_MS', 20000);
const NEWS_SEND_DELAY_MS = envInt('NEWS_SEND_DELAY_MS', 2000);
const NEWS_MAX_ARTICLE_AGE_DAYS = envInt('NEWS_MAX_ARTICLE_AGE_DAYS', 7);

// ─── AI wake-word ("call by name") ─────────────────────────────────────────
// Optional comma-separated override for the CURRENT persona only. When unset,
// group wake names come only from that persona's own meta.json. Do not use
// this variable as a shared pool for multiple personas; add persona folders.
const AI_CALL_NAMES_OVERRIDE = process.env.AI_CALL_NAMES === undefined
  ? null
  : process.env.AI_CALL_NAMES.split(',').map(s => s.trim()).filter(Boolean);

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  if (/^(1|true|yes|on)$/i.test(raw.trim())) return true;
  if (/^(0|false|no|off)$/i.test(raw.trim())) return false;
  return fallback;
}

function positiveEnvInt(name, fallback) {
  const value = envInt(name, fallback);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

// ─── Persona-aware AI and Cloudinary/Mongo sticker library ──────────────────
const AI_PERSONA = (process.env.AI_PERSONA || 'marin').trim().toLowerCase();
const AI_STICKERS_ENABLED = envBool('AI_STICKERS_ENABLED', false);
// Retired: sticker analysis is manual now (.stickeranalyze). The value is only read
// so the bot can tell an owner whose .env still sets it that it is ignored.
const AI_STICKER_AUTO_ANALYZE = envBool('AI_STICKER_AUTO_ANALYZE', false);
// ─── Shared "already handled" record (both bot versions) ──────────────────────
// The whatsapp-web.js and Baileys versions are ONE bot on ONE WhatsApp account. A
// version that was switched off is sent every message it missed as soon as it
// starts again, so without a shared record it would answer commands the other
// version already answered. Each incoming message id is claimed in MongoDB by the
// first version that sees it; the other skips it. These settings must be the same
// for both versions, which is why they come from the shared .env.
//   MESSAGE_CLAIM_ENABLED      set to false to turn the record off
//   MESSAGE_CLAIM_TTL_HOURS    how long a claim is remembered (WhatsApp keeps
//                              undelivered messages for days, so keep this generous)
//   MESSAGE_CLAIM_TIMEOUT_MS   if MongoDB does not answer in time the message is
//                              processed anyway (never drop messages because of a slow database)
//   MESSAGE_CLAIM_COOLDOWN_MS  after such a failure, skip the record for this long so every
//                              message is not delayed in turn
const MESSAGE_CLAIM_ENABLED = (process.env.MESSAGE_CLAIM_ENABLED || 'true').trim().toLowerCase() !== 'false';
const MESSAGE_CLAIM_TTL_HOURS = positiveEnvInt('MESSAGE_CLAIM_TTL_HOURS', 168);
const MESSAGE_CLAIM_TIMEOUT_MS = positiveEnvInt('MESSAGE_CLAIM_TIMEOUT_MS', 4000);
const MESSAGE_CLAIM_COOLDOWN_MS = positiveEnvInt('MESSAGE_CLAIM_COOLDOWN_MS', 30000);
const BOT_ENGINE = 'wweb';

// ─── .tourl: free anonymous file hosts, tried in this order ─────────────────────
// 0x0.st switched uploads off in spring 2026 ("no ETA"), so .tourl now walks a list
// of hosts and uses the first that works. Change the order, or drop a host that
// stops working, with TOURL_PROVIDER_ORDER in .env (comma separated ids):
//   catbox     catbox.moe                permanent    up to 200 MB
//   litterbox  litterbox.catbox.moe      temporary    up to 1 GB, kept TOURL_LITTERBOX_HOURS (1, 12, 24 or 72)
//   uguu       uguu.se                   temporary    up to 128 MB, kept a few hours
// The endpoints can be overridden with TOURL_CATBOX_URL / TOURL_LITTERBOX_URL / TOURL_UGUU_URL.
const TOURL_TIMEOUT_MS = positiveEnvInt('TOURL_TIMEOUT_MS', 45000);
const TOURL_USER_AGENT = process.env.TOURL_USER_AGENT || 'AniChanBot/1.0 (+WhatsApp media relay; Termux)';
const configuredLitterboxHours = positiveEnvInt('TOURL_LITTERBOX_HOURS', 72);
const TOURL_LITTERBOX_HOURS = [1, 12, 24, 72].includes(configuredLitterboxHours) ? configuredLitterboxHours : 72;
const TOURL_PROVIDER_CATALOG = {
  catbox: { id: 'catbox', name: 'catbox.moe', url: process.env.TOURL_CATBOX_URL || 'https://catbox.moe/user/api.php', maxBytes: 200 * 1024 * 1024, expires: null },
  litterbox: { id: 'litterbox', name: 'litterbox', url: process.env.TOURL_LITTERBOX_URL || 'https://litterbox.catbox.moe/resources/internals/api.php', maxBytes: 1024 * 1024 * 1024, expires: `${TOURL_LITTERBOX_HOURS} hours` },
  uguu: { id: 'uguu', name: 'uguu.se', url: process.env.TOURL_UGUU_URL || 'https://uguu.se/upload?output=text', maxBytes: 128 * 1024 * 1024, expires: 'a few hours' },
};
const requestedProviderOrder = (process.env.TOURL_PROVIDER_ORDER || 'catbox,litterbox,uguu')
  .split(',').map(id => id.trim().toLowerCase()).filter(id => TOURL_PROVIDER_CATALOG[id]);
const TOURL_PROVIDERS = (requestedProviderOrder.length ? requestedProviderOrder : ['catbox', 'litterbox', 'uguu'])
  .filter((id, index, all) => all.indexOf(id) === index)
  .map(id => TOURL_PROVIDER_CATALOG[id]);

const AI_STICKER_IMPORT_TIMEOUT_MINUTES = positiveEnvInt('AI_STICKER_IMPORT_TIMEOUT_MINUTES', 10);
const AI_STICKER_MAX_BYTES = positiveEnvInt('AI_STICKER_MAX_BYTES', 2 * 1024 * 1024);
const AI_STICKER_DOWNLOAD_TIMEOUT_MS = positiveEnvInt('AI_STICKER_DOWNLOAD_TIMEOUT_MS', 30000);
const PERSONAS_DIR = path.resolve(__dirname, '../config/personas');
// FISH_VOICE_ID is an emergency process-wide override. Production
// multi-persona setups should leave it empty and configure voice.referenceId
// independently in each persona's meta.json.
const FISH_VOICE_ID = process.env.FISH_VOICE_ID || '';
const FISH_MODEL = process.env.FISH_MODEL || 's2.1-pro-free';
const FISH_REQUEST_TIMEOUT_MS = positiveEnvInt('FISH_REQUEST_TIMEOUT_MS', 45000);

// ─── Float env parser (clamped) ─────────────────────────────────────────────
// Missing/blank/invalid values fall back; valid values are clamped to [min, max].
function envFloat(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// ─── Fish Audio delivery tuning ─────────────────────────────────────────────
// Sampling and pacing sent with every TTS request. A persona's meta.json
// `voice` block (speed, volume, temperature, topP) overrides these per persona.
// Higher temperature/top_p = more varied, more expressive delivery; Fish's own
// default is 0.7. latency/chunk_length are only sent when explicitly set.
const FISH_TEMPERATURE = envFloat('FISH_TEMPERATURE', 0.8, 0, 1);
const FISH_TOP_P = envFloat('FISH_TOP_P', 0.8, 0, 1);
const FISH_SPEED = envFloat('FISH_SPEED', 1, 0.5, 2);
const FISH_VOLUME_DB = envFloat('FISH_VOLUME_DB', 0, -20, 20);
const FISH_LATENCY = ['low', 'normal', 'balanced'].includes((process.env.FISH_LATENCY || '').trim().toLowerCase())
  ? process.env.FISH_LATENCY.trim().toLowerCase()
  : '';
const FISH_CHUNK_LENGTH = (() => {
  const n = envInt('FISH_CHUNK_LENGTH', 0);
  return n > 0 ? Math.min(300, Math.max(100, n)) : 0;
})();
// Opt-in: prepend ONE short documented [cue] such as [excited] to a voice note.
// OFF by default because cues are interpreted text on the S2.1 model and can be
// spoken aloud if the model does not honor them. Test with
// scripts/fish-voice-test.js before turning this on.
const FISH_EXPRESSION_TAGS = envBool('FISH_EXPRESSION_TAGS', false);
// Voice notes should be a few spoken sentences, not an essay.
const AI_VOICE_MAX_OUTPUT_TOKENS = positiveEnvInt('AI_VOICE_MAX_OUTPUT_TOKENS', 500);

// ─── Model-chosen stickers ──────────────────────────────────────────────────
// For each text reply the AI is shown a numbered catalogue of stickers that
// passed the persona-fit gate and picks the one that fits what it is saying (or
// none). At most this many stickers are offered per reply; they are spread
// across anime and shuffled so the same ones are not always on offer.
const AI_STICKER_CATALOGUE_MAX = positiveEnvInt('AI_STICKER_CATALOGUE_MAX', 48);
// Stickers sent in the last N AI stickers in a chat are left out of the next
// catalogue so the AI does not repeat itself. 0 turns this off.
const AI_STICKER_RECENT_EXCLUDE = Math.max(0, envInt('AI_STICKER_RECENT_EXCLUDE', 6));

// ─── AI reacts to reactions on its own messages ─────────────────────────────
// When someone reacts to a message/voice note/sticker the AI itself sent, it may
// add its own emoji reaction to that same message. It never sends a message in
// response, and makes no Gemini call.
const AI_REACT_TO_REACTIONS = envBool('AI_REACT_TO_REACTIONS', true);
const AI_REACT_CHANCE = envFloat('AI_REACT_CHANCE', 0.6, 0, 1);
const AI_REACT_COOLDOWN_MS = Math.max(0, envInt('AI_REACT_COOLDOWN_MS', 15000));
const AI_REACT_DELAY_MIN_MS = Math.max(0, envInt('AI_REACT_DELAY_MIN_MS', 1500));
const AI_REACT_DELAY_MAX_MS = Math.max(AI_REACT_DELAY_MIN_MS, envInt('AI_REACT_DELAY_MAX_MS', 6000));
// How long, and how many, recently sent AI messages are remembered as "mine".
const AI_MESSAGE_MEMORY_MS = positiveEnvInt('AI_MESSAGE_MEMORY_MS', 24 * 60 * 60 * 1000);
const AI_MESSAGE_MEMORY_MAX = positiveEnvInt('AI_MESSAGE_MEMORY_MAX', 1000);
const AI_STICKER_ANALYSIS_VERSION = positiveEnvInt('AI_STICKER_ANALYSIS_VERSION', 1);
// Non-exact sticker matches must be unusually strong. Exact persona reaction
// labels are still accepted directly; this threshold prevents weak emotion/
// mood overlap from selecting unrelated meme stickers.
const AI_STICKER_MATCH_THRESHOLD = positiveEnvInt('AI_STICKER_MATCH_THRESHOLD', 18);
const AI_STICKER_MIN_PERSONA_FIT = Math.max(0, Math.min(1, Number(process.env.AI_STICKER_MIN_PERSONA_FIT ?? 0.6) || 0.6));
const AI_STICKER_ANALYSIS_DELAY_MS = envInt('AI_STICKER_ANALYSIS_DELAY_MS', 8000);

// ─── AI conversation memory ─────────────────────────────────────────────────
// Each user has one conversation PER PERSONA (switching persona starts a fresh
// one; switching back returns to the old one). A conversation expires after
// AI_HISTORY_EXPIRY_DAYS of inactivity: every exchange moves the expiry to
// "last message + N days". AI_HISTORY_EXPIRY_SCOPE decides what counts as activity:
//   user     any exchange with ANY persona keeps ALL of that user's conversations alive
//   persona  only an exchange with a persona keeps that persona's conversation alive
// The bot owner (OWNER_NUMBER / OWNER_IDS) is exempt: owner conversations never expire.
const AI_HISTORY_EXPIRY_DAYS = positiveEnvInt('AI_HISTORY_EXPIRY_DAYS', 7);
const AI_HISTORY_EXPIRY_SCOPE = (process.env.AI_HISTORY_EXPIRY_SCOPE || '').trim().toLowerCase() === 'persona' ? 'persona' : 'user';
// Messages kept (and sent to Gemini) per conversation for everyone else.
const AI_HISTORY_MESSAGES = positiveEnvInt('AI_HISTORY_MESSAGES', 20);
// The owner's history is not trimmed to 20: this many messages are kept in the
// database per conversation, and this many of the newest are sent to Gemini each
// turn. (Sending everything ever said would grow every request without limit and
// burn the Gemini quota, so the context window stays bounded.)
const AI_HISTORY_OWNER_KEPT = positiveEnvInt('AI_HISTORY_OWNER_KEPT', 2000);
const AI_HISTORY_OWNER_CONTEXT = positiveEnvInt('AI_HISTORY_OWNER_CONTEXT', 100);

// ─── Sticker analysis cost control ──────────────────────────────────────────
// Analysis is MANUAL (.stickeranalyze in the owner's private DM): nothing runs
// at startup, after an update, or when a sticker is imported. When it does run,
// one Gemini request covers many stickers and every persona at once:
//   FIT_BATCH    stickers judged per text request (all personas included)
//   VISION_BATCH stickers looked at per image request, only for stickers that
//                have no description yet (one look is shared by all personas)
// A library of N stickers costs about N/FIT_BATCH requests to analyse.
const AI_STICKER_FIT_BATCH = positiveEnvInt('AI_STICKER_FIT_BATCH', 20);
const AI_STICKER_VISION_BATCH = positiveEnvInt('AI_STICKER_VISION_BATCH', 6);

// ─── Gemini quota protection ────────────────────────────────────────────────
// When Gemini reports the quota is used up, the background sticker-analysis
// queue pauses instead of failing every remaining sticker. It waits this long
// before trying again (doubling after each consecutive quota failure, up to the
// max), unless Gemini's own "retry in Ns" hint asks for a shorter wait.
const AI_STICKER_QUOTA_COOLDOWN_MS = positiveEnvInt('AI_STICKER_QUOTA_COOLDOWN_MS', 30 * 60 * 1000);
const AI_STICKER_QUOTA_MAX_COOLDOWN_MS = positiveEnvInt('AI_STICKER_QUOTA_MAX_COOLDOWN_MS', 2 * 60 * 60 * 1000);

// While sticker analysis is running (or paused for quota) it owns the Gemini
// quota, so Gemini-backed commands reply "unavailable" instead of competing
// with it. Set GEMINI_PAUSE_DURING_STICKER_ANALYSIS=false to turn that off.
const GEMINI_PAUSE_DURING_STICKER_ANALYSIS = envBool('GEMINI_PAUSE_DURING_STICKER_ANALYSIS', true);
// Commands (after alias resolution) that call Gemini. Override with a
// comma-separated GEMINI_COMMANDS list if a command is added or removed.
// .sauce is deliberately NOT here: it works through SauceNAO and only its
// optional Gemini fallback is paused (see commands/search.js).
const GEMINI_COMMANDS = process.env.GEMINI_COMMANDS === undefined
  ? ['copilot', 'gpt', 'voice', 'imagine', 'translate', 'transcribe', 'akinator']
  : process.env.GEMINI_COMMANDS.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const GEMINI_BUSY_MESSAGE = (process.env.GEMINI_BUSY_MESSAGE || '').trim()
  || '⏳ This command is currently unavailable. Please try again later.';

// ─── Akinator (Gemini reasoning + AniList/Jikan character check) ────────────
// Every limit lives here so Termux deployments can tune request volume, the
// confidence policy and network timeouts from .env without touching command logic.
// The same variables are read by the whatsapp-web.js and Baileys versions.
//
// Reasoning model. Falls back to GEMINI_TEXT_MODEL, then the project default.
const AKINATOR_GEMINI_MODEL = process.env.AKINATOR_GEMINI_MODEL || process.env.GEMINI_TEXT_MODEL || 'gemini-3.1-flash-lite';
// When the bot may guess. The application decides, not the model: it needs at least
// AKINATOR_MIN_QUESTIONS answers, then EITHER the model's confidence in ONE candidate is at
// least AKINATOR_GUESS_CONFIDENCE, OR that same candidate has led for the last
// AKINATOR_STABLE_TURNS questions each at AKINATOR_STABLE_CONFIDENCE or more (this stops the
// bot asking forever about a character it already knows). On top of either, the candidate must
// lead the runner-up by AKINATOR_MIN_CONFIDENCE_GAP, be backed by at least
// AKINATOR_MIN_SUPPORTING_EVIDENCE of the player's answers, and have at most
// AKINATOR_MAX_CONTRADICTIONS answers against it. The model's numbers are advisory, which is
// why these independent checks exist. There is no fixed "20 questions" limit;
// AKINATOR_MAX_QUESTIONS only stops a game that is going nowhere.
// To make it guess sooner lower AKINATOR_GUESS_CONFIDENCE (0.9) or AKINATOR_MIN_QUESTIONS;
// to make it more careful raise them.
const AKINATOR_MIN_QUESTIONS = positiveEnvInt('AKINATOR_MIN_QUESTIONS', 15);
const AKINATOR_MAX_QUESTIONS = Math.max(AKINATOR_MIN_QUESTIONS, positiveEnvInt('AKINATOR_MAX_QUESTIONS', 50));
const AKINATOR_GUESS_CONFIDENCE = envFloat('AKINATOR_GUESS_CONFIDENCE', 0.95, 0.5, 1);
const AKINATOR_STABLE_TURNS = positiveEnvInt('AKINATOR_STABLE_TURNS', 4);
const AKINATOR_STABLE_CONFIDENCE = envFloat('AKINATOR_STABLE_CONFIDENCE', 0.9, 0.5, 1);
const AKINATOR_MIN_CONFIDENCE_GAP = envFloat('AKINATOR_MIN_CONFIDENCE_GAP', 0.18, 0, 1);
const AKINATOR_MIN_SUPPORTING_EVIDENCE = positiveEnvInt('AKINATOR_MIN_SUPPORTING_EVIDENCE', 5);
const AKINATOR_MAX_CONTRADICTIONS = Math.max(0, envInt('AKINATOR_MAX_CONTRADICTIONS', 1));
const AKINATOR_MAX_RUNNER_UP_CONFIDENCE_NO_CANDIDATE = envFloat('AKINATOR_MAX_RUNNER_UP_CONFIDENCE_NO_CANDIDATE', 0.02, 0, 0.5);
// A question counts as a repeat when this share of its meaningful words was already asked.
const AKINATOR_DUPLICATE_QUESTION_SIMILARITY = envFloat('AKINATOR_DUPLICATE_QUESTION_SIMILARITY', 0.84, 0.5, 1);
// A guess must be matched to a real character (AniList, then Jikan/MyAnimeList, then a
// Google-grounded check) so it can come with a real picture. If the character is very
// well supported by the answers but cannot be matched anywhere, the bot asks this many
// more questions and then names the character WITHOUT a picture instead of looping.
const AKINATOR_UNVERIFIED_GUESS_AFTER = positiveEnvInt('AKINATOR_UNVERIFIED_GUESS_AFTER', 2);
// Games are saved in MongoDB, so they survive restarts, and are dropped after this long idle.
const AKINATOR_SESSION_TIMEOUT_HOURS = positiveEnvInt('AKINATOR_SESSION_TIMEOUT_HOURS', 24);
const AKINATOR_COMPLETED_RETENTION_HOURS = positiveEnvInt('AKINATOR_COMPLETED_RETENTION_HOURS', 24);
const AKINATOR_CANDIDATE_HISTORY_LIMIT = positiveEnvInt('AKINATOR_CANDIDATE_HISTORY_LIMIT', 20);
// Question quality: the model keeps a notebook of what the answers settled (at most this many
// entries) and no more than AKINATOR_TOPIC_STREAK_LIMIT questions in a row may circle the same
// subject (hair, sports, weapons ...) without a yes.
const AKINATOR_STATE_LIST_LIMIT = positiveEnvInt('AKINATOR_STATE_LIST_LIMIT', 30);
const AKINATOR_TOPIC_STREAK_LIMIT = positiveEnvInt('AKINATOR_TOPIC_STREAK_LIMIT', 2);
// Gemini
const AKINATOR_REQUEST_TIMEOUT_MS = positiveEnvInt('AKINATOR_REQUEST_TIMEOUT_MS', 35000);
const AKINATOR_GEMINI_MAX_OUTPUT_TOKENS = positiveEnvInt('AKINATOR_GEMINI_MAX_OUTPUT_TOKENS', 1400);
const AKINATOR_GEMINI_QUESTION_OUTPUT_TOKENS = positiveEnvInt('AKINATOR_GEMINI_QUESTION_OUTPUT_TOKENS', 256);
const AKINATOR_GEMINI_SEARCH_OUTPUT_TOKENS = positiveEnvInt('AKINATOR_GEMINI_SEARCH_OUTPUT_TOKENS', 600);
const AKINATOR_SEARCH_GROUNDING_ENABLED = envBool('AKINATOR_SEARCH_GROUNDING_ENABLED', true);
const AKINATOR_SEARCH_ANSWER_CONTEXT_COUNT = positiveEnvInt('AKINATOR_SEARCH_ANSWER_CONTEXT_COUNT', 8);
// Character lookup. AniList is tried first (the card system already relies on it), then
// Jikan (MyAnimeList). Jikan allows roughly one request per second.
const AKINATOR_ANILIST_URL = process.env.AKINATOR_ANILIST_URL || 'https://graphql.anilist.co';
const AKINATOR_ANILIST_ENABLED = envBool('AKINATOR_ANILIST_ENABLED', true);
const AKINATOR_JIKAN_API_BASE = (process.env.AKINATOR_JIKAN_API_BASE || 'https://api.jikan.moe/v4').replace(/\/+$/, '');
const AKINATOR_JIKAN_ENABLED = envBool('AKINATOR_JIKAN_ENABLED', true);
const AKINATOR_LOOKUP_TIMEOUT_MS = positiveEnvInt('AKINATOR_LOOKUP_TIMEOUT_MS', 12000);
const AKINATOR_JIKAN_MIN_INTERVAL_MS = positiveEnvInt('AKINATOR_JIKAN_MIN_INTERVAL_MS', 1100);
const AKINATOR_LOOKUP_SEARCH_LIMIT = positiveEnvInt('AKINATOR_LOOKUP_SEARCH_LIMIT', 6);
const AKINATOR_IMAGE_MAX_BYTES = positiveEnvInt('AKINATOR_IMAGE_MAX_BYTES', 5 * 1024 * 1024);
// Only pictures from these hosts are downloaded (comma separated).
const AKINATOR_IMAGE_HOSTS = (process.env.AKINATOR_IMAGE_HOSTS || 's4.anilist.co,cdn.myanimelist.net')
  .split(',').map(host => host.trim().toLowerCase()).filter(Boolean);

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
  AI_CALL_NAMES_OVERRIDE,
  AI_PERSONA,
  AI_STICKERS_ENABLED,
  AI_STICKER_AUTO_ANALYZE,
  AI_STICKER_IMPORT_TIMEOUT_MINUTES,
  AI_STICKER_MAX_BYTES,
  AI_STICKER_DOWNLOAD_TIMEOUT_MS,
  PERSONAS_DIR,
  FISH_VOICE_ID,
  FISH_MODEL,
  FISH_REQUEST_TIMEOUT_MS,
  AI_STICKER_ANALYSIS_VERSION,
  AI_STICKER_MATCH_THRESHOLD,
  AI_STICKER_MIN_PERSONA_FIT,
  AI_STICKER_ANALYSIS_DELAY_MS,
  AI_STICKER_QUOTA_COOLDOWN_MS,
  AI_STICKER_QUOTA_MAX_COOLDOWN_MS,
  GEMINI_PAUSE_DURING_STICKER_ANALYSIS,
  GEMINI_COMMANDS,
  GEMINI_BUSY_MESSAGE,
  FISH_TEMPERATURE,
  FISH_TOP_P,
  FISH_SPEED,
  FISH_VOLUME_DB,
  FISH_LATENCY,
  FISH_CHUNK_LENGTH,
  FISH_EXPRESSION_TAGS,
  AI_VOICE_MAX_OUTPUT_TOKENS,
  AI_STICKER_CATALOGUE_MAX,
  AI_STICKER_RECENT_EXCLUDE,
  AI_STICKER_FIT_BATCH,
  AI_STICKER_VISION_BATCH,
  AI_HISTORY_EXPIRY_DAYS,
  AI_HISTORY_EXPIRY_SCOPE,
  AI_HISTORY_MESSAGES,
  AI_HISTORY_OWNER_KEPT,
  AI_HISTORY_OWNER_CONTEXT,
  AI_REACT_TO_REACTIONS,
  AI_REACT_CHANCE,
  AI_REACT_COOLDOWN_MS,
  AI_REACT_DELAY_MIN_MS,
  AI_REACT_DELAY_MAX_MS,
  AI_MESSAGE_MEMORY_MS,
  AI_MESSAGE_MEMORY_MAX,
  MESSAGE_CLAIM_ENABLED,
  MESSAGE_CLAIM_TTL_HOURS,
  MESSAGE_CLAIM_TIMEOUT_MS,
  MESSAGE_CLAIM_COOLDOWN_MS,
  BOT_ENGINE,
  AKINATOR_GEMINI_MODEL,
  AKINATOR_MIN_QUESTIONS,
  AKINATOR_MAX_QUESTIONS,
  AKINATOR_GUESS_CONFIDENCE,
  AKINATOR_STABLE_TURNS,
  AKINATOR_STABLE_CONFIDENCE,
  AKINATOR_MIN_CONFIDENCE_GAP,
  AKINATOR_MIN_SUPPORTING_EVIDENCE,
  AKINATOR_MAX_CONTRADICTIONS,
  AKINATOR_MAX_RUNNER_UP_CONFIDENCE_NO_CANDIDATE,
  AKINATOR_DUPLICATE_QUESTION_SIMILARITY,
  AKINATOR_UNVERIFIED_GUESS_AFTER,
  AKINATOR_SESSION_TIMEOUT_HOURS,
  AKINATOR_COMPLETED_RETENTION_HOURS,
  AKINATOR_CANDIDATE_HISTORY_LIMIT,
  AKINATOR_STATE_LIST_LIMIT,
  AKINATOR_TOPIC_STREAK_LIMIT,
  AKINATOR_REQUEST_TIMEOUT_MS,
  AKINATOR_GEMINI_MAX_OUTPUT_TOKENS,
  AKINATOR_GEMINI_QUESTION_OUTPUT_TOKENS,
  AKINATOR_GEMINI_SEARCH_OUTPUT_TOKENS,
  AKINATOR_SEARCH_GROUNDING_ENABLED,
  AKINATOR_SEARCH_ANSWER_CONTEXT_COUNT,
  AKINATOR_ANILIST_URL,
  AKINATOR_ANILIST_ENABLED,
  AKINATOR_JIKAN_API_BASE,
  AKINATOR_JIKAN_ENABLED,
  AKINATOR_LOOKUP_TIMEOUT_MS,
  AKINATOR_JIKAN_MIN_INTERVAL_MS,
  AKINATOR_LOOKUP_SEARCH_LIMIT,
  AKINATOR_IMAGE_MAX_BYTES,
  AKINATOR_IMAGE_HOSTS,
  TOURL_TIMEOUT_MS,
  TOURL_USER_AGENT,
  TOURL_LITTERBOX_HOURS,
  TOURL_PROVIDERS,
};
