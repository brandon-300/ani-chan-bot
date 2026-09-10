const axios = require('axios');
const BotState = require('../models/BotState');
const SentNews = require('../models/SentNews');
const { isOwner, isAdmin, safeGetChat } = require('../utils/helpers');
const { NEWS_RSS_QUERY } = require('../utils/config');

const GOOGLE_NEWS_RSS_URL =
  `https://news.google.com/rss/search?q=${encodeURIComponent(NEWS_RSS_QUERY)}&hl=en-US&gl=US&ceid=US:en`;

// A normal browser User-Agent tends to get a cleaner response from Google
// News than an identifying bot UA (unlike Danbooru in utils/danbooru.js,
// which requires a unique identifying UA per its API terms — Google News
// has no such requirement here, it's just being scraped as a public RSS
// feed).
const NEWS_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const SEND_DELAY_MS = 2000; // gap between groups in the daily broadcast — see _maybeSendDailyNews

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ─── Content relevance ranking ──────────────────────────────────────────────
// Brandon flagged a real example that slipped through the plain keyword
// search: a "Anime Dice codes (September 2026) for Lucky Spins" article from
// GamesRadar+ — a gacha-game code roundup that only matched because the
// word "Anime" is in its title, not actual anime/manga news. Google News'
// own ordering is recency-based, not relevance-to-what-Brandon-means-by
// "anime news" based, so a second pass here re-ranks by content signal
// before picking an article — HIGH_PRIORITY_TERMS score up (episodes,
// seasons, movies, studio/voice-actor news, anime-based games/events —
// exactly the categories Brandon named), LOW_PRIORITY_TERMS score down hard
// (game-code/guide-site patterns). This is a heuristic, not a classifier —
// no per-article AI call, to keep this fast, free, and not dependent on
// another API being up on Brandon's unstable connection for every single
// .news call.
//
// Recency is still respected: Array.prototype.sort is stable in Node (ES2019+),
// so articles with an equal score keep the feed's own freshest-first order —
// this only reorders when content signal actually disagrees with plain
// recency, it doesn't discard recency otherwise.
const HIGH_PRIORITY_TERMS = [
  'episode', 'season', 'anime film', 'movie', 'studio', 'voice actor', 'seiyuu',
  'cast', 'trailer', 'premiere', 'release date', 'adaptation', 'light novel',
  'opening theme', 'ending theme', 'dub', 'simulcast', 'ova', 'director',
  'crunchyroll', 'myanimelist', 'manga', 'manhwa', 'donghua', 'chapter',
  'volume', 'story arc', 'protagonist', 'anime expo', 'anime convention',
  'video game', 'game adaptation', 'collab',
];

const LOW_PRIORITY_TERMS = [
  'codes', 'redeem code', 'promo code', 'coupon code', 'tier list',
  'walkthrough', 'cheat', 'how to get', 'beginner guide', 'gift code',
  'lucky spin', 'lucky spins',
];

function scoreArticle(article) {
  const text = article.title.toLowerCase();
  let score = 0;
  for (const term of HIGH_PRIORITY_TERMS) if (text.includes(term)) score += 2;
  for (const term of LOW_PRIORITY_TERMS) if (text.includes(term)) score -= 5;
  return score;
}

// Re-ranks by content relevance (see above) — a plain copy+sort, so the
// input array (whatever filterUnseen returned) is left untouched.
function rankByRelevance(articles) {
  return [...articles].sort((a, b) => scoreArticle(b) - scoreArticle(a));
}

// ─── Google News RSS parsing ────────────────────────────────────────────────
// Hand-rolled with regex instead of pulling in an XML/RSS parser package —
// this bot deliberately avoids adding npm dependencies where a small amount
// of string handling can do the job instead, since `npm install` on
// Brandon's unstable mobile data is something to avoid (same reasoning as
// the Gemini calls going through raw axios instead of an SDK). Google News
// RSS's <item> shape is simple and stable enough for this:
//
//   <item>
//     <title>Article Title - Source Name</title>
//     <link>https://news.google.com/rss/articles/...</link>
//     <pubDate>...</pubDate>
//     <source url="https://source-site.com">Source Name</source>
//   </item>
//
// UNCERTAINTY FLAGGED: this sandbox has no network access, so none of this
// could be test-fetched against the real feed — the shape above is from
// Google News RSS's well-documented, long-stable format, but if `.news`
// comes back empty or garbled after deploying, that's the first place to
// look (paste me the raw output of `curl -A "<UA above>" "<RSS URL
// above>"` from Termux and I'll adjust the parsing to match).
function decodeXmlEntities(str) {
  if (!str) return str;
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&'); // must run LAST, or "&amp;lt;" etc. would double-decode
}

function stripHtmlTags(str) {
  return str ? str.replace(/<[^>]*>/g, '').trim() : str;
}

// Handles both `<tag>text</tag>` and `<tag><![CDATA[text]]></tag>` — Google
// News RSS doesn't currently CDATA-wrap these fields, but being tolerant of
// both costs nothing and avoids silently breaking if that ever changes.
function extractTag(itemXml, tagName) {
  const cdata = new RegExp(`<${tagName}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tagName}>`, 'i').exec(itemXml);
  if (cdata) return cdata[1].trim();
  const plain = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, 'i').exec(itemXml);
  return plain ? plain[1].trim() : null;
}

function parseGoogleNewsRss(xml) {
  const itemBlocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  const articles = [];

  for (const block of itemBlocks) {
    const link = extractTag(block, 'link');
    let title = decodeXmlEntities(stripHtmlTags(extractTag(block, 'title') || ''));
    if (!title || !link) continue;

    const sourceRaw = extractTag(block, 'source');
    const source = sourceRaw ? decodeXmlEntities(stripHtmlTags(sourceRaw)) : null;

    // Google News titles arrive as "Article Title - Source Name" — trim the
    // redundant "- Source Name" suffix since the source is shown on its
    // own line below (avoids the title/source repetition Miyabi's own
    // output shows in Brandon's screenshots).
    if (source && title.endsWith(` - ${source}`)) {
      title = title.slice(0, title.length - (` - ${source}`).length).trim();
    }

    articles.push({ title, link: decodeXmlEntities(link), source: source || 'Google News' });
  }

  return articles;
}

// Fetches and parses the full feed, freshest-first (whatever order Google
// News itself returns) — no slicing here. Callers filter out what a chat's
// already seen (filterUnseen) and re-rank by content relevance
// (rankByRelevance) before picking anything.
async function fetchAllArticles() {
  const { data } = await axios.get(GOOGLE_NEWS_RSS_URL, {
    headers: { 'User-Agent': NEWS_USER_AGENT },
    timeout: 15000,
  });
  return parseGoogleNewsRss(data);
}

// Same seen/unseen tracking pattern as .pinterest (models/SentPin.js) and
// .wallpaper (models/SentWallpaper.js) — dedup is per-chat, using the
// article's link as its identity (see models/SentNews.js).
async function filterUnseen(chatId, articles) {
  if (!articles.length) return [];
  const seenDocs = await SentNews.find({
    chatId,
    articleId: { $in: articles.map(a => a.link) },
  }).select('articleId -_id');
  const seenIds = new Set(seenDocs.map(d => d.articleId));
  return articles.filter(a => !seenIds.has(a.link));
}

// Combines both steps above into "the one article this chat should get
// right now", or null if there's genuinely nothing unseen left.
async function pickNextArticle(chatId, articles) {
  const unseen = await filterUnseen(chatId, articles);
  if (!unseen.length) return null;
  return rankByRelevance(unseen)[0];
}

function formatArticle(article) {
  return (
    `📰 *ANIME NEWS UPDATE* 📰\n\n` +
    `*${article.title}*\n` +
    `_via ${article.source}_\n\n` +
    `🔗 *Read More*\n${article.link}`
  );
}

async function markSent(chatId, article) {
  await SentNews.create({ chatId, articleId: article.link }).catch(() => {});
}

// Same admin-or-owner gate as commands/admin.js's requireAdmin — duplicated
// locally rather than imported since admin.js doesn't export it (matches
// the existing per-file gate-helper pattern, e.g. checkOwner in
// commands/economy.js).
async function requireAdmin(msg) {
  const contact = await msg.getContact().catch(() => null);
  if (contact && isOwner(contact.id._serialized)) return true;
  const ok = await isAdmin(msg);
  if (!ok) { msg.reply('❌ Admins only!'); return false; }
  return true;
}

module.exports = {
  // .news — admin-only (WhatsApp group admin, or the bot owner). Takes no
  // arguments — always sends exactly the next anime/manga/manhwa/donghua
  // article this chat hasn't already been sent, ranked by content
  // relevance (see rankByRelevance above) so genuine anime news outranks
  // things that just happen to mention "anime". No acknowledgement text:
  // a 📰 reaction on the command itself, then the article AS A REPLY to
  // that command (msg.reply, not chat.sendMessage — this is what makes it
  // show up as a reply bubble in WhatsApp) — nothing else on the happy path.
  async news(client, msg, args) {
    if (!await requireAdmin(msg)) return;

    const chat = await safeGetChat(msg).catch(() => null);
    if (!chat) return msg.reply('⚠️ WhatsApp connection hiccup — please try again in a moment.');

    await msg.react('📰').catch(() => {});

    let article;
    try {
      const all = await fetchAllArticles();
      article = await pickNextArticle(chat.id._serialized, all);
    } catch (err) {
      console.error('.news: fetch failed:', err.message);
      return msg.reply('❌ Could not fetch news right now — try again in a bit.');
    }

    if (!article) {
      return msg.reply(`📭 You're all caught up — no new anime/manga news right now. Check back later!`);
    }

    await markSent(chat.id._serialized, article);
    // msg.reply() (not chat.sendMessage()) — quotes the .news command
    // itself, which is what renders as a reply bubble in WhatsApp.
    await msg.reply(formatArticle(article));
  },

  // Internal — called every minute by index.js's scheduler (same shape as
  // _maybeSendDailyStats in commands/general.js). Sends exactly 1
  // NOT-yet-seen article, unprompted, to every group the bot is CURRENTLY
  // in — live via client.getChats(), not a stored list, so a group the bot
  // was removed from simply isn't in it anymore. The feed itself is only
  // fetched ONCE per run (not once per group) — each group's own
  // seen/unseen set and relevance ranking is then computed locally against
  // that same fetch. Once a day, right after 8:00 AM WAT (= 07:00 UTC —
  // Nigeria has used WAT year-round with no DST since 1919, so this fixed
  // offset never needs adjusting). BotState remembers the last date this
  // actually ran, so a PM2 restart landing in that exact minute can't
  // cause a duplicate broadcast.
  //
  // This has no triggering message to reply to (it's unprompted, not a
  // response to a command) — chat.sendMessage() is correct here, unlike
  // .news above.
  async _maybeSendDailyNews(client) {
    const now = new Date();
    if (now.getUTCHours() !== 7 || now.getUTCMinutes() !== 0) return;

    const todayKey = now.toISOString().slice(0, 10);
    const state = await BotState.findOne({ key: 'dailyNewsLastSent' }).catch(() => null);
    if (state?.value === todayKey) return;

    let articles;
    try {
      articles = await fetchAllArticles();
    } catch (err) {
      console.error('❌ Daily anime news fetch failed:', err.message);
      return;
    }
    if (!articles.length) return;

    let groupChats = [];
    try {
      groupChats = (await client.getChats()).filter(c => c.isGroup);
    } catch (err) {
      console.error('❌ Daily anime news: getChats failed:', err.message);
      return;
    }

    for (const chat of groupChats) {
      try {
        const chatId = chat.id._serialized;
        const article = await pickNextArticle(chatId, articles);
        if (article) {
          await markSent(chatId, article);
          await chat.sendMessage(formatArticle(article));
        }
      } catch (err) {
        console.error(`❌ Daily anime news: failed for ${chat.id._serialized}:`, err.message);
      }
      await sleep(SEND_DELAY_MS); // gap between groups
    }

    await BotState.findOneAndUpdate(
      { key: 'dailyNewsLastSent' },
      { value: todayKey },
      { upsert: true }
    );
    console.log(`✅ Daily anime news checked for ${groupChats.length} group(s) at ${now.toLocaleString()}`);
  },
};
