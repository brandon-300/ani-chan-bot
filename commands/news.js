const axios = require('axios');
const BotState = require('../models/BotState');
const SentNews = require('../models/SentNews');
const { isOwner, isAdmin, safeGetChat } = require('../utils/helpers');
const {
  NEWS_USER_AGENT,
  NEWS_FETCH_TIMEOUT_MS,
  NEWS_SEND_DELAY_MS,
  NEWS_MAX_ARTICLE_AGE_DAYS,
} = require('../utils/config');
const {
  NEWS_SOURCES,
  HIGH_PRIORITY_TERMS,
  LOW_PRIORITY_TERMS,
} = require('../utils/newsConfig');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// In-process re-entrancy lock for the hourly broadcast. The scheduler ticks
// every minute, and a run can legitimately take longer than a minute when
// there are many groups (each group waits NEWS_SEND_DELAY_MS). Without this
// lock, the next tick could enter _maybeSendDailyNews while the previous run
// is still sending — both would read the pre-run hourlyNewsLastRun value from
// BotState and both would broadcast, doubling every group's message for that
// hour. The BotState hour-key remains in place because it guards the OTHER
// overlap window this lock can't see: a PM2 restart landing in the same hour
// (a restart wipes this variable, but the Mongo key survives it).
let hourlyNewsRunning = false;

// ─── URL normalization + dedup ─────────────────────────────────────────────
// SentNews uses the article link as its identity (models/SentNews.js), so
// the SAME story arriving from two feeds with cosmetically different URLs
// (e.g. one with ?utm_source=google attached) would otherwise count as two
// different articles and get sent twice. normalizeUrl collapses those
// cosmetic differences into one canonical string:
//   • lowercases the protocol/host
//   • drops 'www.'
//   • strips the fragment (#...)
//   • strips common tracking query params (utm_*, fbclid, gclid, etc.)
//   • strips any trailing slash on the path
// Path case and remaining params are preserved — they can be meaningful.
const TRACKING_PARAMS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'gclid', 'mc_cid', 'mc_eid', 'ref', 'source', 'igshid',
];

function normalizeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl.trim());
    url.hash = '';
    url.username = '';
    url.password = '';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    url.protocol = url.protocol.toLowerCase();

    const params = new URLSearchParams(url.search);
    for (const param of TRACKING_PARAMS) params.delete(param);
    params.sort();
    url.search = params.toString();

    if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1);
    }
    return url.toString();
  } catch {
    // Not parseable as a URL — fall back to the raw string so dedup still
    // does no worse than exact-match.
    return rawUrl.trim();
  }
}

// ─── Content relevance ranking ─────────────────────────────────────────────
// Scoring looks at BOTH the title and the description/summary the feed
// provides (parsed below) — title hits signal intent ("New Anime Project
// Announced..."), description hits confirm what the article is actually
// about. A pure-title scorer would rank an unrelated article high just for
// having "announced" in the headline. Title hits outweigh description hits
// (3:1 high, 5:2 low) because the title is the strongest single signal but
// the description is where guide-site/codes roundups actually give
// themselves away. No per-article AI call — fast, free, and not dependent
// on another API being up on an unstable mobile connection.

function scoreArticle(article) {
  const title = (article.title || '').toLowerCase();
  const description = (article.description || '').toLowerCase();

  let score = 0;
  for (const term of HIGH_PRIORITY_TERMS) {
    if (title.includes(term)) score += 3;
    if (description.includes(term)) score += 1;
  }
  for (const term of LOW_PRIORITY_TERMS) {
    if (title.includes(term)) score -= 5;
    if (description.includes(term)) score -= 2;
  }
  // Gentle recency bonus — newer items edge out equally-scored older ones.
  if (article.publishedAt) {
    const ageDays = (Date.now() - article.publishedAt) / 86400000;
    if (ageDays >= 0 && ageDays <= NEWS_MAX_ARTICLE_AGE_DAYS) {
      score += Math.max(0, 3 - ageDays); // up to +3, decaying daily
    }
  }
  return score;
}

function rankByRelevance(articles) {
  return [...articles].sort((a, b) => scoreArticle(b) - scoreArticle(a));
}

// ─── Feed fetching + parsing ───────────────────────────────────────────────

function stripCdata(text) {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<!\[CDATA\[(?<inner>[\s\S]*)$/i, '$<inner>'); // tolerate unterminated CDATA
}

function decodeEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    // Hex numeric entities (&#x27;, &#x2019;, ...) — feeds (Google News
    // especially) emit these regularly; without this they leaked into
    // titles/descriptions as literal "&#x...;" text.
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&nbsp;/g, ' ');
}

function cleanText(raw) {
  if (!raw) return '';
  // Strip basic HTML tags — RSS descriptions routinely contain markup.
  const noTags = stripCdata(raw).replace(/<[^>]+>/g, ' ');
  return decodeEntities(noTags).replace(/\s+/g, ' ').trim();
}

function extractTag(block, tag) {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return match ? cleanText(match[1]) : '';
}

function extractLink(block) {
  // Atom-style: <link rel="..." href="https://..." /> — prefer the alternate link
  const atomAlt = block.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i)
    || block.match(/<link[^>]*href=["']([^"']+)["']/i);
  if (atomAlt) return decodeEntities(atomAlt[1].trim());
  // RSS-style: <link>https://...</link>
  const rssLink = block.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
  if (rssLink) {
    const url = cleanText(rssLink[1]);
    if (url.startsWith('http')) return url;
  }
  return '';
}

function extractDate(block) {
  const raw = extractTag(block, 'pubDate')
    || extractTag(block, 'published')
    || extractTag(block, 'updated')
    || extractTag(block, 'dc:date');
  if (!raw) return null;
  const ts = Date.parse(raw);
  return Number.isNaN(ts) ? null : ts;
}

// Hand-rolled regex parser (no XML library) — handles both RSS 2.0 <item>
// and Atom <entry> blocks, which covers every source in NEWS_SOURCES.
// Parses title, link, description/summary (for scoring), and pubDate.
function parseFeed(xml, sourceName) {
  const blocks = [
    ...(xml.match(/<item[\s\S]*?<\/item>/gi) || []),
    ...(xml.match(/<entry[\s\S]*?<\/entry>/gi) || []),
  ];

  const articles = [];
  for (const block of blocks) {
    const title = extractTag(block, 'title');
    const link = extractLink(block);
    if (!title || !link) continue;

    const description =
      extractTag(block, 'description')
      || extractTag(block, 'summary')
      || extractTag(block, 'content:encoded')
      || extractTag(block, 'content');

    const publishedAt = extractDate(block);
    // Skip stale backlog items so a first run can't flood groups with old news.
    if (publishedAt && Date.now() - publishedAt > NEWS_MAX_ARTICLE_AGE_DAYS * 86400000) continue;

    const normalizedLink = normalizeUrl(link);

    articles.push({
      title,
      link,
      normalizedLink,
      description,
      source: sourceName,
      publishedAt,
    });
  }

  // Dedupe by normalized link — same story syndicated on two feeds, or the
  // same story with/without tracking params, counts once. First occurrence
  // (earlier in its own feed = newer) wins.
  const seen = new Set();
  return articles.filter(a => (seen.has(a.normalizedLink) ? false : (seen.add(a.normalizedLink), true)));
}

async function fetchSource(source) {
  const { data } = await axios.get(source.url, {
    headers: { 'User-Agent': NEWS_USER_AGENT },
    timeout: NEWS_FETCH_TIMEOUT_MS,
    responseType: 'text',
  });
  return parseFeed(typeof data === 'string' ? data : String(data), source.name);
}

// Fisher–Yates shuffle — randomizes the source order each run.
function shuffle(array) {
  const out = [...array];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Fetches ALL sources in parallel (Google News included — it's a fourth
// always-on source that widens coverage, not a sequential fallback; it only
// *behaves* like a safety net because its broad query still returns items
// when a direct feed fails or has nothing new), then MERGES every
// successful source's results into one pool; relevance ranking
// (scoreArticle) decides what gets sent, not source order. Because all
// sources are fetched, the randomized order is NOT "which site the news
// comes from" — it only (a) breaks ties in equal-score situations more
// variedly across runs, and (b) varies which story tops the merged pool
// among equally-scored candidates. Any source that fails (bad internet,
// feed down, etc.) is skipped rather than failing the whole run — the news
// goes out from whichever sources actually respond. If every source fails,
// an empty array is returned.
async function fetchAllArticles() {
  const randomizedSources = shuffle(NEWS_SOURCES);
  const results = await Promise.allSettled(
    randomizedSources.map(source => fetchSource(source))
  );

  const articles = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      articles.push(...result.value);
    } else {
      const sourceName = randomizedSources[i].name;
      console.error(`⚠️ News source "${sourceName}" failed:`, result.reason?.message || result.reason);
    }
  }

  // Re-dedupe across sources by normalized link (same story syndicated on
  // multiple feeds, with or without tracking params, counts once).
  const seen = new Set();
  return articles.filter(a => (seen.has(a.normalizedLink) ? false : (seen.add(a.normalizedLink), true)));
}

// Same seen/unseen tracking pattern as .pinterest (models/SentPin.js) and
// .wallpaper (models/SentWallpaper.js) — dedup is per-chat, using the
// article's NORMALIZED link as its identity (see models/SentNews.js).
async function filterUnseen(chatId, articles) {
  if (!articles.length) return [];
  const seenDocs = await SentNews.find({
    chatId,
    articleId: { $in: articles.map(a => a.normalizedLink) },
  }).select('articleId -_id');
  const seenIds = new Set(seenDocs.map(d => d.articleId));
  return articles.filter(a => !seenIds.has(a.normalizedLink));
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

// NOTE: markSent stores the NORMALIZED link (article.normalizedLink), while
// formatArticle shows the original link (article.link) — the message
// displays the URL exactly as the feed published it, but dedup stays
// tracking-param-proof.

async function markSent(chatId, article) {
  await SentNews.create({ chatId, articleId: article.normalizedLink }).catch(() => {});
}

// Sends the article with a WhatsApp link preview (the website card with
// title/description/thumbnail) by passing linkPreview: true explicitly.
// whatsapp-web.js fetches the page's preview metadata itself; on a bad
// connection it may fall back to a plain-text link, which is harmless.
async function sendArticle(chat, article) {
  await chat.sendMessage(formatArticle(article), { linkPreview: true });
}

// Same admin-or-owner gate as commands/admin.js's requireAdmin — duplicated
// locally rather than imported since admin.js doesn't export it (matches
// the existing per-file gate-helper pattern, e.g. checkOwner in
// commands/economy.js).
async function requireAdmin(msg) {
  const contact = await msg.getContact().catch(() => null);
  if (contact && isOwner(contact.id._serialized)) return true;
  const ok = await isAdmin(msg);
  if (!ok) {
    await msg.reply('❌ Admins only!').catch(() => {});
    return false;
  }
  return true;
}

module.exports = {
  // .news — admin-only (WhatsApp group admin, or the bot owner). Takes no
  // arguments — always sends exactly the next anime/manga/manhwa/donghua
  // article this chat hasn't already been sent, ranked by content relevance
  // (see scoreArticle above — title + description scoring) so genuine anime
  // news outranks things that just happen to mention "anime". If every
  // source is caught up, tells the user so instead of sending nothing —
  // this is a COMMAND, so silence would just look like the bot ignoring
  // them. No acknowledgement text: a 📰 reaction on the command itself,
  // then the article AS A REPLY to that command (msg.reply, not
  // chat.sendMessage — this is what makes it show up as a reply bubble in
  // WhatsApp) — nothing else on the happy path.
  //
  // The article is marked as sent ONLY after msg.reply() succeeds, so a
  // failed send is retried on the next .news call instead of being
  // silently skipped (same order guarantee the hourly broadcast uses).
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
      return msg.reply(`📭 You're all caught up — no new anime news right now. Check back later!`);
    }

    // msg.reply() (not chat.sendMessage()) — quotes the .news command
    // itself, which is what renders as a reply bubble in WhatsApp. Send
    // FIRST, mark sent SECOND: if the reply fails (network blip), the
    // article stays unseen and is retried next time.
    await msg.reply(formatArticle(article));
    await markSent(chat.id._serialized, article);
  },

  // Internal — called every minute by index.js's scheduler (same shape as
  // _maybeSendDailyStats in commands/general.js). Runs ONCE PER HOUR (on the
  // hour, WAT — Nigeria is fixed UTC+1 with no DST, so "on the hour" is the
  // same instant in WAT and UTC). Sends exactly 1 NOT-yet-seen article, with
  // a link preview, to every group the bot is CURRENTLY in — live via
  // client.getChats(), not a stored list, so a group the bot was removed
  // from simply isn't in it anymore. All sources are fetched in parallel
  // once per run and merged (see fetchAllArticles). The feeds are fetched
  // ONCE per run (not once per group) — each group's own seen/unseen set
  // and relevance ranking is then computed locally against that same fetch.
  //
  // If no group has any unseen article (everything's been seen / all feeds
  // empty), NOTHING is sent — this is an unprompted broadcast, so silence is
  // the correct "all caught up" behavior here (the .news command above is
  // the one that talks back).
  //
  // Two guards against duplicate broadcasts, complementary by design:
  //   • hourlyNewsRunning (RAM, this process) — stops the next scheduler
  //     tick from entering while a slow run (many groups × send delay) is
  //     still in flight. Released in finally, so even a throw can't wedge
  //     the lock and permanently kill future hourly broadcasts.
  //   • BotState 'hourlyNewsLastRun' hour-key (Mongo, survives restarts) —
  //     stops a PM2 restart landing in the same hour from re-broadcasting.
  //
  // This has no triggering message to reply to (it's unprompted, not a
  // response to a command) — chat.sendMessage() is correct here, unlike
  // .news above.
  async _maybeSendDailyNews(client) {
    const now = new Date();
    // Fire on the hour, every hour (minute 0). UTC hour === WAT hour − 1,
    // and since both clocks tick hourly, "minute === 0" is hourly in WAT.
    if (now.getUTCMinutes() !== 0) return;

    // In-process re-entrancy lock — a previous run (same process) is still
    // sending; bail out and let it finish this hour.
    if (hourlyNewsRunning) return;
    hourlyNewsRunning = true;

    try {
      // Hour key — e.g. "2026-09-23T14". One run per wall-clock hour.
      const hourKey = now.toISOString().slice(0, 13);
      const state = await BotState.findOne({ key: 'hourlyNewsLastRun' }).catch(() => null);
      if (state?.value === hourKey) return;

      let articles;
      try {
        articles = await fetchAllArticles();
      } catch (err) {
        console.error('❌ Hourly anime news fetch failed:', err.message);
        return;
      }
      if (!articles.length) {
        // All sources failed or all items were stale — stay quiet, and only
        // record the hour AFTER a successful path so a failed hour retries.
        return;
      }

      let groupChats = [];
      try {
        groupChats = (await client.getChats()).filter(c => c.isGroup);
      } catch (err) {
        console.error('❌ Hourly anime news: getChats failed:', err.message);
        return;
      }

      let sentCount = 0;
      for (const chat of groupChats) {
        try {
          const chatId = chat.id._serialized;
          const article = await pickNextArticle(chatId, articles);
          if (article) {
            await sendArticle(chat, article);
            // Mark as sent ONLY after the message actually went out, so a
            // failed send is retried next hour instead of being skipped.
            await markSent(chatId, article);
            sentCount++;
          }
        } catch (err) {
          console.error(`❌ Hourly anime news: failed for ${chat.id._serialized}:`, err.message);
        }
        await sleep(NEWS_SEND_DELAY_MS); // gap between groups
      }

      await BotState.findOneAndUpdate(
        { key: 'hourlyNewsLastRun' },
        { value: hourKey },
        { upsert: true }
      );
      console.log(`✅ Hourly anime news: ${sentCount} article(s) sent across ${groupChats.length} group(s) at ${now.toLocaleString()}`);
    } finally {
      hourlyNewsRunning = false;
    }
  },
};
