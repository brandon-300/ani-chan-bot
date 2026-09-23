// ─── News-Specific Config ──────────────────────────────────────────────────
// News source definitions and ranking rules for commands/news.js. These are
// deliberately separate from utils/config.js: config.js is for
// environment-driven operational settings (timeouts, delays, UA), while the
// values here are curated content decisions — which sources to trust and
// what counts as "real anime news". You edit these in code, not .env.
//
// Google News coverage (including Netflix/Tudum, which has no first-party
// RSS feed) and the overall fallback live here too, via NEWS_RSS_QUERY from
// utils/config.js.

const { NEWS_RSS_QUERY } = require('./config');

// ─── RSS source definitions ────────────────────────────────────────────────
// Multiple official anime news sources. The order here is irrelevant at
// runtime — commands/news.js shuffles it every run and merges all results
// (see fetchAllArticles in commands/news.js).
//
// Netflix/Tudum: Netflix publishes no RSS feed for Tudum, so Netflix
// coverage arrives through the Google News feed — which also acts as the
// overall fallback when the direct feeds fail or have nothing new.
const NEWS_SOURCES = [
  {
    name: 'Crunchyroll News',
    url: 'https://cr-news-api-service.prd.crunchyrollsvc.com/v1/en-US/rss',
  },
  {
    name: 'Anime News Network',
    url: 'https://www.animenewsnetwork.com/all/rss.xml',
  },
  {
    name: 'MyAnimeList News',
    url: 'https://myanimelist.net/rss/news.xml',
  },
  {
    name: 'Google News',
    url: `https://news.google.com/rss/search?q=${encodeURIComponent(NEWS_RSS_QUERY)}&hl=en-US&gl=US&ceid=US:en`,
  },
];

// ─── Content relevance ranking terms ───────────────────────────────────────
// Brandon flagged a real example that slipped through a plain keyword
// search: a "Anime Dice codes (September 2026) for Lucky Spins" article
// from GamesRadar+ — a gacha-game code roundup that only matched because
// the word "Anime" is in its title, not actual anime/manga news. Feeds'
// own ordering is recency-based, not relevance-to-what-Brandon-means-by-
// "anime news" based, so a second pass re-ranks by content signal before
// picking an article — HIGH_PRIORITY_TERMS score up (episodes, seasons,
// movies, studio/voice-actor news, anime-based games/events — exactly the
// categories Brandon named), LOW_PRIORITY_TERMS score down hard
// (game-code/guide-site patterns). This is a heuristic, not a classifier —
// no per-article AI call, to keep this fast, free, and not dependent on
// another API being up on an unstable mobile connection.
//
// Weighting (title hits outweigh description hits — see scoreArticle in
// commands/news.js): HIGH = +3 per title hit, +1 per description hit;
// LOW = −5 per title hit, −2 per description hit.
const HIGH_PRIORITY_TERMS = [
  'season', 'episode', 'premiere', 'trailer', 'movie', 'film', 'ova',
  'anime adaptation', 'adaptation', 'studio', 'voice actor', 'cast',
  'announced', 'announcement', 'confirmed', 'revealed', 'new season',
  'cour', 'finale', 'renewed', 'greenlit', 'manga', 'manhwa', 'donghua',
  'chapter', 'volume', 'exhibition', 'anniversary', 'streaming',
];
const LOW_PRIORITY_TERMS = [
  'codes', 'redeem', 'coupon', 'promo code', 'tier list', 'walkthrough',
  'guide', 'gacha', 'patch notes', 'update notes', 'tier', 'build',
  'cheats', 'tips and tricks', 'best characters',
];

module.exports = {
  NEWS_SOURCES,
  HIGH_PRIORITY_TERMS,
  LOW_PRIORITY_TERMS,
};
