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

// How many NOT-yet-seen articles the daily auto-broadcast sends per group.
// .news itself always sends exactly 1 — see the .news command below.
const DAILY_BROADCAST_LIMIT = 5;
const SEND_DELAY_MS = 2000; // gap between individual message sends — see sendArticlesTo()

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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
// News itself returns) — no slicing here. Callers decide how many they
// actually want AFTER filtering out what a given chat has already seen
// (see filterUnseen below) — slicing before that filter would mean a chat
// that's already seen the top few articles gets fewer results than it
// should.
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

function formatArticle(article) {
  return (
    `📰 *ANIME NEWS UPDATE* 📰\n\n` +
    `*${article.title}*\n` +
    `_via ${article.source}_\n\n` +
    `🔗 *Read More*\n${article.link}`
  );
}

// Sends each article as its OWN message (rather than one combined digest)
// so WhatsApp generates a native link-preview card per article — matching
// how the reference bot posts these in Brandon's screenshots. Each article
// is marked as sent to this chat right before it's actually sent (same
// ordering .pinterest already uses for SentPin) so a repeated .news call
// right after never hands back something already shown here. A failed
// send (e.g. the bot got removed from a group between the getChats()
// snapshot and now) is logged and skipped rather than aborting the batch.
async function sendArticlesTo(chat, articles) {
  const chatId = chat.id._serialized;
  for (const article of articles) {
    try {
      await SentNews.create({ chatId, articleId: article.link }).catch(() => {});
      await chat.sendMessage(formatArticle(article));
    } catch (err) {
      console.error(`.news: failed to send an article to ${chatId}:`, err.message);
    }
    await sleep(SEND_DELAY_MS);
  }
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
  // article this chat hasn't already been sent (freshest first). No
  // acknowledgement text: just a 📰 reaction on the command itself, then
  // the article — nothing else on the happy path.
  async news(client, msg, args) {
    if (!await requireAdmin(msg)) return;

    const chat = await safeGetChat(msg).catch(() => null);
    if (!chat) return msg.reply('⚠️ WhatsApp connection hiccup — please try again in a moment.');

    await msg.react('📰').catch(() => {});

    let fresh;
    try {
      const all = await fetchAllArticles();
      fresh = await filterUnseen(chat.id._serialized, all);
    } catch (err) {
      console.error('.news: fetch failed:', err.message);
      return msg.reply('❌ Could not fetch news right now — try again in a bit.');
    }

    if (!fresh.length) {
      return msg.reply(`📭 You're all caught up — no new anime/manga news right now. Check back later!`);
    }

    await sendArticlesTo(chat, [fresh[0]]);
  },

  // Internal — called every minute by index.js's scheduler (same shape as
  // _maybeSendDailyStats in commands/general.js). Sends up to
  // DAILY_BROADCAST_LIMIT NOT-yet-seen articles, unprompted, to every group
  // the bot is CURRENTLY in — live via client.getChats(), not a stored
  // list, so a group the bot was removed from simply isn't in it anymore.
  // The feed itself is only fetched ONCE per run (not once per group) —
  // each group's own seen/unseen set is then checked locally against that
  // same fetch, which is what filterUnseen is for. Once a day, right after
  // 8:00 AM WAT (= 07:00 UTC — Nigeria has used WAT year-round with no DST
  // since 1919, so this fixed offset never needs adjusting). BotState
  // remembers the last date this actually ran, so a PM2 restart landing in
  // that exact minute can't cause a duplicate broadcast.
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
        const fresh = await filterUnseen(chat.id._serialized, articles);
        if (fresh.length) await sendArticlesTo(chat, fresh.slice(0, DAILY_BROADCAST_LIMIT));
      } catch (err) {
        console.error(`❌ Daily anime news: failed for ${chat.id._serialized}:`, err.message);
      }
      await sleep(SEND_DELAY_MS); // extra gap between groups, on top of the per-article gap above
    }

    await BotState.findOneAndUpdate(
      { key: 'dailyNewsLastSent' },
      { value: todayKey },
      { upsert: true }
    );
    console.log(`✅ Daily anime news checked for ${groupChats.length} group(s) at ${now.toLocaleString()}`);
  },
};
