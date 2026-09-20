// commands/nsfw.js — NSFW image & link commands for AniChan Bot
// Gating: groups must enable with ".nsfw on" (admin only); DMs are owner-only.
// Images: Danbooru via shared utils/danbooru.js (rating-filtered, animated/video/comic excluded).
// Links: e-hentai / nhentai search URLs (no scraping, no API keys needed).

const axios = require('axios');
const { MessageMedia } = require('whatsapp-web.js');
const Group = require('../models/Group');
const { safeGetChat, isAdmin, isOwner } = require('../utils/helpers');
const { fetchRandomImage } = require('../utils/danbooru');

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
const LASTUSE_TTL_MS = 10 * 60 * 1000;

function sweepLastUse(now) {
  if (lastUse.size < LASTUSE_PRUNE_THRESHOLD) return;
  for (const [chatId, ts] of lastUse) {
    if (now - ts > LASTUSE_TTL_MS) lastUse.delete(chatId);
  }
}

async function getNsfwGate(msg) {
  const chat = await safeGetChat(msg).catch(() => null);
  if (!chat) {
    return { ok: false, reply: '⚠️ WhatsApp connection hiccup — please try again in a moment.' };
  }

  if (chat.isGroup) {
    const group = await Group.findOne({ id: chat.id._serialized }).catch(() => null);
    if (!group?.nsfw) {
      return {
        ok: false,
        reply: '❌ NSFW is disabled in this group.\nAdmin can enable it with *.nsfw on*',
      };
    }
    return { ok: true, chat };
  }

  const senderId = msg.author || msg.from;
  if (!isOwner(senderId)) {
    return { ok: false, reply: '❌ NSFW commands in DMs are owner-only.' };
  }
  return { ok: true, chat };
}

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
    const url = `https://e-hentai.org/?f_search=${encodeURIComponent(tag).replace(/%20/g, '+')}`;
    return msg.reply(`🔍 E-Hentai search for *${tag}*:\n${url}`);
  },

  async nhentai(client, msg, args) {
    const gate = await getNsfwGate(msg);
    if (!gate.ok) return msg.reply(gate.reply);

    const query = args.join(' ').trim();
    if (!query) return msg.reply(`❌ Usage: \`${PREFIX}nhentai [code or tag]\``);

    if (/^\d{1,6}$/.test(query)) {
      return msg.reply(`🔍 nhentai gallery *#${query}*:\nhttps://nhentai.net/g/${query}/`);
    }
    const url = `https://nhentai.net/search/?q=${encodeURIComponent(query)}`;
    return msg.reply(`🔍 nhentai search for *${query}*:\n${url}`);
  },
};