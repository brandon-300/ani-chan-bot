const { CardCatalogue, OwnedCard, Auction, TradeRequest, SaleRequest } = require('../models/Card');
const { checkAchievements, formatUnlockNotice } = require('../utils/achievements');
const { checkTitle, formatTitleUnlockNotice } = require('../utils/titles');
const { renderCard, fetchImageAsDataUri } = require('../utils/cardRenderer');
const { MessageMedia } = require('whatsapp-web.js');
const User = require('../models/User');
const Group = require('../models/Group');
const { tierEmoji, rollTier, formatNum, pick, mentionName, mentionTag, generateUniqueCode, safeGetChat, cardValue, tierAbove, TIER_DROP_RATES, addXP, XP_REWARDS, parseAmount, boldSans, doubleStruck, cleanDescription } = require('../utils/helpers');
const crypto = require('crypto');

// ─── Shared card media resolution — custom render, then raw image, then none ──
// Every single-card send point (sendCardDetail, sendOwnedCardInfo, .ci's
// catalogue-search path, dropCard) wants the same thing: the finished
// custom trading-card image if it can be produced, the original raw
// AniList image if not, or nothing at all (caller falls back to a
// text-only reply) if even that fails. This is that fallback chain,
// written once instead of copy-pasted at each call site.
//
// catalogue must be a CardCatalogue document (not an OwnedCard) — that's
// where imageUrl/description/render cache all live. Never throws.
async function getCardMedia(client, catalogue) {
  if (!catalogue?.imageUrl) return null;

  try {
    const result = await renderCard(client, catalogue);
    if (result.cached) {
      return await MessageMedia.fromUrl(result.url, { unsafeMime: true });
    }
    return new MessageMedia('image/png', result.buffer.toString('base64'), 'card.png');
  } catch (err) {
    console.error('getCardMedia: custom render failed, falling back to raw AniList image:', err.message);
  }

  try {
    return await MessageMedia.fromUrl(catalogue.imageUrl, { unsafeMime: true });
  } catch (err) {
    console.error('getCardMedia: raw AniList image fetch also failed:', err.message);
    return null;
  }
}

// Same idea as getCardMedia, but returns a data: URI instead of a
// MessageMedia — for embedding an already-rendered card INSIDE another
// Puppeteer page (the paginated collection grid inside .deck, below)
// rather than sending it directly. This is what keeps the grid page's own
// page.setContent() from ever touching the network: a cache-miss render
// already returns an in-memory buffer; a cache-hit only gives a Cloudinary
// URL, so that one case fetches it once via the same retry-safe helper the
// main renderer uses for AniList — never via a live <img src="url"> inside
// the grid page itself, which is exactly what made the old .cg (the
// earlier, raw-AniList-image grid command .deck now replaces) time out on
// a bad connection.
// Never throws — returns null on any failure so one bad card just gets
// skipped from the grid instead of taking the whole thing down.
async function getCardPngDataUri(client, catalogue) {
  if (!catalogue?.imageUrl) return null;
  try {
    const result = await renderCard(client, catalogue);
    if (result.cached) {
      return await fetchImageAsDataUri(result.url);
    }
    return `data:image/png;base64,${result.buffer.toString('base64')}`;
  } catch (err) {
    console.error('getCardPngDataUri: render failed, skipping this card:', err.message);
    return null;
  }
}

const GRID_CELL_W = 260;
const GRID_CELL_H = 347; // matches the card renderer's fixed 1080x1440 (3:4) ratio, so object-fit:cover never crops
const GRID_COLS = 3;
const GRID_PER_PAGE = 12; // 3 cols x 4 rows

// cells are { uri, index } — uri is already a finished, full trading-card
// PNG (from getCardPngDataUri), index is that card's position in .col/
// .card numbering. This just lays them out in a grid with a small badge
// showing that index, so a viewer can jump straight to `.card [index]`
// for a closer look. No other text/colors/escaping needed here at all;
// all of that already happened once, inside each card's own render.
//
// The index badge sits in the top-RIGHT corner of each cell, not top-left
// — every card's own render (utils/cardRenderer.js) already draws a small
// tier-letter badge in ITS top-left corner (the "logoBadge"), and an idx
// badge placed on top of that just hid it. Top-right is empty on every
// card's own design, so nothing gets covered.
//
// The grid backdrop is a fixed, hand-tuned CSS gradient (a few overlapping
// radial blobs + a scattering of tiny star dots) rather than a photo or
// texture file — same reasoning as everywhere else in this renderer: the
// grid page must never touch the network (see getCardPngDataUri's header
// comment above for why that mattered for the old .cg), and Chromium
// renders gradients/radial-gradients natively with zero extra cost, so
// there's no reason to reach for an actual image file here either.
function buildCollectionGridHtml(cells) {
  const cols = Math.min(GRID_COLS, cells.length);
  const cellsHtml = cells
    .map(({ uri, index }) => `<div class="cell"><span class="idx">#${index}</span><img src="${uri}"></div>`)
    .join('');
  return `<!DOCTYPE html>
<html>
<head>
<style>
  html, body {
    margin: 0; padding: 24px; box-sizing: border-box;
    background-color: #0a0714;
    background-image:
      radial-gradient(circle at 18% 12%, rgba(168,85,247,.38), transparent 52%),
      radial-gradient(circle at 82% 20%, rgba(56,110,255,.32), transparent 50%),
      radial-gradient(circle at 30% 92%, rgba(236,72,153,.24), transparent 55%),
      radial-gradient(circle at 88% 88%, rgba(99,60,220,.28), transparent 50%),
      radial-gradient(1.5px 1.5px at 12% 30%, rgba(255,255,255,.85), transparent 100%),
      radial-gradient(1.5px 1.5px at 40% 8%, rgba(255,255,255,.7), transparent 100%),
      radial-gradient(1.5px 1.5px at 65% 45%, rgba(255,255,255,.8), transparent 100%),
      radial-gradient(1.5px 1.5px at 90% 15%, rgba(255,255,255,.65), transparent 100%),
      radial-gradient(1.5px 1.5px at 25% 70%, rgba(255,255,255,.75), transparent 100%),
      radial-gradient(1.5px 1.5px at 78% 65%, rgba(255,255,255,.6), transparent 100%),
      radial-gradient(1.5px 1.5px at 55% 90%, rgba(255,255,255,.7), transparent 100%),
      linear-gradient(160deg, #1b1035 0%, #100c24 45%, #0a0713 100%);
    background-repeat: no-repeat;
    background-size: cover;
  }
  .grid { display: grid; grid-template-columns: repeat(${cols}, ${GRID_CELL_W}px); gap: 20px; justify-content: center; }
  .cell { position: relative; width: ${GRID_CELL_W}px; height: ${GRID_CELL_H}px; border-radius: 16px; overflow: hidden; box-shadow: 0 6px 16px rgba(0,0,0,.55); }
  .cell img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .idx { position: absolute; top: 8px; right: 8px; z-index: 2; background: rgba(0,0,0,.65); color: #fff; font-weight: 900; font-size: 22px; line-height: 1; padding: 5px 10px; border-radius: 8px; font-family: Arial, Helvetica, sans-serif; }
</style>
</head>
<body><div class="grid">${cellsHtml}</div></body>
</html>`;
}

async function getUserCards(userId) {
  const cards = await OwnedCard.find({ ownerId: userId });
  return cards.sort((a, b) => cardValue(a.tier) - cardValue(b.tier) || a.name.localeCompare(b.name));
}

async function getCardByIndex(userId, index) {
  const cards = await getUserCards(userId);
  return cards[index - 1] || null;
}

// ─── Shared single-card detail view — used by .card and .col <number> ─────
// Both commands used to build their own near-identical caption text
// independently, which is how they'd already drifted into slightly
// different wording. Unified here in the same visual language as
// .profile (economy.js): a doubleStruck box header + boldSans ꕥ-prefixed
// label lines, instead of the old plain "📖 *name*" + bare emoji lines.
//
// The description also now runs through cleanDescription() at DISPLAY
// time (not just when a card is first pulled from AniList in
// cardmanager.js) — that's what fixes the raw "[label](url)" markdown
// AniList sometimes embeds in a character's bio (e.g. links to other
// AniList character pages) showing up as literal bracket/paren text.
// Because this cleans whatever's already saved in Mongo on every view, it
// also fixes descriptions saved before this sanitizing existed, with no
// database migration needed.
function renderCardDetail(card, catalogue) {
  const line = (label, value) => `ꕥ ${boldSans(label)}: ${value}`;
  const description = catalogue?.description ? cleanDescription(catalogue.description) : '';

  const lines = [
    `╭━━━★彡 ${doubleStruck('CARD')} 彡★━━━╮`,
    '',
    line('Name', `${tierEmoji(card.tier)} ${card.name}`),
    line('Tier', card.tier),
    line('Series', card.series),
    line('Value', `${cardValue(card.tier).toLocaleString()} coins`),
    line('Code', card.code || 'N/A'),
    line('Times Traded', card.timesTraded),
    line('Obtained', new Date(card.obtainedAt).toLocaleDateString()),
  ];
  if (description) lines.push(line('About', description));

  return lines.join('\n');
}

// Sends the rendered detail above, with the card's image when the
// catalogue entry has one. Always a genuine quoted reply — msg.reply()
// supports media the same way it already does for GIFs in
// commands/interaction.js, so this no longer needs chat.sendMessage()
// (which sent a fresh, unquoted message instead of replying under the
// triggering .card/.col command, same bug already fixed elsewhere in the
// bot for other commands).
async function sendCardDetail(client, msg, card, catalogue) {
  const caption = renderCardDetail(card, catalogue);

  const media = await getCardMedia(client, catalogue);
  if (media) {
    try {
      return await msg.reply(media, undefined, { caption });
    } catch (err) {
      console.error('sendCardDetail: media send failed, falling back to text:', err.message);
      // fall through to text-only reply below
    }
  }
  return msg.reply(caption);
}

// Builds the same "Card Information" view .ci normally shows, but starting
// from a specific OwnedCard (i.e. a ".ci [code]" lookup) instead of a
// CardCatalogue name/tier search. Pulls description/imageUrl/added-date
// from the linked catalogue entry when there is one — OwnedCard itself
// only duplicates name/series/tier, not those fields.
async function sendOwnedCardInfo(client, msg, owned) {
  const catalogue = owned.catalogueId
    ? await CardCatalogue.findOne({ cardId: owned.catalogueId })
    : null;

  const name = catalogue?.name || owned.name;
  const series = catalogue?.series || owned.series;
  const tier = catalogue?.tier || owned.tier;
  const cardId = catalogue?.cardId || owned.catalogueId || owned.code;
  const description = catalogue?.description ? cleanDescription(catalogue.description) : '';

  const ownerShort = owned.ownerId ? owned.ownerId.split('@')[0] : 'Unknown';
  const firstOwnerShort = owned.firstOwner ? owned.firstOwner.split('@')[0] : ownerShort;

  const caption =
`📖 *Card Information*

${tierEmoji(tier)} *${name}*
📚 Series: ${series}
⭐ Tier: ${tier}
💰 Value: ${cardValue(tier).toLocaleString()} coins
🆔 Card ID: ${cardId}
🎫 Claim Code: ${owned.code}

👤 Owner: @${ownerShort}
🥇 First Owner: @${firstOwnerShort}
🔄 Times Traded: ${owned.timesTraded}
📅 Claimed: ${new Date(owned.obtainedAt).toLocaleDateString()}${description ? `\n📝 ${description}` : ''}`;

  const mentions = [...new Set([owned.ownerId, owned.firstOwner].filter(Boolean))];

  const media = await getCardMedia(client, catalogue);
  if (media) {
    try {
      return await msg.reply(media, undefined, { caption, mentions });
    } catch (err) {
      console.error('sendOwnedCardInfo: media send failed, falling back to text:', err.message);
      // fall through to text-only reply below
    }
  }
  return msg.reply(caption, undefined, { mentions });
}

// ─── Drop a Random Card in Group ─────────────────────────────────────────────
async function dropCard(chat, client) {
  const tier = rollTier();

  let card = null;

  const tiers = [tier, 'SSS', 'SS', 'S', 'A', 'B', 'C']
    .filter((v, i, a) => a.indexOf(v) === i);

  for (const currentTier of tiers) {
    const claimedIds = await OwnedCard.distinct('catalogueId');

    const available = await CardCatalogue.find({
      tier: currentTier,
      cardId: { $nin: claimedIds }
    });

    if (available.length) {
      card = available[Math.floor(Math.random() * available.length)];
      break;
    }
  }

  if (!card) {
    await chat.sendMessage('🎴 All cards have already been claimed!');
    return null;
  }

  const claimCode = crypto.randomBytes(3).toString('hex').toUpperCase();
  const groupId = chat.id._serialized;

  await Group.findOneAndUpdate(
    { id: groupId },
    {
      activeCardId: card.cardId,
      activeCardCode: claimCode,
      activeCardExpiresAt: new Date(Date.now() + 10 * 60 * 1000)
    },
    { upsert: true, new: true }
  );

  const caption = `🎴 *A card has appeared!*

${tierEmoji(card.tier)} *${card.name}*
📚 Series: ${card.series}
⭐ Tier: ${card.tier}

Type *.claim ${claimCode}* to claim it!`;

  // Wishlist notifications (Phase 9): anyone who wishlisted this card's name
  // gets pinged, case-insensitively.
  const wishers = await User.find({ wishlist: { $exists: true, $ne: [] } });
  const matchedIds = wishers
    .filter(u => u.wishlist.some(w => w.toLowerCase() === card.name.toLowerCase()))
    .map(u => u.id);

  const wishlistNote = matchedIds.length
    ? `\n\n🔔 ${matchedIds.map(id => `@${id.split('@')[0]}`).join(' ')} — a card on your wishlist appeared!`
    : '';
  const fullCaption = caption + wishlistNote;

  const media = client ? await getCardMedia(client, card) : null;
  if (media) {
    try {
      await chat.sendMessage(media, { caption: fullCaption, mentions: matchedIds });
      return card;
    } catch (err) {
      console.error('dropCard: media send failed, falling back to text:', err.message);
      // fall through to text-only drop below
    }
  }

  await chat.sendMessage(fullCaption, { mentions: matchedIds });
  return card;
}

// ─── Track active drop intervals so toggling never leaks or duplicates them ──
const cardIntervals = new Map(); // chatId -> intervalId

function startDropInterval(chat, client) {
  const chatId = chat.id._serialized;
  if (cardIntervals.has(chatId)) clearInterval(cardIntervals.get(chatId));
  const intervalId = setInterval(() => dropCard(chat, client), 5 * 60 * 1000);
  cardIntervals.set(chatId, intervalId);
}

function stopDropInterval(chatId) {
  if (cardIntervals.has(chatId)) {
    clearInterval(cardIntervals.get(chatId));
    cardIntervals.delete(chatId);
  }
}

// Called once from index.js on bot startup to resume drops after any restart
async function _initCardDrops(client) {
  const enabledGroups = await Group.find({ cardsEnabled: true });
  for (const group of enabledGroups) {
    try {
      const chat = await client.getChatById(group.id);
      startDropInterval(chat, client);
    } catch (e) {
      // Group may no longer exist / bot may have been removed — skip it
    }
  }
  if (enabledGroups.length) {
    console.log(`🎴 Resumed card drops in ${enabledGroups.length} group(s)`);
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────────
module.exports = {
  _initCardDrops,
  // .cards on/off
  async cards(client, msg, args) {
    const chat = await safeGetChat(msg).catch(err => { console.error("getChat failed:", err.message); msg.reply("⚠️ WhatsApp connection hiccup — please try again in a moment."); return null; });
    if (!chat) return;
    if (!chat.isGroup) return msg.reply('❌ Group only.');
    const sub = args[0]?.toLowerCase();
    if (!sub) {
      const group = await Group.findOne({ id: chat.id._serialized });
      return msg.reply(`🎴 Cards are currently *${group?.cardsEnabled ? 'ON' : 'OFF'}*`);
    }
    const group = await Group.findOneAndUpdate(
      { id: chat.id._serialized },
      { cardsEnabled: sub === 'on' },
      { upsert: true, new: true }
    );
    msg.reply(`🎴 Cards are now *${group.cardsEnabled ? 'ON' : 'OFF'}*`);

    if (group.cardsEnabled) {
      startDropInterval(chat, client);
    } else {
      stopDropInterval(chat.id._serialized);
    }
  },

  // .card [index] — quick view of a single card from your collection by
  // position (positions match the numbering shown in .col).
  async card(client, msg, args) {
    const contact = await msg.getContact();
    const index = parseInt(args[0]);
    if (!index || index < 1) {
      return msg.reply('❌ Usage: .card [index]\n\nUse *.col* to see your collection with numbered positions.');
    }

    const card = await getCardByIndex(contact.id._serialized, index);
    if (!card) {
      const total = (await getUserCards(contact.id._serialized)).length;
      return msg.reply(`❌ No card at position ${index}. You have ${total} card(s) — try *.col* to see them all.`);
    }

    const catalogue = card.catalogueId
      ? await CardCatalogue.findOne({ cardId: card.catalogueId })
      : null;

    return sendCardDetail(client, msg, card, catalogue);
  },

  // .ci [name] [tier] — card info from catalogue.
  // .ci [code] — same command, but looks up one specific claimed card by
  // its 6-character claim code instead (the same code shown by .card/.col
  // and used with .claim). Codes only exist on OwnedCard once a card's
  // been claimed — the master catalogue entries themselves don't have
  // one — so a code hit shows that exact claimed instance (its real owner,
  // times traded, etc.) rather than the generic catalogue listing.
  //
  // Code detection only fires for a single argument matching the exact
  // 6-char code alphabet (generateUniqueCode() in utils/helpers.js:
  // A-Z minus I/O, 2-9 minus 0/1), and only takes effect if that code
  // actually exists — so a genuine one-word name search (e.g. ".ci Sakura")
  // still works normally in the near-impossible case it happens to overlap
  // the code pattern with no real card at that code.
  async ci(client, msg, args) {
    if (!args.length) return msg.reply('❌ Usage: .ci [name] [tier]  —or—  .ci [code]');

    if (args.length === 1 && /^[A-HJ-NP-Z2-9]{6}$/i.test(args[0])) {
      const owned = await OwnedCard.findOne({ code: args[0].toUpperCase() });
      if (owned) return sendOwnedCardInfo(client, msg, owned);
      // No claimed card at that code — fall through and treat the same
      // text as a name search below instead of giving up.
    }

    const tier = args[args.length - 1]?.toUpperCase();
    const name = args.slice(0, -1).join(' ') || args.join(' ');

    const query = tier && ['C','B','A','S','SS','SSS'].includes(tier) && args.length > 1
      ? { name: new RegExp(name, 'i'), tier }
      : { name: new RegExp(args.join(' '), 'i') };

    const card = await CardCatalogue.findOne(query);
    if (!card) return msg.reply('❌ Card not found.');

    const cardId = card.cardId || card._id;
    const owned = card.cardId
      ? await OwnedCard.findOne({ catalogueId: card.cardId })
      : null;

    const ownershipLines = owned
      ? `👤 Owner: @${owned.ownerId.split('@')[0]}\n🥇 First Owner: @${owned.firstOwner ? owned.firstOwner.split('@')[0] : owned.ownerId.split('@')[0]}\n🔄 Times Traded: ${owned.timesTraded}\n📅 Claimed: ${new Date(owned.obtainedAt).toLocaleDateString()}`
      : `💎 Status: Available`;

    const caption =
`📖 *Card Information*

${tierEmoji(card.tier)} *${card.name}*
📚 Series: ${card.series}
⭐ Tier: ${card.tier}
💰 Value: ${cardValue(card.tier).toLocaleString()} coins
🆔 Card ID: ${cardId}

${ownershipLines}
📅 Added: ${card.createdAt ? new Date(card.createdAt).toLocaleDateString() : 'Unknown'}${card.description ? `\n📝 ${cleanDescription(card.description)}` : ''}

Use *.claim* when this card drops!`;

    const mentions = owned
      ? [...new Set([owned.ownerId, owned.firstOwner].filter(Boolean))]
      : [];

    const media = await getCardMedia(client, card);
    if (media) {
      try {
        return await msg.reply(media, undefined, { caption, mentions });
      } catch (err) {
        console.error('.ci: media send failed, falling back to text:', err.message);
        // fall through to text-only reply below
      }
    }
    msg.reply(caption, undefined, { mentions });
  },

  // .cardinfo alias
  async cardinfo(client, msg, args) {
    return module.exports.ci(client, msg, args);
  },

  // .si [name] — series info
  async si(client, msg, args) {
    const name = args.join(' ');
if (!name) return msg.reply('❌ Usage: .si [series]');
    const cards = await CardCatalogue.find({ series: new RegExp(name, 'i') }).sort({ tier: -1 });
    if (!cards.length) return msg.reply('❌ Series not found.');

    let text = `📚 *${cards[0].series}* (${cards.length} cards)\n\n`;
    cards.forEach(c => { text += `${tierEmoji(c.tier)} ${c.name} — ${c.tier}\n`; });
    msg.reply(text);
  },

  // .ss [series] — owned cards from that series
  async ss(client, msg, args) {
    const contact = await msg.getContact();
    const series = args.join(' ');
    if (!series) return msg.reply('❌ Usage: .ss [series]');

const cards = await OwnedCard.find({
  ownerId: contact.id._serialized,
  series: new RegExp(series, 'i')
});
    if (!cards.length) return msg.reply('❌ You have no cards from that series.');

    let text = `📚 *Your ${series} Cards* (${cards.length})\n\n`;
    cards.forEach((c, i) => { text += `${i + 1}. ${tierEmoji(c.tier)} ${c.name} — ${c.tier}\n`; });
    msg.reply(text);
  },

  // .slb [series] — series leaderboard (who has most)
  async slb(client, msg, args) {
    const series = args.join(' ');
    if (!series) return msg.reply('❌ Usage: .slb [series]');

    const results = await OwnedCard.aggregate([
      { $match: { series: new RegExp(series, 'i') } },
      { $group: { _id: '$ownerId', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);

    if (!results.length) return msg.reply('❌ No data found.');
    let text = `🏆 *${series} Leaderboard*\n\n`;
    results.forEach((r, i) => { text += `${i + 1}. @${r._id.split('@')[0]} — ${r.count} cards\n`; });
    msg.reply(text, undefined, { mentions: results.map(r => r._id) });
  },

  // .clb — card leaderboard (most total cards)
  async clb(client, msg, args) {
    const results = await OwnedCard.aggregate([
      { $group: { _id: '$ownerId', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);
    if (!results.length) return msg.reply('❌ No data found.');
    let text = `🏆 *Collection Size Leaderboard*\n\n`;
    results.forEach((r, i) => { text += `${i + 1}. @${r._id.split('@')[0]} — ${r.count} cards\n`; });
    msg.reply(text, undefined, { mentions: results.map(r => r._id) });
  },

  // .vlb — leaderboard by total collection value (Phase 7)
  async vlb(client, msg, args) {
    const cards = await OwnedCard.find();
    const totals = {};
    for (const c of cards) {
      totals[c.ownerId] = (totals[c.ownerId] || 0) + cardValue(c.tier);
    }
    const ranked = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (!ranked.length) return msg.reply('❌ No data found.');

    let text = `🏆 *Collection Value Leaderboard*\n\n`;
    ranked.forEach(([id, value], i) => {
      text += `${i + 1}. @${id.split('@')[0]} — 💰 ${value.toLocaleString()} coins\n`;
    });
    msg.reply(text, undefined, { mentions: ranked.map(([id]) => id) });
  },

  // .tlb — leaderboard by the single highest-tier card each person owns (Phase 7)
  async tlb(client, msg, args) {
    const cards = await OwnedCard.find();
    const best = {};
    for (const c of cards) {
      const v = cardValue(c.tier);
      if (!best[c.ownerId] || v > best[c.ownerId].value) {
        best[c.ownerId] = { value: v, tier: c.tier, name: c.name };
      }
    }
    const ranked = Object.entries(best).sort((a, b) => b[1].value - a[1].value).slice(0, 10);
    if (!ranked.length) return msg.reply('❌ No data found.');

    let text = `🏆 *Highest Tier Leaderboard*\n\n`;
    ranked.forEach(([id, info], i) => {
      text += `${i + 1}. @${id.split('@')[0]} — ${tierEmoji(info.tier)} ${info.tier} (${info.name})\n`;
    });
    msg.reply(text, undefined, { mentions: ranked.map(([id]) => id) });
  },

  // .sslb — leaderboard by number of SS/SSS cards owned (Phase 7)
  async sslb(client, msg, args) {
    const cards = await OwnedCard.find({ tier: { $in: ['SS', 'SSS'] } });
    const counts = {};
    for (const c of cards) {
      counts[c.ownerId] = (counts[c.ownerId] || 0) + 1;
    }
    const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (!ranked.length) return msg.reply('❌ No one owns an SS or SSS card yet.');

    let text = `🏆 *Most SS+ Cards*\n\n`;
    ranked.forEach(([id, count], i) => {
      text += `${i + 1}. @${id.split('@')[0]} — 🟠 ${count} card(s)\n`;
    });
    msg.reply(text, undefined, { mentions: ranked.map(([id]) => id) });
  },

  // .mclb — leaderboard by each person's best-completed series (Phase 7)
  async mclb(client, msg, args) {
    const catalogue = await CardCatalogue.find();
    const seriesTotals = {};
    for (const c of catalogue) {
      seriesTotals[c.series] = (seriesTotals[c.series] || 0) + 1;
    }

    const owned = await OwnedCard.find();
    const ownedBySeries = {};
    for (const c of owned) {
      if (!ownedBySeries[c.ownerId]) ownedBySeries[c.ownerId] = {};
      ownedBySeries[c.ownerId][c.series] = (ownedBySeries[c.ownerId][c.series] || 0) + 1;
    }

    const best = {};
    for (const [ownerId, seriesCounts] of Object.entries(ownedBySeries)) {
      for (const [series, count] of Object.entries(seriesCounts)) {
        const total = seriesTotals[series];
        if (!total) continue;
        const pct = count / total;
        if (!best[ownerId] || pct > best[ownerId].pct) {
          best[ownerId] = { pct, series, count, total };
        }
      }
    }

    const ranked = Object.entries(best).sort((a, b) => b[1].pct - a[1].pct).slice(0, 10);
    if (!ranked.length) return msg.reply('❌ No data found.');

    let text = `🏆 *Most Complete Series*\n\n`;
    ranked.forEach(([id, info], i) => {
      text += `${i + 1}. @${id.split('@')[0]} — ${info.series} (${info.count}/${info.total}, ${Math.round(info.pct * 100)}%)\n`;
    });
    msg.reply(text, undefined, { mentions: ranked.map(([id]) => id) });
  },

  // .deck [page] — visual grid image of your whole card collection,
  // rendered with the same finished, professionally-styled card art every
  // other card view uses (renderCard()/getCardPngDataUri, utils/
  // cardRenderer.js) — never raw AniList images. This is the direct
  // replacement for the old .cg (which rendered a similar grid, but from
  // raw AniList image URLs with a plain tier-colored fallback tile) AND
  // for the old .deck (a separate, curatable 5-card "battle deck" with
  // .deck add/remove/clear subcommands). That battle-deck concept is gone
  // completely: there is no more way to add/remove/clear cards into a
  // deck, no more per-user deck array, and no more .vs battle command that
  // read from one. .deck is now purely a paginated gallery of every card
  // you own, full stop.
  //
  // 12 cards per page (3 cols x 4 rows). Rendered sequentially, not in
  // parallel — this phone only has so much RAM/CPU for Chromium, and a
  // slow render on a bad connection should just be slow, not compound
  // into several timing out together. First-ever view of an unrendered
  // card is the slow part (Puppeteer + hair-color extraction + Cloudinary
  // upload, inside renderCard()); every view after that is a fast
  // Cloudinary URL fetch, same caching every other card view already gets.
  async deck(client, msg, args) {
    if (!client.pupBrowser) {
      return msg.reply('❌ Card grid needs the WhatsApp browser session, which isn\'t ready yet — try again in a moment.');
    }

    const contact = await msg.getContact();
    const userId = contact.id._serialized;
    const cards = await getUserCards(userId); // already sorted: tier asc (lowest first), then name
    if (!cards.length) return msg.reply('❌ You have no cards yet. Wait for one to drop and use *.claim*!');

    const totalPages = Math.max(1, Math.ceil(cards.length / GRID_PER_PAGE));
    let page = parseInt(args[0]) || 1;
    if (page < 1) page = 1;
    if (page > totalPages) page = totalPages;

    const startIdx = (page - 1) * GRID_PER_PAGE;
    const pageCards = cards.slice(startIdx, startIdx + GRID_PER_PAGE);

    const catalogueIds = [...new Set(pageCards.map(c => c.catalogueId).filter(Boolean))];
    const catalogues = catalogueIds.length
      ? await CardCatalogue.find({ cardId: { $in: catalogueIds } })
      : [];
    const catalogueById = new Map(catalogues.map(c => [c.cardId, c]));

    msg.reply(`🖼️ Rendering your card grid (page ${page}/${totalPages})...`);

    // cells only ever holds successes — a missing catalogue link or a
    // failed render just drops that one card from the grid (counted in
    // renderFailures for the caption) rather than breaking the page.
    const cells = [];
    let renderFailures = 0;
    for (let i = 0; i < pageCards.length; i++) {
      const c = pageCards[i];
      const catalogue = c.catalogueId ? catalogueById.get(c.catalogueId) : null;
      if (!catalogue) { renderFailures++; continue; }
      const uri = await getCardPngDataUri(client, catalogue);
      if (uri) {
        cells.push({ uri, index: startIdx + i + 1 });
      } else {
        renderFailures++;
      }
    }

    if (!cells.length) {
      return msg.reply('❌ Card grid render failed for every card on this page (likely a network timeout loading card art). Try again, or use *.col* for a text list in the meantime.');
    }

    try {
      const cols = Math.min(GRID_COLS, cells.length);
      const rows = Math.ceil(cells.length / cols);
      const pad = 24, gap = 20;
      const width = cols * GRID_CELL_W + (cols - 1) * gap + pad * 2;
      const height = rows * GRID_CELL_H + (rows - 1) * gap + pad * 2;

      const gridPage = await client.pupBrowser.newPage();
      try {
        await gridPage.setViewport({ width, height, deviceScaleFactor: 1 });
        await gridPage.setContent(buildCollectionGridHtml(cells), { waitUntil: 'load', timeout: 15000 });
        const buffer = await gridPage.screenshot({ type: 'png' });
        const media = new MessageMedia('image/png', buffer.toString('base64'), 'deck.png');

        const statusParts = [`${cells.length}/${pageCards.length} rendered`];
        if (renderFailures) statusParts.push(`${renderFailures} failed (missing art or a render/network error)`);
        const caption = `🎴 *Your Cards — Page ${page}/${totalPages}*\n${statusParts.join(' • ')}\n\nUse *.deck ${page < totalPages ? page + 1 : 1}* for the next page, or *.card [index]* to view one card in detail.`;

        return msg.reply(media, undefined, { caption });
      } finally {
        await gridPage.close().catch(() => {});
      }
    } catch (err) {
      console.error('.deck: grid render failed:', err.message);
      return msg.reply('❌ Card grid render failed (likely a network timeout loading card art). Try again, or use *.col* for a text list in the meantime.');
    }
  },

  // .col — view your collection
  async col(client, msg, args) {
    const contact = await msg.getContact();
    console.log(`[col] checking userId="${contact.id._serialized}"`);
    const cards = await getUserCards(contact.id._serialized);

    if (!cards.length) return msg.reply('❌ Your collection is empty.');

    const arg = args[0]?.trim();

    // .col page <n> — explicit pagination (kept separate from .col <n>,
    // which drills into a specific card, to avoid ambiguity)
    if (arg === 'page') {
      const perPage = 10;
      const page = parseInt(args[1]) > 0 ? parseInt(args[1]) : 1;
      const start = (page - 1) * perPage;
      const slice = cards.slice(start, start + perPage);
      const totalPages = Math.ceil(cards.length / perPage);

      if (!slice.length) return msg.reply(`❌ No cards on page ${page}. You have ${totalPages} page(s) total.`);

      let text = `🗃️ *Your Collection* [Page ${page}/${totalPages}] (${cards.length} total)\n\n`;
      slice.forEach((c, i) => {
        text += `${start + i + 1}. ${tierEmoji(c.tier)} *${c.name}* — ${c.tier}\n   📚 ${c.series}\n\n`;
      });
      text += `Use *.col <number>* to view a card's full details.`;
      if (totalPages > 1) text += `\nUse *.col page <n>* to see more (e.g. .col page 2).`;
      return msg.reply(text);
    }

    // .col <number> — drill into a specific card's full detail
    if (arg && /^\d+$/.test(arg)) {
      const index = parseInt(arg);
      const card = cards[index - 1];
      if (!card) return msg.reply(`❌ No card at position ${index}. You have ${cards.length} card(s) — try *.col* to see them all.`);

      const catalogue = card.catalogueId
        ? await CardCatalogue.findOne({ cardId: card.catalogueId })
        : null;

      return sendCardDetail(client, msg, card, catalogue);
    }

    // .col (no args) — page 1 of the rich list
    const perPage = 10;
    const slice = cards.slice(0, perPage);
    const totalPages = Math.ceil(cards.length / perPage);

    let text = `🗃️ *Your Collection* [Page 1/${totalPages}] (${cards.length} total)\n\n`;
    slice.forEach((c, i) => {
      text += `${i + 1}. ${tierEmoji(c.tier)} *${c.name}* — ${c.tier}\n   📚 ${c.series}\n\n`;
    });
    text += `Use *.col <number>* to view a card's full details.`;
    if (totalPages > 1) text += `\nUse *.col page <n>* to see more (e.g. .col page 2).`;

    msg.reply(text);
  },

  // .cardshop — combined shop listing: (1) cards other players have put up
  // for sale via .sellc, real prices they set, real sellers; and (2)
  // unclaimed catalogue cards, buyable directly at a fixed price for their
  // tier. Both paginate together, 10 per page, listings first. Buying a
  // player listing still goes through .claim <code> (unchanged). Buying a
  // catalogue card goes through the new .buyc <code> below — deliberately
  // NOT .claim, see the comment on .buyc for why.
  async cardshop(client, msg, args) {
    const perPage = 10;
    const page = args[0] === 'page' && parseInt(args[1]) > 0 ? parseInt(args[1]) : 1;

    const forSale = await OwnedCard.find({ isForSale: true }).sort({ price: 1 });
    const claimedIds = await OwnedCard.distinct('catalogueId');
    const catalogueAvailable = await CardCatalogue.find({ cardId: { $nin: claimedIds } }).sort({ tier: 1, name: 1 });

    const entries = [
      ...forSale.map(card => ({ kind: 'listing', card })),
      ...catalogueAvailable.map(card => ({ kind: 'catalogue', card })),
    ];

    if (!entries.length) {
      return msg.reply('🛒 The card shop is currently empty.');
    }

    const totalPages = Math.ceil(entries.length / perPage);
    const start = (page - 1) * perPage;
    const slice = entries.slice(start, start + perPage);

    if (!slice.length) return msg.reply(`❌ No listings on page ${page}. You have ${totalPages} page(s) total.`);

    let text = `🛒 *Card Shop* [Page ${page}/${totalPages}] (${entries.length} total)\n\n`;
    slice.forEach(({ kind, card }) => {
      if (kind === 'listing') {
        text += `${tierEmoji(card.tier)} *${card.name}* [${card.tier}] — 💰 ${formatNum(card.price)} coins\n🆔 ${card.code || 'pending'} • Seller: @${card.ownerId.split('@')[0]}\nUse *.claim ${card.code}* to buy!\n\n`;
      } else {
        text += `${tierEmoji(card.tier)} *${card.name}* [${card.tier}] — 💰 ${formatNum(cardValue(card.tier))} coins (shop stock)\n🆔 ${card.cardId}\nUse *.buyc ${card.cardId}* to buy!\n\n`;
      }
    });
    if (totalPages > 1) text += `Use *.cardshop page <n>* to see more (e.g. .cardshop page 2).`;

    const mentions = forSale.map(c => c.ownerId).filter(Boolean);
    msg.reply(text, undefined, { mentions });
  },

  // .buyc [code] — buy an unclaimed catalogue card directly (the "shop
  // stock" half of .cardshop) at its fixed tier price.
  //
  // Kept entirely separate from .claim on purpose: .claim's drop-claim
  // branch treats ANY known catalogue cardId as claimable for FREE the
  // moment it matches CardCatalogue — that branch doesn't actually check
  // that a drop is currently active for that specific code, only that
  // *some* Group record exists for the chat. Routing a paid purchase
  // through that path would either let people get catalogue cards for
  // free (if it hit that branch first) or require reworking claim
  // payment logic that's already had one real bug (see the BUGFIX note
  // above .claim's shop-buy branch). Flagging this rather than quietly
  // touching it — worth fixing as its own task.
  async buyc(client, msg, args) {
    const code = args[0]?.trim().toUpperCase();
    if (!code) return msg.reply('❌ Usage: .buyc [code]\n\nUse *.cardshop* to see catalogue cards available to buy.');

    const catalogue = await CardCatalogue.findOne({ cardId: code });
    if (!catalogue) return msg.reply('❌ No catalogue card with that code — check *.cardshop* for what\'s available.');

    const alreadyClaimed = await OwnedCard.findOne({ catalogueId: catalogue.cardId });
    if (alreadyClaimed) {
      return msg.reply('❌ That card has already been claimed — check *.cardshop* for what\'s still available, or *.claim* if someone has it listed for sale.');
    }

    const contact = await msg.getContact();
    const user = await User.findOrCreate(contact.id._serialized, contact.pushname);
    const price = cardValue(catalogue.tier);

    if (user.bank < price) {
      return msg.reply(`❌ Not enough in your bank. Need 💰 ${formatNum(price)}, you have ${formatNum(user.bank)}. Try *.deposit* first.`);
    }

    user.bank -= price;
    await user.save();

    const owned = await OwnedCard.create({
      ownerId: contact.id._serialized,
      catalogueId: catalogue.cardId,
      code: await generateUniqueCode(OwnedCard),
      name: catalogue.name,
      series: catalogue.series,
      tier: catalogue.tier,
      firstOwner: contact.id._serialized,
    });

    const xpResult = await addXP(contact.id._serialized, XP_REWARDS.shopBuy);
    const unlocked = await checkAchievements(contact.id._serialized);
    const newTitle = await checkTitle(contact.id._serialized);
    const xpLine = `\n⭐ +${XP_REWARDS.shopBuy} XP${xpResult.levelUp ? ` — 🎉 Level up! You're now level ${xpResult.level}!` : ''}`;
    msg.reply(`✅ You bought *${owned.name}* [${owned.tier}] for 💰 ${formatNum(price)}!` + xpLine + formatUnlockNotice(unlocked) + formatTitleUnlockNotice(newTitle));
  },

  // .sellc [index] [price]
  async sellc(client, msg, args) {
    const contact = await msg.getContact();
    const index = parseInt(args[0]);
    const price = parseAmount(args[1]);
    if (!index || !price || price < 1) return msg.reply('❌ Usage: .sellc [index] [price]\n\nPrice supports shorthand: 5k, 1.2m, etc.');

    const card = await getCardByIndex(contact.id._serialized, index);
    if (!card) return msg.reply('❌ Card not found.');
    if (card.isStaked) return msg.reply('❌ This card is staked as loan collateral — repay your loan first (.loan status).');

    card.isForSale = true;
    card.price = price;
    await card.save();
    msg.reply(`✅ *${card.name}* listed for 💰 ${price} coins!`);
  },

  // .rc [index] — remove card from sale
  async rc(client, msg, args) {
    const contact = await msg.getContact();
    const index = parseInt(args[0]);
    const card = await getCardByIndex(contact.id._serialized, index);
    if (!card) return msg.reply('❌ Card not found.');

    card.isForSale = false;
    card.price = 0;
    await card.save();
    msg.reply(`✅ *${card.name}* removed from shop.`);
  },

  // .claim [id] — claim a dropped card or buy from shop
  async claim(client, msg, args) {
    const chat = await safeGetChat(msg).catch(err => { console.error("getChat failed:", err.message); msg.reply("⚠️ WhatsApp connection hiccup — please try again in a moment."); return null; });
    if (!chat) return;
    const contact = await msg.getContact();
    const id = args[0]?.trim();
    if (!id) return msg.reply('❌ Usage: .claim [code]');

    const user = await User.findOrCreate(contact.id._serialized, contact.pushname);

    // Check if it's a shop card
    const shopCard = await OwnedCard.findOne({ code: id.toUpperCase(), isForSale: true }).catch(() => null);
    if (shopCard) {
      // BUGFIX (Aug 2026): this branch used to debit the buyer's coins and
      // reassign ownerId to the buyer WITHOUT ever crediting the seller —
      // shopCard.ownerId was overwritten before anything read the seller's
      // id, so the seller lost their card and got nothing for it. Captured
      // here before it's overwritten below, and credited at the end.
      const sellerId = shopCard.ownerId;
      const price = shopCard.price;

      if (sellerId === contact.id._serialized) {
        return msg.reply('❌ You can\'t buy your own listed card — remove it with *.rc* instead.');
      }
      // Payment now comes from the bank, not the wallet — same policy as
      // .loan (deposits go to bank) and .sc/.acceptsale below, so every
      // coin transfer in the card economy moves through one consistent
      // account instead of splitting unpredictably between the two.
      if (user.bank < price) {
        return msg.reply(`❌ Not enough in your bank. Need 💰 ${formatNum(price)}, you have ${formatNum(user.bank)}. Try *.deposit* first.`);
      }

      user.bank -= price;
      shopCard.ownerId = contact.id._serialized;
      shopCard.isForSale = false;
      shopCard.price = 0;
      shopCard.timesTraded += 1;
      await shopCard.save();
      await user.save();
      if (sellerId) {
        await User.updateOne({ id: sellerId }, { $inc: { bank: price } }, { upsert: false })
          .catch(err => console.error('claim: seller payout failed:', err.message));
      }
      const xpResult = await addXP(contact.id._serialized, XP_REWARDS.shopBuy);
      const unlocked = await checkAchievements(contact.id._serialized);
      const newTitle = await checkTitle(contact.id._serialized);
      const xpLine = `\n⭐ +${XP_REWARDS.shopBuy} XP${xpResult.levelUp ? ` — 🎉 Level up! You're now level ${xpResult.level}!` : ''}`;
      return msg.reply(`✅ You bought *${shopCard.name}* [${shopCard.tier}] for 💰 ${formatNum(price)}!` + xpLine + formatUnlockNotice(unlocked) + formatTitleUnlockNotice(newTitle));
    }

// Drop claim
const group = await Group.findOne({ id: chat.id._serialized });
let catalogue = null;

if (/^[A-Z0-9]{6}$/i.test(id)) {
  catalogue = await CardCatalogue.findOne({
    cardId: id.toUpperCase()
  }).catch(() => null);
}

if (
  group?.activeCardCode &&
  id.toUpperCase() === group.activeCardCode
) {
  catalogue = await CardCatalogue.findOne({
    cardId: group.activeCardId
  }).catch(() => null);
}

    if (!group) {
      return msg.reply('❌ This card has already been claimed or the claim code expired.');
    }

    if (!catalogue) {
      return msg.reply('❌ Invalid or expired claim code.');
    }

const existing = await OwnedCard.findOne({
  ownerId: contact.id._serialized,
  catalogueId: catalogue.cardId
});

if (existing)
  return msg.reply('❌ You already claimed this card!');

    const owned = await OwnedCard.create({
      ownerId: contact.id._serialized,
      catalogueId: catalogue.cardId,
      code: await generateUniqueCode(OwnedCard),
      name: catalogue.name,
      series: catalogue.series,
      tier: catalogue.tier,
      firstOwner: contact.id._serialized,
    });

    await Group.findOneAndUpdate(
      { id: chat.id._serialized },
      { $unset: { activeCardId: '', activeCardCode: '', activeCardExpiresAt: '' } }
    );

    const unlocked = await checkAchievements(contact.id._serialized);
    const xpResult = await addXP(contact.id._serialized, XP_REWARDS.claim);
    const newTitle = await checkTitle(contact.id._serialized);
    const xpLine = `\n⭐ +${XP_REWARDS.claim} XP${xpResult.levelUp ? ` — 🎉 Level up! You're now level ${xpResult.level}!` : ''}`;
    msg.reply(`✅ *${contact.pushname}* claimed ${tierEmoji(catalogue.tier)} *${catalogue.name}* [${catalogue.tier}]!` + xpLine + formatUnlockNotice(unlocked) + formatTitleUnlockNotice(newTitle));
  },

  // .sc [@user] [index] [price] — propose selling a card to a user.
  // BUGFIX (Aug 2026): this used to transfer the card and move coins
  // immediately, with zero consent from the buyer — no way to decline, and
  // it happened even if they hadn't agreed to anything. It now mirrors
  // .tc's propose-then-accept pattern exactly: this just creates a pending
  // SaleRequest (models/Card.js); nothing changes hands until the buyer
  // runs .acceptsale (or it's cancelled with .declinesale / expires after
  // 10 min, same window .tc uses).
  async sc(client, msg, args) {
    const contact = await msg.getContact();
    const mentioned = await msg.getMentions();
    if (!mentioned.length) return msg.reply('❌ Usage: .sc [@user] [index] [price]\n\nPrice supports shorthand: 5k, 1.2m, etc.');

    const buyer = mentioned[0];
    if (buyer.id._serialized === contact.id._serialized) {
      return msg.reply("❌ You can't sell a card to yourself.");
    }

    const index = parseInt(args[1]);
    const price = parseAmount(args[2]);
    if (!index || !price) return msg.reply('❌ Usage: .sc [@user] [index] [price]\n\nPrice supports shorthand: 5k, 1.2m, etc.');

    const card = await getCardByIndex(contact.id._serialized, index);
    if (!card) return msg.reply('❌ Card not found.');
    if (card.isStaked) return msg.reply('❌ This card is staked as loan collateral — repay your loan first (.loan status).');
    if (card.isForSale) return msg.reply('❌ This card is currently listed in the shop — remove it with *.rc* first, or just tell them the shop code.');
    if (card.isLent) return msg.reply('❌ This card is currently lent out — get it back before selling it.');

    const chat = await safeGetChat(msg).catch(err => { console.error("getChat failed:", err.message); msg.reply("⚠️ WhatsApp connection hiccup — please try again in a moment."); return null; });
    if (!chat) return;

    // Replace any earlier pending offer between these two in this chat, so
    // .acceptsale always resolves to the latest offer, never a stale one —
    // same reasoning as .tc's identical cleanup step below.
    await SaleRequest.deleteMany({
      groupId: chat.id._serialized,
      sellerId: contact.id._serialized,
      buyerId: buyer.id._serialized
    });

    await SaleRequest.create({
      groupId: chat.id._serialized,
      sellerId: contact.id._serialized,
      buyerId: buyer.id._serialized,
      cardId: card._id,
      price
    });

    msg.reply(
      `🛍️ *Sale Offer*\n\n${mentionName(contact)} wants to sell you:\n${tierEmoji(card.tier)} *${card.name}* [${card.tier}]\nfor 💰 ${formatNum(price)} coins\n\n@${buyer.id.user}, reply *.acceptsale* or *.declinesale* (expires in 10 min)`,
      undefined,
      { mentions: [buyer.id._serialized] }
    );
  },

  // .acceptsale — accept the most recent pending sale offer sent to you in
  // this chat. Money and ownership only actually move here.
  async acceptsale(client, msg, args) {
    const contact = await msg.getContact();
    const chat = await safeGetChat(msg).catch(err => { console.error("getChat failed:", err.message); msg.reply("⚠️ WhatsApp connection hiccup — please try again in a moment."); return null; });
    if (!chat) return;

    const sale = await SaleRequest.findOne({
      groupId: chat.id._serialized,
      buyerId: contact.id._serialized
    }).sort({ createdAt: -1 });

    if (!sale) return msg.reply('❌ You have no pending sale offers.');

    if (Date.now() - sale.createdAt.getTime() > 10 * 60 * 1000) {
      await sale.deleteOne();
      return msg.reply('❌ That sale offer expired. Ask them to send a new one.');
    }

    const card = await OwnedCard.findById(sale.cardId);
    // Re-check ownership AND availability in case anything changed between
    // the offer and this acceptance — same defense-in-depth .accepttrade
    // applies to trades.
    if (!card || card.ownerId !== sale.sellerId) {
      await sale.deleteOne();
      return msg.reply('❌ This sale is no longer valid — the card changed hands since the offer.');
    }
    if (card.isStaked || card.isForSale || card.isLent) {
      await sale.deleteOne();
      return msg.reply('❌ This sale is no longer valid — the card is no longer available (staked, listed, or lent).');
    }

    const buyerUser = await User.findOrCreate(contact.id._serialized, contact.pushname);
    if (buyerUser.bank < sale.price) {
      return msg.reply(`❌ Not enough in your bank. Need 💰 ${formatNum(sale.price)}, you have ${formatNum(buyerUser.bank)}. Try *.deposit* first.`);
    }

    const sellerUser = await User.findOrCreate(sale.sellerId);
    buyerUser.bank -= sale.price;
    sellerUser.bank += sale.price;
    card.ownerId = contact.id._serialized;
    card.timesTraded += 1;

    await Promise.all([buyerUser.save(), sellerUser.save(), card.save(), sale.deleteOne()]);

    msg.reply(
      `✅ Bought *${card.name}* [${card.tier}] from @${sale.sellerId.split('@')[0]} for 💰 ${formatNum(sale.price)} coins!`,
      undefined,
      { mentions: [sale.sellerId] }
    );
  },

  // .declinesale — decline the most recent pending sale offer sent to you
  // in this chat.
  async declinesale(client, msg, args) {
    const contact = await msg.getContact();
    const chat = await safeGetChat(msg).catch(err => { console.error("getChat failed:", err.message); msg.reply("⚠️ WhatsApp connection hiccup — please try again in a moment."); return null; });
    if (!chat) return;

    const sale = await SaleRequest.findOne({
      groupId: chat.id._serialized,
      buyerId: contact.id._serialized
    }).sort({ createdAt: -1 });

    if (!sale) return msg.reply('❌ You have no pending sale offers.');

    await sale.deleteOne();
    msg.reply(
      `❌ ${mentionName(contact)} declined the sale offer from @${sale.sellerId.split('@')[0]}.`,
      undefined,
      { mentions: [sale.sellerId] }
    );
  },

  // .tc [@user] [your_index] [their_index] — propose a trade (Phase 6: safe
  // trading). Nothing changes hands yet; the partner must .accepttrade.
  async tc(client, msg, args) {
    const contact = await msg.getContact();
    const mentioned = await msg.getMentions();
    if (!mentioned.length) return msg.reply('❌ Usage: .tc [@user] [your_index] [their_index]');

    const myIndex = parseInt(args[1]);
    const theirIndex = parseInt(args[2]);
    const partner = mentioned[0];

    if (partner.id._serialized === contact.id._serialized) {
      return msg.reply("❌ You can't trade with yourself.");
    }

    const myCard = await getCardByIndex(contact.id._serialized, myIndex);
    const theirCard = await getCardByIndex(partner.id._serialized, theirIndex);

    if (!myCard) return msg.reply('❌ Your card not found.');
    if (!theirCard) return msg.reply(`❌ Their card not found.`);
    if (myCard.isStaked) return msg.reply('❌ Your card is staked as loan collateral — repay your loan first (.loan status).');
    if (theirCard.isStaked) return msg.reply('❌ Their card is staked as loan collateral on an active loan — they need to repay it before it can be traded.');
    if (myCard.isForSale) return msg.reply('❌ Your card is currently listed in the shop — remove it with *.rc* first.');
    if (theirCard.isForSale) return msg.reply('❌ Their card is currently listed in the shop.');
    if (myCard.isLent) return msg.reply('❌ Your card is currently lent out — get it back before trading it.');
    if (theirCard.isLent) return msg.reply('❌ Their card is currently lent out.');

    const chat = await safeGetChat(msg).catch(err => { console.error("getChat failed:", err.message); msg.reply("⚠️ WhatsApp connection hiccup — please try again in a moment."); return null; });
    if (!chat) return;

    // Replace any earlier pending offer between these two in this chat, so
    // .accepttrade always resolves to the latest offer, never a stale one.
    await TradeRequest.deleteMany({
      groupId: chat.id._serialized,
      initiatorId: contact.id._serialized,
      partnerId: partner.id._serialized
    });

    await TradeRequest.create({
      groupId: chat.id._serialized,
      initiatorId: contact.id._serialized,
      partnerId: partner.id._serialized,
      initiatorCardId: myCard._id,
      partnerCardId: theirCard._id
    });

    msg.reply(
      `🔄 *Trade Offer*\n\n${mentionName(contact)} wants to trade:\n${tierEmoji(myCard.tier)} *${myCard.name}*\n\nfor\n\n${tierEmoji(theirCard.tier)} *${theirCard.name}*\n\n@${partner.id.user}, reply *.accepttrade* or *.declinetrade* (expires in 10 min)`,
      undefined,
      { mentions: [partner.id._serialized] }
    );
  },

  // .accepttrade — accept the most recent pending trade offer sent to you
  // in this chat.
  async accepttrade(client, msg, args) {
    const contact = await msg.getContact();
    const chat = await safeGetChat(msg).catch(err => { console.error("getChat failed:", err.message); msg.reply("⚠️ WhatsApp connection hiccup — please try again in a moment."); return null; });
    if (!chat) return;

    const trade = await TradeRequest.findOne({
      groupId: chat.id._serialized,
      partnerId: contact.id._serialized
    }).sort({ createdAt: -1 });

    if (!trade) return msg.reply('❌ You have no pending trade offers.');

    if (Date.now() - trade.createdAt.getTime() > 10 * 60 * 1000) {
      await trade.deleteOne();
      return msg.reply('❌ That trade offer expired. Ask them to send a new one.');
    }

    const [myCard, theirCard] = await Promise.all([
      OwnedCard.findById(trade.partnerCardId),
      OwnedCard.findById(trade.initiatorCardId)
    ]);

    // Re-check ownership in case a card changed hands (sold, traded, or
    // auctioned elsewhere) between the offer and this acceptance.
    if (!myCard || myCard.ownerId !== contact.id._serialized ||
        !theirCard || theirCard.ownerId !== trade.initiatorId) {
      await trade.deleteOne();
      return msg.reply('❌ This trade is no longer valid — one of the cards changed hands since the offer.');
    }

    // Same re-check for staking/listing/lending — any of these can change
    // on a card any time after a .tc offer goes out but before it's
    // accepted, same reasoning as .acceptsale's identical guard.
    if (myCard.isStaked || theirCard.isStaked || myCard.isForSale || theirCard.isForSale || myCard.isLent || theirCard.isLent) {
      await trade.deleteOne();
      return msg.reply('❌ This trade is no longer valid — one of the cards is no longer available (staked, listed, or lent).');
    }

    myCard.ownerId = trade.initiatorId;
    theirCard.ownerId = trade.partnerId;
    myCard.timesTraded += 1;
    theirCard.timesTraded += 1;

    await Promise.all([myCard.save(), theirCard.save(), trade.deleteOne()]);

    await User.updateOne({ id: trade.initiatorId }, { $inc: { tradesCompleted: 1 } });
    await User.updateOne({ id: trade.partnerId }, { $inc: { tradesCompleted: 1 } });

    const [initiatorXp, partnerXp] = await Promise.all([
      addXP(trade.initiatorId, XP_REWARDS.trade),
      addXP(trade.partnerId, XP_REWARDS.trade)
    ]);

    const [initiatorUnlocks, partnerUnlocks] = await Promise.all([
      checkAchievements(trade.initiatorId),
      checkAchievements(trade.partnerId)
    ]);
    const [initiatorTitle, partnerTitle] = await Promise.all([
      checkTitle(trade.initiatorId),
      checkTitle(trade.partnerId)
    ]);

    let text =
      `✅ *Trade Complete!*\n\n@${trade.initiatorId.split('@')[0]} ➜ ${tierEmoji(myCard.tier)} ${myCard.name}\n@${trade.partnerId.split('@')[0]} ➜ ${tierEmoji(theirCard.tier)} ${theirCard.name}\n\n⭐ Both sides +${XP_REWARDS.trade} XP`;
    if (initiatorXp.levelUp) text += `\n🎉 @${trade.initiatorId.split('@')[0]} leveled up to ${initiatorXp.level}!`;
    if (partnerXp.levelUp) text += `\n🎉 @${trade.partnerId.split('@')[0]} leveled up to ${partnerXp.level}!`;
    if (initiatorUnlocks.length || initiatorTitle) text += `\n\n@${trade.initiatorId.split('@')[0]}${formatUnlockNotice(initiatorUnlocks)}${formatTitleUnlockNotice(initiatorTitle)}`;
    if (partnerUnlocks.length || partnerTitle) text += `\n\n@${trade.partnerId.split('@')[0]}${formatUnlockNotice(partnerUnlocks)}${formatTitleUnlockNotice(partnerTitle)}`;

    msg.reply(
      text,
      undefined,
      { mentions: [trade.initiatorId, trade.partnerId] }
    );
  },

  // .declinetrade — decline the most recent pending trade offer sent to you
  // in this chat.
  async declinetrade(client, msg, args) {
    const contact = await msg.getContact();
    const chat = await safeGetChat(msg).catch(err => { console.error("getChat failed:", err.message); msg.reply("⚠️ WhatsApp connection hiccup — please try again in a moment."); return null; });
    if (!chat) return;

    const trade = await TradeRequest.findOne({
      groupId: chat.id._serialized,
      partnerId: contact.id._serialized
    }).sort({ createdAt: -1 });

    if (!trade) return msg.reply('❌ You have no pending trade offers.');

    await trade.deleteOne();
    msg.reply(
      `❌ ${mentionName(contact)} declined the trade offer with @${trade.initiatorId.split('@')[0]}.`,
      undefined,
      { mentions: [trade.initiatorId] }
    );
  },

  // .lendcard [index] — lend one of YOUR cards (by .col position) to the
  // group temporarily.
  // BUGFIX (Aug 2026): this used to silently grab cards[0] — whichever
  // card happened to sort first — with no way to choose, and no way to get
  // it back early short of waiting out the full hour. It now takes an
  // explicit index (same convention as .card/.resell/.sellc) and pairs
  // with .unlendcard below for an early return.
  async lendcard(client, msg, args) {
    const contact = await msg.getContact();
    const userId = contact.id._serialized;
    const chat = await safeGetChat(msg).catch(err => { console.error("getChat failed:", err.message); msg.reply("⚠️ WhatsApp connection hiccup — please try again in a moment."); return null; });
    if (!chat) return;
    if (!chat.isGroup) return msg.reply('❌ Group only.');

    // Lazily clear any of this user's lends that expired while the bot was
    // offline — the in-memory setTimeout below is the normal path, but a
    // PM2 restart on Termux kills it with nothing to re-arm it on boot.
    // lendExpiresAt is the persisted source of truth, so this always
    // catches up before picking/checking a card.
    await OwnedCard.updateMany(
      { ownerId: userId, isLent: true, lendExpiresAt: { $ne: null, $lte: new Date() } },
      { $set: { isLent: false, lentTo: null, lendExpiresAt: null } }
    ).catch(err => console.error('lendcard: expired-lend cleanup failed:', err.message));

    const index = parseInt(args[0]);
    if (!index || index < 1) {
      return msg.reply('❌ Usage: .lendcard [index]\n\nUse *.col* to see your collection with numbered positions.');
    }

    const card = await getCardByIndex(userId, index);
    if (!card) return msg.reply('❌ Card not found.');
    if (card.isStaked) return msg.reply('❌ This card is staked as loan collateral — repay your loan first (.loan status).');
    if (card.isForSale) return msg.reply('❌ This card is currently listed in the shop — remove it with *.rc* first.');
    if (card.isLent) return msg.reply('❌ This card is already lent out.');

    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    card.isLent = true;
    card.lentTo = chat.id._serialized;
    card.lendExpiresAt = expiresAt;
    await card.save();

    msg.reply(`✅ You lent ${tierEmoji(card.tier)} *${card.name}* to this group for 1 hour!\nUse *.unlendcard ${index}* to get it back early.`);

    const cardId = card._id;
    setTimeout(async () => {
      // updateOne against the DB rather than re-saving this hour-old
      // in-memory `card` doc — that stale copy wouldn't reflect any other
      // field changed on the card in the meantime (e.g. isForSale toggled
      // via .sellc), and a plain .save() here would silently clobber that.
      // The `isLent: true` filter also means this is a no-op (no false
      // "returned" message) if .unlendcard already returned it early.
      const result = await OwnedCard.findOneAndUpdate(
        { _id: cardId, isLent: true },
        { $set: { isLent: false, lentTo: null, lendExpiresAt: null } }
      ).catch(err => { console.error('lendcard: auto-return failed:', err.message); return null; });
      if (result) {
        chat.sendMessage(`⏰ ${contact.pushname}'s *${result.name}* has been returned.`).catch(() => {});
      }
    }, 60 * 60 * 1000);
  },

  // .unlendcard [index] — reclaim a card you lent out before its 1-hour
  // timer expires. Index is optional if you only have one card out.
  async unlendcard(client, msg, args) {
    const contact = await msg.getContact();
    const userId = contact.id._serialized;

    const lentCards = await OwnedCard.find({ ownerId: userId, isLent: true });
    if (!lentCards.length) return msg.reply('❌ You have no cards currently lent out.');

    let target;
    const index = parseInt(args[0]);
    if (index) {
      target = await getCardByIndex(userId, index);
      if (!target || !target.isLent) return msg.reply('❌ That card is not currently lent out.');
    } else if (lentCards.length === 1) {
      target = lentCards[0];
    } else {
      const cards = await getUserCards(userId);
      const list = lentCards
        .map(lc => {
          const pos = cards.findIndex(c => c._id.equals(lc._id)) + 1;
          return `${pos}. ${tierEmoji(lc.tier)} ${lc.name}`;
        })
        .join('\n');
      return msg.reply(`❌ You have multiple cards lent out — specify which:\n\n${list}\n\nUse *.unlendcard [index]*.`);
    }

    const lentToChatId = target.lentTo;
    target.isLent = false;
    target.lentTo = null;
    target.lendExpiresAt = null;
    await target.save();

    msg.reply(`✅ ${tierEmoji(target.tier)} *${target.name}* has been returned to you early.`);

    if (lentToChatId) {
      try {
        const lentChat = await client.getChatById(lentToChatId);
        if (lentChat) await lentChat.sendMessage(`↩️ ${contact.pushname} took back *${target.name}* early.`);
      } catch {
        // Group may no longer exist / bot may have been removed — not fatal.
      }
    }
  },

  // .auction
  async auction(client, msg, args) {
    const auctions = await Auction.find({ isActive: true });
    if (!auctions.length) return msg.reply('🔨 No active auctions.');

    let text = `🔨 *Active Auctions*\n\n`;
    auctions.forEach((a) => {
      const timeLeft = Math.max(0, Math.round((a.endsAt - Date.now()) / 60000));
      text += `${tierEmoji(a.cardTier)} *${a.cardName}* [${a.cardTier}]\n   Current Bid: 💰 ${a.currentBid || a.startPrice}\n   Ends in: ${timeLeft}m\n   🆔 ${a.code || 'pending'}\n\n`;
    });
    text += `Use *.submit [code] [amount]* to bid!`;
    msg.reply(text);
  },

  // .submit [code] [amount] — bid
  async submit(client, msg, args) {
    const contact = await msg.getContact();
    const code = args[0]?.trim().toUpperCase();
    const amount = parseAmount(args[1]);
    if (!code || !amount) return msg.reply('❌ Usage: .submit [code] [amount]\n\nAmount supports shorthand: 5k, 1.2m, etc.');

    const auction = await Auction.findOne({ code });
    if (!auction || !auction.isActive) return msg.reply('❌ Auction not found or ended.');

    const user = await User.findOrCreate(contact.id._serialized);
    if (user.coins < amount) return msg.reply('❌ Not enough coins.');
    if (amount <= auction.currentBid) return msg.reply(`❌ Bid must be higher than ${auction.currentBid}.`);

    auction.currentBid = amount;
    auction.currentBidder = contact.id._serialized;
    await auction.save();
    msg.reply(`✅ Bid of 💰 ${amount} placed on *${auction.cardName}*!`);
  },

  // .myauc — your active auctions
  async myauc(client, msg, args) {
    const contact = await msg.getContact();
    const auctions = await Auction.find({ sellerId: contact.id._serialized, isActive: true });
    if (!auctions.length) return msg.reply('❌ You have no active auctions.');

    let text = `🔨 *Your Auctions*\n\n`;
    auctions.forEach((a) => {
      text += `${a.cardName} [${a.cardTier}] — Bid: 💰 ${a.currentBid}\n   🆔 ${a.code || 'pending'}\n`;
    });
    msg.reply(text);
  },

  // .remauc [code] — remove your auction
  async remauc(client, msg, args) {
    const contact = await msg.getContact();
    const code = args[0]?.trim().toUpperCase();
    const auction = await Auction.findOne({ code, sellerId: contact.id._serialized });
    if (!auction) return msg.reply('❌ Auction not found.');
    auction.isActive = false;
    await auction.save();
    msg.reply('✅ Auction removed.');
  },

  // .listauc — same as .auction
  async listauc(client, msg, args) {
    return module.exports.auction(client, msg, args);
  },

  // .stardust
  async stardust(client, msg, args) {
    const contact = await msg.getContact();
    const user = await User.findOrCreate(contact.id._serialized);
    msg.reply(`✨ *Stardust Balance*\n\nYou have ✨ *${user.stardust}* stardust.\n\nConvert duplicate cards to stardust to upgrade your collection!`);
  },

  // .anticamp — toggle anticamp
  async anticamp(client, msg, args) {
    const contact = await msg.getContact();
    const user = await User.findOrCreate(contact.id._serialized);
    msg.reply(`🏕️ *Anticamp*\n\nYour camp count: ${user.campCount}\n\nIf you hoard too many duplicate cards, they'll decay automatically.`);
  },

  // .wishlist [add|remove] [name] — manage your wishlist, or view it with no args
  async wishlist(client, msg, args) {
    const contact = await msg.getContact();
    const user = await User.findOrCreate(contact.id._serialized);
    const sub = args[0]?.toLowerCase();

    if (sub === 'add') {
      const name = args.slice(1).join(' ').trim();
      if (!name) return msg.reply('❌ Usage: .wishlist add [character name]');

      const already = user.wishlist.some(w => w.toLowerCase() === name.toLowerCase());
      if (already) return msg.reply(`❌ *${name}* is already on your wishlist.`);

      user.wishlist.push(name);
      await user.save();
      return msg.reply(`❤️ Added *${name}* to your wishlist! You'll be pinged when it drops.`);
    }

    if (sub === 'remove') {
      const name = args.slice(1).join(' ').trim();
      if (!name) return msg.reply('❌ Usage: .wishlist remove [character name]');

      const before = user.wishlist.length;
      user.wishlist = user.wishlist.filter(w => w.toLowerCase() !== name.toLowerCase());
      if (user.wishlist.length === before) return msg.reply(`❌ *${name}* isn't on your wishlist.`);

      await user.save();
      return msg.reply(`✅ Removed *${name}* from your wishlist.`);
    }

    // No args — view
    if (!user.wishlist.length) {
      return msg.reply('❤️ Your wishlist is empty.\n\nUse *.wishlist add [name]* to add a character.');
    }

    const lines = user.wishlist.map((w, i) => `${i + 1}. ${w}`).join('\n');
    msg.reply(`❤️ *Your Wishlist*\n\n${lines}\n\nUse *.wishlist remove [name]* to remove one.`);
  },

  // .wishlb — leaderboard by wishlist size
  async wishlb(client, msg, args) {
    const users = await User.find({ wishlist: { $exists: true, $ne: [] } });
    if (!users.length) return msg.reply('❤️ Nobody has a wishlist yet.');

    const ranked = users
      .map(u => ({ id: u.id, count: u.wishlist.length }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    let text = `🏆 *Biggest Wishlists*\n\n`;
    ranked.forEach((u, i) => {
      text += `${i + 1}. @${u.id.split('@')[0]} — ${u.count} card(s)\n`;
    });
    msg.reply(text, undefined, { mentions: ranked.map(u => u.id) });
  },

  // .fuse [i1] [i2] [i3] — sacrifice 3 same-tier cards for a chance at one
  // card of the next tier up. Real risk: the 3 cards are consumed whether the
  // fusion succeeds or fails. A rare "lucky" roll jumps two tiers instead of
  // one, if a card is actually available there.
  async fuse(client, msg, args) {
    const contact = await msg.getContact();
    const userId = contact.id._serialized;

    const indices = args.slice(0, 3).map(a => parseInt(a));
    if (indices.length < 3 || indices.some(i => !i || i < 1)) {
      return msg.reply('❌ Usage: .fuse [index1] [index2] [index3]\n\nPick 3 cards from *.col* (must all be the same tier).');
    }
    if (new Set(indices).size < 3) {
      return msg.reply('❌ Pick 3 *different* cards, not the same one twice.');
    }

    const cards = await getUserCards(userId);
    const selected = indices.map(i => cards[i - 1]);

    if (selected.some(c => !c)) {
      return msg.reply(`❌ One of those positions doesn't exist. You have ${cards.length} card(s) — check *.col*.`);
    }

    if (selected.some(c => c.isStaked)) {
      return msg.reply('❌ One of those cards is staked as loan collateral — repay your loan first (.loan status) before fusing it away.');
    }
    if (selected.some(c => c.isForSale)) {
      return msg.reply('❌ One of those cards is currently listed in the shop — remove it with *.rc* first.');
    }
    if (selected.some(c => c.isLent)) {
      return msg.reply('❌ One of those cards is currently lent out — get it back before fusing it away.');
    }

    const tier = selected[0].tier;
    if (!selected.every(c => c.tier === tier)) {
      return msg.reply('❌ All 3 cards must be the same tier to fuse.');
    }

    const targetTier = tierAbove(tier);
    if (!targetTier) {
      return msg.reply('❌ SSS is already the highest tier — nothing to fuse it into.');
    }

    const claimedIds = await OwnedCard.distinct('catalogueId');
    const targetPool = await CardCatalogue.find({ tier: targetTier, cardId: { $nin: claimedIds } });

    if (!targetPool.length) {
      return msg.reply(`❌ No unclaimed ${targetTier}-tier cards available to fuse into right now. Your cards are safe — nothing was consumed.`);
    }

    // Roll outcome BEFORE touching any cards, so a failed roll never costs
    // more than the 3 inputs, and an unavailable target costs nothing at all.
    const success = Math.random() < 0.7;
    let finalTier = targetTier;
    let finalPool = targetPool;
    let lucky = false;

    if (success && Math.random() < 0.1) {
      const doubleTier = tierAbove(tier, 2);
      if (doubleTier) {
        const doublePool = await CardCatalogue.find({ tier: doubleTier, cardId: { $nin: claimedIds } });
        if (doublePool.length) {
          finalTier = doubleTier;
          finalPool = doublePool;
          lucky = true;
        }
      }
    }

    // Consume the 3 inputs now that the outcome is decided.
    await OwnedCard.deleteMany({ _id: { $in: selected.map(c => c._id) } });

    const consumedList = selected.map(c => `${tierEmoji(c.tier)} ${c.name}`).join(', ');

    if (!success) {
      return msg.reply(`💥 *Fusion Failed!*\n\nConsumed: ${consumedList}\n\nBetter luck next time.`);
    }

    const resultCatalogue = finalPool[Math.floor(Math.random() * finalPool.length)];
    await OwnedCard.create({
      ownerId: userId,
      catalogueId: resultCatalogue.cardId,
      code: await generateUniqueCode(OwnedCard),
      name: resultCatalogue.name,
      series: resultCatalogue.series,
      tier: resultCatalogue.tier,
      firstOwner: userId
    });

    const unlocked = await checkAchievements(userId);
    const xpResult = await addXP(userId, XP_REWARDS.fusion);
    const newTitle = await checkTitle(userId);
    const luckyNote = lucky ? '\n\n🍀 *Lucky!* Jumped two tiers instead of one!' : '';
    const xpLine = `\n⭐ +${XP_REWARDS.fusion} XP${xpResult.levelUp ? ` — 🎉 Level up! You're now level ${xpResult.level}!` : ''}`;

    msg.reply(
      `✨ *Fusion Success!*\n\nConsumed: ${consumedList}\n\nReceived: ${tierEmoji(resultCatalogue.tier)} *${resultCatalogue.name}* [${resultCatalogue.tier}]` +
      luckyNote + xpLine + formatUnlockNotice(unlocked) + formatTitleUnlockNotice(newTitle)
    );
  },

  // .resell [index] — instant sell to the bot for guaranteed coins (50% of
  // tier value — same resale-discount convention as .sell in economy.js).
  // Distinct from .sellc, which lists a card on the *player* marketplace and
  // waits for a buyer at whatever price you set; .resell has no buyer, no
  // waiting, and no listing to remove later, but pays less.
  async resell(client, msg, args) {
    const contact = await msg.getContact();
    const index = parseInt(args[0]);
    if (!index || index < 1) {
      return msg.reply('❌ Usage: .resell [index]\n\nUse *.col* to see your collection with numbered positions.\n\nInstantly sells to the bot for 50% of tier value — no buyer needed. Use *.sellc* instead if you want a shot at full value from another player.');
    }

    const card = await getCardByIndex(contact.id._serialized, index);
    if (!card) {
      const total = (await getUserCards(contact.id._serialized)).length;
      return msg.reply(`❌ No card at position ${index}. You have ${total} card(s) — try *.col*.`);
    }
    if (card.isForSale) return msg.reply('❌ This card is currently listed in the shop — remove it with *.rc* first.');
    if (card.isLent) return msg.reply('❌ This card is currently lent out — get it back before reselling it.');
    if (card.isStaked) return msg.reply('❌ This card is staked as loan collateral — repay your loan first (.loan status) before reselling it.');

    const resellPrice = Math.floor(cardValue(card.tier) * 0.5);
    const user = await User.findOrCreate(contact.id._serialized);

    await OwnedCard.deleteOne({ _id: card._id });
    // Bot-to-user payout — goes to the bank, not the wallet, same policy as
    // .loan disbursement and .acceptsale/.claim's shop-purchase payout.
    user.bank += resellPrice;
    await user.save();

    msg.reply(`✅ Resold *${card.name}* [${card.tier}] to the bot for 💰 ${formatNum(resellPrice)} coins (deposited to your bank).\n\nThis card is gone for good — use *.sellc* instead next time if you want a shot at full value from another player.`);
  },

  // .tier — shows the rarity tier list with real drop odds (read straight
  // from TIER_DROP_RATES in helpers.js, so this can never drift out of sync
  // with what rollTier() actually does) and coin value per tier.
  // .tier [letter] — browse every catalogue card in that tier, with a
  // claimed/available marker per card.
  async tier(client, msg, args) {
    const arg = args[0]?.toUpperCase();
    const VALID_TIERS = TIER_DROP_RATES.map(t => t.tier);

    if (!arg) {
      let text = `🎴 *Tier List*\n\n`;
      let prevCumulative = 0;
      TIER_DROP_RATES.forEach(({ tier, cumulative }) => {
        const odds = (cumulative - prevCumulative).toFixed(1).replace(/\.0$/, '');
        text += `${tierEmoji(tier)} *${tier}* — Drop chance: ${odds}% • Value: 💰 ${cardValue(tier).toLocaleString()}\n`;
        prevCumulative = cumulative;
      });
      text += `\nUse *.tier [letter]* to browse every card in a tier, e.g. *.tier SSS*`;
      return msg.reply(text);
    }

    if (!VALID_TIERS.includes(arg)) {
      return msg.reply(`❌ "${arg}" isn't a valid tier. Valid tiers: ${VALID_TIERS.join(', ')}`);
    }

    const TIER_BROWSE_LIMIT = 30;
    const catalogueCards = await CardCatalogue.find({ tier: arg }).sort({ name: 1 });
    if (!catalogueCards.length) return msg.reply(`❌ No cards exist in tier ${arg} yet.`);

    const claimedIds = await OwnedCard.distinct('catalogueId');
    const claimedSet = new Set(claimedIds);

    let text = `${tierEmoji(arg)} *Tier ${arg}* (${catalogueCards.length} card${catalogueCards.length === 1 ? '' : 's'}, 💰 ${cardValue(arg).toLocaleString()} each)\n\n`;
    catalogueCards.slice(0, TIER_BROWSE_LIMIT).forEach(c => {
      const status = c.cardId && claimedSet.has(c.cardId) ? '🔒' : '💎';
      text += `${status} ${c.name} — ${c.series}\n`;
    });
    if (catalogueCards.length > TIER_BROWSE_LIMIT) {
      text += `\n...and ${catalogueCards.length - TIER_BROWSE_LIMIT} more.`;
    }
    text += `\n💎 = available to claim  🔒 = already claimed`;
    msg.reply(text);
  },

  // .cs [name or series] — search the catalogue by name OR series, returning
  // a list of matches. Distinct from .ci/.cardinfo, which does an exact-ish
  // findOne() lookup for one card's full detail view — .cs is for "I don't
  // remember the exact name" browsing across multiple results.
  async cs(client, msg, args) {
    const query = args.join(' ').trim();
    if (!query) return msg.reply('❌ Usage: .cs [name or series]\n\nSearches both card names and series. Use *.ci [name]* for full details on one card.');

    const CS_LIMIT = 25;
    let regex;
    try {
      regex = new RegExp(query, 'i');
    } catch {
      return msg.reply('❌ That search text isn\'t valid — try removing special characters like ( ) [ ] * +.');
    }

    const matches = await CardCatalogue.find({ $or: [{ name: regex }, { series: regex }] })
      .sort({ tier: -1, name: 1 })
      .limit(CS_LIMIT);

    if (!matches.length) return msg.reply(`❌ No cards found matching "${query}".`);

    const claimedIds = await OwnedCard.distinct('catalogueId');
    const claimedSet = new Set(claimedIds);

    let text = `🔍 *Search: "${query}"* (${matches.length}${matches.length === CS_LIMIT ? '+' : ''} result${matches.length === 1 ? '' : 's'})\n\n`;
    matches.forEach(c => {
      const status = c.cardId && claimedSet.has(c.cardId) ? '🔒' : '💎';
      text += `${status} ${tierEmoji(c.tier)} *${c.name}* [${c.tier}] — ${c.series}\n`;
    });
    text += `\nUse *.ci [name]* for full details on a specific card.`;
    msg.reply(text);
  },

  // .myseries — overview of every series you own at least one card from,
  // with owned/total counts and completion %. Distinct from .ss [series],
  // which needs you to already know/type the exact series name and just
  // lists your cards from it with no completion context.
  async myseries(client, msg, args) {
    const contact = await msg.getContact();
    const userId = contact.id._serialized;

    const owned = await OwnedCard.find({ ownerId: userId });
    if (!owned.length) return msg.reply('❌ You have no cards yet. Wait for one to drop and use *.claim*!');

    const bySeries = new Map();
    owned.forEach(c => {
      const key = c.series || 'Unknown';
      if (!bySeries.has(key)) bySeries.set(key, []);
      bySeries.get(key).push(c);
    });

    const seriesNames = [...bySeries.keys()];
    const totals = await CardCatalogue.aggregate([
      { $match: { series: { $in: seriesNames } } },
      { $group: { _id: '$series', total: { $sum: 1 } } },
    ]);
    const totalBySeriesName = new Map(totals.map(t => [t._id, t.total]));

    const rows = seriesNames
      .map(name => {
        const ownedCount = bySeries.get(name).length;
        const total = totalBySeriesName.get(name) || ownedCount;
        return { name, owned: ownedCount, total };
      })
      .sort((a, b) => (b.owned / b.total) - (a.owned / a.total) || b.owned - a.owned);

    let text = `📚 *Your Series* (${rows.length})\n\n`;
    rows.forEach(r => {
      const pct = r.total ? Math.round((r.owned / r.total) * 100) : 100;
      const complete = r.owned >= r.total ? ' ✅' : '';
      text += `${r.name} — ${r.owned}/${r.total} (${pct}%)${complete}\n`;
    });
    text += `\nUse *.ss [series]* to see your cards from one series, or *.si [series]* for the full catalogue.`;
    msg.reply(text);
  },
};
