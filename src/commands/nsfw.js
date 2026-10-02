// commands/nsfw.js — NSFW image & link commands for AniChan Bot
// Gating: groups must enable with ".nsfw on" (admin only); DMs are owner-only.
// Images: Danbooru via shared utils/danbooru.js (rating-filtered, animated/video/comic excluded).
// Links: .ehentai / .nhentai perform REAL searches and return up to 5 fresh
//        gallery links per call. Every link sent is flagged in MongoDB
//        (models/SentNsfwLink.js) and never sent again. If the site can't be
//        reached (Cloudflare/unstable data), falls back to a plain search URL.

const axios = require('axios');
const { MessageMedia } = require('whatsapp-web.js');
const Group = require('../models/Group');
const User = require('../models/User');
const SentNsfwLink = require('../models/SentNsfwLink');
const { safeGetChat, isAdmin, isOwner, isMod, isVerifiedAdult } = require('../utils/helpers');
const { fetchRandomImage } = require('../utils/danbooru');
const { MIN_REGISTRATION_AGE } = require('../utils/config');

const PREFIX = process.env.BOT_PREFIX || '.';

const CATEGORIES = {
  milf:    { tags: 'milf',           rating: 'rating:explicit',  ratingLetters: ['e'],      label: 'Milf' },
  ass:     { tags: 'ass',            rating: 'rating:explicit',  ratingLetters: ['e'],      label: 'Ass' },
  hentai:  { tags: 'sex',            rating: 'rating:explicit',  ratingLetters: ['e'],      label: 'Hentai' },
  oral:    { tags: 'oral',           rating: 'rating:explicit',  ratingLetters: ['e'],      label: 'Oral' },
  paizuri: { tags: 'paizuri',        rating: 'rating:explicit',  ratingLetters: ['e'],      label: 'Paizuri' },
  oppai:   { tags: 'large_breasts',  rating: 'rating:explicit',  ratingLetters: ['e'],      label: 'Oppai' },
  ecchi:   { tags: 'ecchi',          rating: 'rating:sensitive', ratingLetters: ['s', 'q'], label: 'Ecchi' },
  ero:     { tags: 'ero',            rating: 'rating:sensitive', ratingLetters: ['s', 'q'], label: 'Ero' },
};

const COOLDOWN_MS = 10 * 1000;
const lastUse = new Map();
const activeRequests = new Set();
const LASTUSE_PRUNE_THRESHOLD = 200;

// Link-search tuning
const LINK_RESULTS_WANTED = 5;   // fresh gallery links per command
const LINK_MAX_PAGES = 5;        // pages walked per search before giving up
const LINK_FETCH_TIMEOUT = 30000;

// ─── Shared housekeeping ───────────────────────────────────────────────────
function sweepLastUse(now) {
  if (lastUse.size <= LASTUSE_PRUNE_THRESHOLD) return;
  for (const [id, ts] of lastUse) {
    if (now - ts > COOLDOWN_MS * 10) lastUse.delete(id);
  }
}

// ─── NSFW gate ──────────────────────────────────────────────────────────────
// Groups: the Group document must have nsfw=true (set via ".nsfw on").
// DMs: owner only.
// Either way, the sender ALSO needs a verified DOB (not just the group/DM
// access check above) — see the age-verification block below.
async function getNsfwGate(msg) {
  const chat = await safeGetChat(msg).catch(() => null);
  if (!chat) {
    return { ok: false, reply: '⚠️ WhatsApp connection hiccup — please try again in a moment.' };
  }

  const senderId = msg.author || msg.from;

  if (chat.isGroup) {
    const group = await Group.findOne({ id: chat.id._serialized }).catch(() => null);
    if (!group || !group.nsfw) {
      return {
        ok: false,
        reply: '❌ NSFW is disabled in this group.\nAdmin can enable it with *.nsfw on*',
      };
    }
  } else if (!isOwner(senderId)) {
    return { ok: false, reply: '❌ NSFW commands in DMs are owner-only.' };
  }

  // Age verification, independent of the group/DM check above — a group
  // having NSFW enabled says nothing about whether THIS sender is a
  // verified adult. Checked against registration.dobSet + the actual dob
  // (utils/helpers.js's isVerifiedAdult), never the mutable user.age
  // field. Owner/mods are exempt, the same way index.js's registration
  // gate already exempts them from registering at all — everyone else
  // needs to have gone through .setdob first.
  if (!isOwner(senderId) && !isMod(senderId)) {
    const user = await User.findOne({ id: senderId }).catch(() => null);
    if (!isVerifiedAdult(user)) {
      return {
        ok: false,
        reply:
          `❌ NSFW commands need a verified date of birth first.\n` +
          `Complete your profile with *.setdob [DD/MM/YYYY]* (must show you're ${MIN_REGISTRATION_AGE}+).`,
      };
    }
  }

  return { ok: true, chat };
}

// ─── Image helpers ──────────────────────────────────────────────────────────
function extAndMime(url) {
  const ext = String(url.split('.').pop() || 'jpg').toLowerCase();
  const mime =
    ext === 'png' ? 'image/png' :
    ext === 'webp' ? 'image/webp' :
    ext === 'gif' ? 'image/gif' : 'image/jpeg';
  return { ext, mime };
}

async function sendNsfwImage(msg, categoryKey) {
  const category = CATEGORIES[categoryKey];

  const tagSets = [
    `${category.tags} ${category.rating}`,
  ];

  let post = null;
  try {
    post = await fetchRandomImage(tagSets, { ratingLetters: category.ratingLetters });
  } catch (err) {
    console.error(`[nsfw] ${categoryKey} fetch error:`, err.message);
  }

  if (!post) {
    return msg.reply(
      `😿 Couldn't find any *${category.label}* images right now — the source may be down or rate-limiting on this connection. Try again in a minute.`
    );
  }

  const { ext, mime } = extAndMime(post.url);
  const response = await axios.get(post.url, {
    responseType: 'arraybuffer',
    timeout: 45000,
    maxContentLength: 20 * 1024 * 1024,
    headers: {
      'User-Agent': 'AniChanBot/1.0 (nsfw-commands)',
      Referer: 'https://danbooru.donmai.us/',
    },
  });

  const media = new MessageMedia(
    mime,
    Buffer.from(response.data).toString('base64'),
    `anichan_${categoryKey}_${post.id}.${ext}`
  );
  await msg.reply(media, undefined, { caption: `🔞 *${category.label}*` });
}

async function handleNsfwImage(msg, categoryKey) {
  const gate = await getNsfwGate(msg);
  if (!gate.ok) return msg.reply(gate.reply);

  const chatId = gate.chat.id._serialized;
  const now = Date.now();

  if (activeRequests.has(chatId)) {
    return msg.reply('⏳ Please wait for your current request to finish.');
  }

  const last = lastUse.get(chatId) || 0;
  if (now - last < COOLDOWN_MS) {
    const wait = Math.ceil((COOLDOWN_MS - (now - last)) / 1000);
    return msg.reply(`⏳ Slow down — try again in ${wait}s.`);
  }

  sweepLastUse(now);
  lastUse.set(chatId, now);
  activeRequests.add(chatId);

  try {
    await sendNsfwImage(msg, categoryKey);
  } catch (err) {
    console.error(`[nsfw] ${categoryKey} failed:`, err.message);
    return msg.reply(
      '❌ Download failed — the image source timed out on this connection. Try again in a moment.'
    ).catch(() => {});
  } finally {
    activeRequests.delete(chatId);
  }
}

// ─── Link dedup helpers ─────────────────────────────────────────────────────
// Returns the first `limit` links NOT already recorded in SentNsfwLink.
async function filterFreshLinks(links, limit = LINK_RESULTS_WANTED) {
  const fresh = [];
  for (const link of links) {
    if (fresh.length >= limit) break;
    try {
      const exists = await SentNsfwLink.findOne({ url: link.url }).select('_id').lean();
      if (exists) continue;
      fresh.push(link);
    } catch (err) {
      console.error('[nsfw] dedup lookup failed:', err.message);
      // DB hiccup: still allow the link rather than blocking the user entirely
      fresh.push(link);
    }
  }
  return fresh;
}

// Flags links as sent. Duplicate-key errors (same URL flagged twice in this
// run) are expected and ignored.
async function recordSentLinks(source, query, links) {
  const ops = links.map((l) =>
    SentNsfwLink.create({
      source,
      query,
      url: l.url,
      galleryId: l.galleryId || null,
      title: l.title || '',
    }).catch((err) => {
      if (err && err.code !== 11000) {
        console.error('[nsfw] failed to flag link:', err.message);
      }
    })
  );
  await Promise.all(ops);
}

// ─── E-Hentai search ────────────────────────────────────────────────────────
// Parses gallery links + titles out of the search results HTML. Requires the
// "nw=1" cookie or e-hentai serves a content-warning interstitial instead of
// results.
function parseEhentaiResults(html) {
  const results = [];
  const seen = new Set();

  // Primary: anchor wrapping the .glink title div, e.g.
  // <a href="https://e-hentai.org/g/123/abc/"> ... <div class="glink">Title</div>
  const glinkRe = /<a href="(https?:\/\/e-hentai\.org\/g\/(\d+)\/([0-9a-f]+)\/)"[^>]*>[\s\S]*?<div class="glink">([\s\S]*?)<\/div>/gi;
  let m;
  while ((m = glinkRe.exec(html)) !== null) {
    const url = m[1];
    if (seen.has(url)) continue;
    seen.add(url);
    const title = m[4].replace(/<[^>]+>/g, '').trim();
    results.push({ url, galleryId: m[2], title: title || `Gallery ${m[2]}` });
  }

  // Fallback: bare gallery anchors without a glink parse
  if (!results.length) {
    const bareRe = /https?:\/\/e-hentai\.org\/g\/(\d+)\/([0-9a-f]+)\//gi;
    while ((m = bareRe.exec(html)) !== null) {
      const url = `https://e-hentai.org/g/${m[1]}/${m[2]}/`;
      if (seen.has(url)) continue;
      seen.add(url);
      results.push({ url, galleryId: m[1], title: `Gallery ${m[1]}` });
    }
  }

  return results;
}

async function searchEhentai(query) {
  const results = [];
  for (let page = 0; page < LINK_MAX_PAGES && results.length < 30; page++) {
    const url =
      `https://e-hentai.org/?f_search=${encodeURIComponent(query).replace(/%20/g, '+')}` +
      (page > 0 ? `&page=${page}` : '');
    const res = await axios.get(url, {
      timeout: LINK_FETCH_TIMEOUT,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
        Cookie: 'nw=1',
      },
    });
    const pageResults = parseEhentaiResults(res.data);
    if (!pageResults.length) break;
    results.push(...pageResults);
  }
  // Dedupe across pages (already URL-deduped per page by the parser)
  const seen = new Set();
  return results.filter((r) => !seen.has(r.url) && seen.add(r.url));
}

// ─── nhentai search ─────────────────────────────────────────────────────────
// nhentai exposes a JSON API used by its own frontend. Each entry has id +
// title; the gallery URL is derived from the id.
async function searchNhentai(query) {
  const results = [];
  for (let page = 1; page <= LINK_MAX_PAGES && results.length < 30; page++) {
    const url = `https://nhentai.net/api/galleries/search?query=${encodeURIComponent(query)}&page=${page}`;
    const res = await axios.get(url, {
      timeout: LINK_FETCH_TIMEOUT,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
        Accept: 'application/json, text/plain, */*',
        Referer: 'https://nhentai.net/search/',
      },
    });
    const data = res.data;
    const entries = Array.isArray(data && data.result) ? data.result : [];
    if (!entries.length) break;
    for (const g of entries) {
      if (!g || g.id == null) continue;
      const title = (g.title && (g.title.pretty || g.title.english || g.title.japanese)) || '';
      results.push({
        url: `https://nhentai.net/g/${g.id}/`,
        galleryId: String(g.id),
        title: String(title).trim() || `Gallery ${g.id}`,
      });
    }
  }
  const seen = new Set();
  return results.filter((r) => !seen.has(r.url) && seen.add(r.url));
}

// Shared handler: run the site-specific search, walk pages until we have
// LINK_RESULTS_WANTED fresh links, flag them, reply. On any fetch failure,
// falls back to the plain search URL so the command still returns something.
async function handleGalleryLinks(msg, site, query) {
  let searchFn, fallbackUrl, label;

  if (site === 'ehentai') {
    searchFn = searchEhentai;
    label = 'E-Hentai';
    fallbackUrl = `https://e-hentai.org/?f_search=${encodeURIComponent(query).replace(/%20/g, '+')}`;
  } else {
    searchFn = searchNhentai;
    label = 'nhentai';
    fallbackUrl = `https://nhentai.net/search/?q=${encodeURIComponent(query)}`;
  }

  let allResults = [];
  let fetchFailed = false;
  try {
    allResults = await searchFn(query);
  } catch (err) {
    console.error(`[nsfw] ${site} search failed:`, err.message);
    fetchFailed = true;
  }

  if (!fetchFailed && allResults.length) {
    const fresh = await filterFreshLinks(allResults, LINK_RESULTS_WANTED);
    if (fresh.length) {
      await recordSentLinks(site, query, fresh);
      const lines = fresh.map((l, i) => `${i + 1}. ${l.title}\n${l.url}`);
      return msg.reply(
        `🔍 *${label}* — ${fresh.length} fresh result${fresh.length === 1 ? '' : 's'} for *${query}*:\n\n${lines.join('\n\n')}`
      );
    }
    // Search worked but every result was already sent before
    return msg.reply(
      `🔍 All top results for *${query}* on *${label}* have already been sent in previous searches. Try a different tag — new galleries will appear as fresh results.`
    );
  }

  // Fallback: site unreachable/blocked or no results parsed
  const reason = fetchFailed
    ? 'the site is unreachable or blocking this connection right now'
    : 'no galleries matched that search';
  return msg.reply(
    `🔍 Couldn't fetch live results for *${query}* (${reason}).\nDirect search link:\n${fallbackUrl}`
  );
}

module.exports = {
  async nsfw(client, msg, args) {
    const chat = await safeGetChat(msg).catch(() => null);
    if (!chat) return msg.reply('⚠️ WhatsApp connection hiccup — please try again in a moment.');
    if (!chat.isGroup) return msg.reply(`❌ \`${PREFIX}nsfw\` only works in groups.`);

    const senderId = msg.author || msg.from;
    let allowed = isOwner(senderId);
    if (!allowed) {
      try {
        allowed = await isAdmin(msg);
      } catch {
        allowed = false;
      }
    }
    if (!allowed) return msg.reply('❌ Admins only!');

    const sub = String(args[0] || '').toLowerCase();
    if (sub !== 'on' && sub !== 'off') {
      return msg.reply(`❌ Usage: \`${PREFIX}nsfw on\` or \`${PREFIX}nsfw off\``);
    }

    await Group.findOneAndUpdate(
      { id: chat.id._serialized },
      { $set: { nsfw: sub === 'on' } },
      { upsert: true, new: true }
    );

    if (sub === 'on') {
      return msg.reply(
        `🔞 NSFW is now *ON* in this group.\nAvailable: ${Object.keys(CATEGORIES)
          .map((k) => `\`${PREFIX}${k}\``)
          .join(', ')} — plus \`${PREFIX}ehentai\` and \`${PREFIX}nhentai\`.\nTurn it off anytime with \`${PREFIX}nsfw off\`.`
      );
    }
    return msg.reply('✅ NSFW is now *OFF* in this group.');
  },

  async milf(client, msg) { return handleNsfwImage(msg, 'milf'); },
  async ass(client, msg) { return handleNsfwImage(msg, 'ass'); },
  async hentai(client, msg) { return handleNsfwImage(msg, 'hentai'); },
  async oral(client, msg) { return handleNsfwImage(msg, 'oral'); },
  async paizuri(client, msg) { return handleNsfwImage(msg, 'paizuri'); },
  async oppai(client, msg) { return handleNsfwImage(msg, 'oppai'); },
  async ecchi(client, msg) { return handleNsfwImage(msg, 'ecchi'); },
  async ero(client, msg) { return handleNsfwImage(msg, 'ero'); },

  async ehentai(client, msg, args) {
    const gate = await getNsfwGate(msg);
    if (!gate.ok) return msg.reply(gate.reply);

    const tag = args.join(' ').trim();
    if (!tag) return msg.reply(`❌ Usage: \`${PREFIX}ehentai [tag]\``);
    return handleGalleryLinks(msg, 'ehentai', tag);
  },

  async nhentai(client, msg, args) {
    const gate = await getNsfwGate(msg);
    if (!gate.ok) return msg.reply(gate.reply);

    const query = args.join(' ').trim();
    if (!query) return msg.reply(`❌ Usage: \`${PREFIX}nhentai [code or tag]\``);

    // Direct gallery code: link it immediately and flag it so it's not
    // re-sent as a search result later. Explicit requests are always honored.
    if (/^\d{1,6}$/.test(query)) {
      const url = `https://nhentai.net/g/${query}/`;
      await recordSentLinks('nhentai', `gallery:${query}`, [
        { url, galleryId: query, title: `Gallery #${query}` },
      ]).catch(() => {});
      return msg.reply(`🔍 nhentai gallery *#${query}*:\n${url}`);
    }

    return handleGalleryLinks(msg, 'nhentai', query);
  },
};
