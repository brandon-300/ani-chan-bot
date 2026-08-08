const { CardCatalogue, OwnedCard, Auction, TradeRequest } = require('../models/Card');
const { checkAchievements, formatUnlockNotice } = require('../utils/achievements');
const { checkTitle, formatTitleUnlockNotice } = require('../utils/titles');
const { MessageMedia } = require('whatsapp-web.js');
const User = require('../models/User');
const Group = require('../models/Group');
const { tierEmoji, rollTier, formatNum, pick, mentionName, mentionTag, generateUniqueCode, safeGetChat, cardValue, tierAbove, TIER_DROP_RATES, addXP, XP_REWARDS } = require('../utils/helpers');
const crypto = require('crypto');

// ─── Helpers ──────────────────────────────────────────────────────────────────
// Same escaping used by utils/memeRender.js's HTML-rendering path — needed
// here too now that .cg (below) builds an HTML grid via client.pupBrowser.
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function getUserCards(userId) {
  const cards = await OwnedCard.find({ ownerId: userId });
  return cards.sort((a, b) => cardValue(b.tier) - cardValue(a.tier) || a.name.localeCompare(b.name));
}

async function getCardByIndex(userId, index) {
  const cards = await getUserCards(userId);
  return cards[index - 1] || null;
}

// Resolves a user's deck (array of OwnedCard _id strings) into full card
// docs, in the exact order they were added — Mongo's $in query does NOT
// preserve array order, so this can't just be a plain .find(). Stale ids
// (the card was traded/sold away after being added to the deck) come back
// as null rather than being dropped, so slot numbers always line up with
// real array positions — that matters because .deck remove [index] trusts
// those same positions.
async function getDeckCards(deckIds) {
  if (!deckIds.length) return [];
  const cards = await OwnedCard.find({ _id: { $in: deckIds } });
  const byId = new Map(cards.map(c => [c._id.toString(), c]));
  return deckIds.map(id => byId.get(id) || null);
}

// ─── Drop a Random Card in Group ─────────────────────────────────────────────
async function dropCard(chat) {
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

  if (card.imageUrl) {
    try {
      const media = await MessageMedia.fromUrl(card.imageUrl, { unsafeMime: true });
      await chat.sendMessage(media, { caption: fullCaption, mentions: matchedIds });
      return card;
    } catch {
      // image fetch failed — fall through to text-only drop below
    }
  }

  await chat.sendMessage(fullCaption, { mentions: matchedIds });
  return card;
}

// ─── Track active drop intervals so toggling never leaks or duplicates them ──
const cardIntervals = new Map(); // chatId -> intervalId

function startDropInterval(chat) {
  const chatId = chat.id._serialized;
  if (cardIntervals.has(chatId)) clearInterval(cardIntervals.get(chatId));
  const intervalId = setInterval(() => dropCard(chat), 5 * 60 * 1000);
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
      startDropInterval(chat);
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
      startDropInterval(chat);
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

    const caption =
`📖 *${card.name}*

${tierEmoji(card.tier)} Tier: ${card.tier}
📚 Series: ${card.series}
💰 Value: ${cardValue(card.tier).toLocaleString()} coins
🆔 Code: ${card.code || 'N/A'}
🔄 Times Traded: ${card.timesTraded}
📅 Obtained: ${new Date(card.obtainedAt).toLocaleDateString()}${catalogue?.description ? `\n📝 ${catalogue.description}` : ''}`;

    if (catalogue?.imageUrl) {
      try {
        const media = await MessageMedia.fromUrl(catalogue.imageUrl, { unsafeMime: true });
        const chat = await safeGetChat(msg).catch(err => { console.error("getChat failed:", err.message); msg.reply("⚠️ WhatsApp connection hiccup — please try again in a moment."); return null; });
        if (!chat) return;
        return await chat.sendMessage(media, { caption });
      } catch {
        // image fetch failed — fall through to text-only reply
      }
    }
    return msg.reply(caption);
  },

  // .ci [name] [tier] — card info from catalogue
  async ci(client, msg, args) {
    const tier = args[args.length - 1]?.toUpperCase();
    const name = args.slice(0, -1).join(' ');
    if (!name) return msg.reply('❌ Usage: .ci [name] [tier]');

    const query = tier && ['C','B','A','S','SS','SSS'].includes(tier)
      ? { name: new RegExp(name, 'i'), tier }
      : { name: new RegExp(name, 'i') };

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
📅 Added: ${card.createdAt ? new Date(card.createdAt).toLocaleDateString() : 'Unknown'}${card.description ? `\n📝 ${card.description}` : ''}

Use *.claim* when this card drops!`;

    const mentions = owned
      ? [...new Set([owned.ownerId, owned.firstOwner].filter(Boolean))]
      : [];

    if (card.imageUrl) {
      try {
        const media = await MessageMedia.fromUrl(card.imageUrl, { unsafeMime: true });
        const chat = await safeGetChat(msg).catch(err => { console.error("getChat failed:", err.message); msg.reply("⚠️ WhatsApp connection hiccup — please try again in a moment."); return null; });
        if (!chat) return;
        return await chat.sendMessage(media, { caption, mentions });
      } catch {
        // image fetch failed — fall through to text-only reply
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

  // .deck [add|remove|clear] [index] — view/manage your battle deck (max 5 cards)
  async deck(client, msg, args) {
    const contact = await msg.getContact();
    const userId = contact.id._serialized;
    const user = await User.findOrCreate(userId, contact.pushname);
    const sub = args[0]?.toLowerCase();

    // .deck add [index] — index = position in your full collection (.col / .card)
    if (sub === 'add') {
      const index = parseInt(args[1]);
      if (!index || index < 1) {
        return msg.reply('❌ Usage: .deck add [index]\n\nUse the position shown in *.col* or *.card [index]*.');
      }
      if (user.deck.length >= 5) {
        return msg.reply('❌ Your deck is full (5/5). Use *.deck remove [index]* to make room first.');
      }

      const card = await getCardByIndex(userId, index);
      if (!card) {
        const total = (await getUserCards(userId)).length;
        return msg.reply(`❌ No card at position ${index}. You have ${total} card(s) — check *.col*.`);
      }

      const cardId = card._id.toString();
      if (user.deck.includes(cardId)) {
        return msg.reply(`❌ *${card.name}* is already in your deck.`);
      }

      user.deck.push(cardId);
      await user.save();
      return msg.reply(`✅ Added ${tierEmoji(card.tier)} *${card.name}* to your deck (${user.deck.length}/5).`);
    }

    // .deck remove [index] — index = slot number shown by plain .deck (1-5)
    if (sub === 'remove') {
      const index = parseInt(args[1]);
      if (!index || index < 1) {
        return msg.reply('❌ Usage: .deck remove [index]\n\nUse the position shown in *.deck*.');
      }
      if (!user.deck.length) return msg.reply('❌ Your deck is already empty.');

      const targetId = user.deck[index - 1];
      if (!targetId) {
        return msg.reply(`❌ No card in deck slot ${index}. You have ${user.deck.length} card(s) in your deck.`);
      }

      const removedCard = await OwnedCard.findById(targetId).catch(() => null);
      user.deck = user.deck.filter(id => id !== targetId);
      await user.save();

      const label = removedCard ? `${tierEmoji(removedCard.tier)} *${removedCard.name}*` : 'that card';
      return msg.reply(`✅ Removed ${label} from your deck (${user.deck.length}/5).`);
    }

    // .deck clear — empty the whole deck
    if (sub === 'clear') {
      if (!user.deck.length) return msg.reply('❌ Your deck is already empty.');
      user.deck = [];
      await user.save();
      return msg.reply('✅ Your deck has been cleared.');
    }

    // .deck (no args) — view, in the order cards were added
    if (!user.deck.length) return msg.reply('❌ Your deck is empty. Use *.deck add [index]* (see *.col* for positions) to add cards.');

    const cards = await getDeckCards(user.deck);
    let text = `⚔️ *Your Deck*\n\n`;
    let power = 0;
    let staleCount = 0;
    cards.forEach((c, i) => {
      if (c) {
        text += `${i + 1}. ${tierEmoji(c.tier)} ${c.name} — ${c.tier}\n`;
        power += ({ C: 10, B: 25, A: 50, S: 100, SS: 200, SSS: 500 }[c.tier] || 0);
      } else {
        text += `${i + 1}. ⚠️ Unavailable (likely traded/sold) — use *.deck remove ${i + 1}* to clear this slot\n`;
        staleCount++;
      }
    });
    text += `\n⚡ Total Power: ${power}`;
    if (staleCount) {
      text += `\n\n${staleCount} slot(s) above need cleanup — the cards were traded/sold away after being added.`;
    }
    msg.reply(text);
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

      const caption =
`📖 *${card.name}*

${tierEmoji(card.tier)} Tier: ${card.tier}
📚 Series: ${card.series}
💰 Value: ${cardValue(card.tier).toLocaleString()} coins
🆔 Code: ${card.code || 'N/A'}
🔄 Times Traded: ${card.timesTraded}
📅 Obtained: ${new Date(card.obtainedAt).toLocaleDateString()}${catalogue?.description ? `\n📝 ${catalogue.description}` : ''}`;

      if (catalogue?.imageUrl) {
        try {
          const media = await MessageMedia.fromUrl(catalogue.imageUrl, { unsafeMime: true });
          const chat = await safeGetChat(msg).catch(err => { console.error("getChat failed:", err.message); msg.reply("⚠️ WhatsApp connection hiccup — please try again in a moment."); return null; });
          if (!chat) return;
          return await chat.sendMessage(media, { caption });
        } catch {
          // image fetch failed — fall through to text-only reply
        }
      }
      return msg.reply(caption);
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

  // .cardshop
  async cardshop(client, msg, args) {
    const forSale = await OwnedCard.find({ isForSale: true }).limit(20);
    if (!forSale.length) return msg.reply('🛒 The card shop is currently empty.');

    let text = `🛒 *Card Shop*\n\n`;
    forSale.forEach((c) => {
      text += `${tierEmoji(c.tier)} *${c.name}* [${c.tier}] — 💰 ${c.price} coins\n🆔 ${c.code || 'pending'} (Owner: ${c.ownerId})\n\n`;
    });
    text += `Use *.claim <code>* to buy!`;
    msg.reply(text);
  },

  // .sellc [index] [price]
  async sellc(client, msg, args) {
    const contact = await msg.getContact();
    const index = parseInt(args[0]);
    const price = parseInt(args[1]);
    if (!index || !price || price < 1) return msg.reply('❌ Usage: .sellc [index] [price]');

    const card = await getCardByIndex(contact.id._serialized, index);
    if (!card) return msg.reply('❌ Card not found.');

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

  // .vs — battle with decks
  async vs(client, msg, args) {
    const contact = await msg.getContact();
    const mentioned = await msg.getMentions();
    if (!mentioned.length) return msg.reply('❌ Mention someone to battle! .vs @user');

    const opponent = mentioned[0];
    const user = await User.findOrCreate(contact.id._serialized);
    const opp = await User.findOrCreate(opponent.id._serialized);

    const userCards = await OwnedCard.find({ _id: { $in: user.deck } });
    const oppCards = await OwnedCard.find({ _id: { $in: opp.deck } });

    const tierVal = { C: 10, B: 25, A: 50, S: 100, SS: 200, SSS: 500 };
    const userPower = userCards.reduce((s, c) => s + (tierVal[c.tier] || 0), 0) + Math.random() * 50;
    const oppPower = oppCards.reduce((s, c) => s + (tierVal[c.tier] || 0), 0) + Math.random() * 50;

    const winner = userPower >= oppPower ? contact.pushname : opponent.pushname;
    const prize = 200;

    if (userPower >= oppPower) {
      user.coins += prize; await user.save();
    } else {
      opp.coins += prize; await opp.save();
    }

    msg.reply(
      `⚔️ *Card Battle!*\n\n🔵 ${contact.pushname} Power: ${Math.round(userPower)}\n🔴 ${opponent.pushname} Power: ${Math.round(oppPower)}\n\n🏆 *Winner: ${winner}* (+${prize} coins)`
    );
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
      if (user.coins < shopCard.price) return msg.reply(`❌ Not enough coins. Need ${shopCard.price}.`);
      user.coins -= shopCard.price;
      shopCard.ownerId = contact.id._serialized;
      shopCard.isForSale = false;
      shopCard.price = 0;
      shopCard.timesTraded += 1;
      await shopCard.save();
      await user.save();
      const xpResult = await addXP(contact.id._serialized, XP_REWARDS.shopBuy);
      const unlocked = await checkAchievements(contact.id._serialized);
      const newTitle = await checkTitle(contact.id._serialized);
      const xpLine = `\n⭐ +${XP_REWARDS.shopBuy} XP${xpResult.levelUp ? ` — 🎉 Level up! You're now level ${xpResult.level}!` : ''}`;
      return msg.reply(`✅ You bought *${shopCard.name}* [${shopCard.tier}]!` + xpLine + formatUnlockNotice(unlocked) + formatTitleUnlockNotice(newTitle));
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

  // .sc [@user] [index] [price] — sell card to a user
  async sc(client, msg, args) {
    const contact = await msg.getContact();
    const mentioned = await msg.getMentions();
    if (!mentioned.length) return msg.reply('❌ Usage: .sc [@user] [index] [price]');

    const index = parseInt(args[1]);
    const price = parseInt(args[2]);
    if (!index || !price) return msg.reply('❌ Usage: .sc [@user] [index] [price]');

    const buyer = mentioned[0];
    const buyerUser = await User.findOne({ id: buyer.id._serialized });
    if (!buyerUser || buyerUser.coins < price) return msg.reply('❌ Buyer has insufficient funds.');

    const card = await getCardByIndex(contact.id._serialized, index);
    if (!card) return msg.reply('❌ Card not found.');

    buyerUser.coins -= price;
    const sellerUser = await User.findOrCreate(contact.id._serialized);
    sellerUser.coins += price;
    card.ownerId = buyer.id._serialized;
    card.timesTraded += 1;

    await Promise.all([buyerUser.save(), sellerUser.save(), card.save()]);
    msg.reply(
      `✅ Sold *${card.name}* [${card.tier}] to @${mentionTag(buyer)} for 💰 ${price}!`,
      undefined,
      { mentions: [buyer.id._serialized] }
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

  // .lendcard — lend your top card to group temporarily
  async lendcard(client, msg, args) {
    const contact = await msg.getContact();
    const chat = await safeGetChat(msg).catch(err => { console.error("getChat failed:", err.message); msg.reply("⚠️ WhatsApp connection hiccup — please try again in a moment."); return null; });
    if (!chat) return;
    if (!chat.isGroup) return msg.reply('❌ Group only.');
    const cards = await getUserCards(contact.id._serialized);
    if (!cards.length) return msg.reply('❌ You have no cards.');
    const card = cards[0];
    card.isLent = true;
    card.lentTo = chat.id._serialized;
    await card.save();
    msg.reply(`✅ You lent ${tierEmoji(card.tier)} *${card.name}* to this group for 1 hour!`);
    setTimeout(async () => {
      card.isLent = false; card.lentTo = null;
      await card.save();
      chat.sendMessage(`⏰ ${contact.pushname}'s *${card.name}* has been returned.`);
    }, 60 * 60 * 1000);
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
    const amount = parseInt(args[1]);
    if (!code || !amount) return msg.reply('❌ Usage: .submit [code] [amount]');

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

    const resellPrice = Math.floor(cardValue(card.tier) * 0.5);
    const user = await User.findOrCreate(contact.id._serialized);

    await OwnedCard.deleteOne({ _id: card._id });
    user.coins += resellPrice;
    await user.save();

    msg.reply(`✅ Resold *${card.name}* [${card.tier}] to the bot for 💰 ${resellPrice} coins.\n\nThis card is gone for good — use *.sellc* instead next time if you want a shot at full value from another player.`);
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

  // .cg [page] — visual grid image of your collection, rendered as an HTML
  // page and screenshotted via the same already-running Chromium instance
  // whatsapp-web.js keeps open for the WhatsApp session (client.pupBrowser)
  // — same technique utils/memeRender.js uses, for the same reason: this
  // project deliberately has no canvas/sharp/jimp dependency (sharp already
  // failed to install as a native binary on this Termux/Android setup — see
  // the note at the top of commands/games/chessBoardImage.js), so reusing
  // the browser that's already open costs zero new npm installs.
  //
  // Card art loads directly from each card's catalogue imageUrl (AniList),
  // over whatever network the phone has at render time — given how unstable
  // that can get, every image tile has an onerror fallback (a plain
  // tier-colored tile) so one slow/broken image never breaks the whole grid,
  // and the overall render has a hard timeout so a bad connection fails
  // loudly with a clear error instead of hanging the command queue.
  //
  // UNTESTED against the real device — this is the first command in the
  // project compositing MULTIPLE external network images into one grid via
  // Puppeteer (memeRender.js only ever handles one attached image). Please
  // test with a small collection first and share the pm2 logs either way —
  // if page.setContent's timeout or the network proves too unreliable in
  // practice, the fix is almost certainly just lowering CG_PER_PAGE/timeout,
  // not a rewrite.
  async cg(client, msg, args) {
    if (!client.pupBrowser) {
      return msg.reply('❌ Card grid needs the WhatsApp browser session, which isn\'t ready yet — try again in a moment.');
    }

    const contact = await msg.getContact();
    const userId = contact.id._serialized;
    const cards = await getUserCards(userId); // already sorted: tier desc, then name
    if (!cards.length) return msg.reply('❌ You have no cards yet. Wait for one to drop and use *.claim*!');

    const CG_COLS = 3;
    const CG_PER_PAGE = 9;
    const CG_CELL_W = 190;
    const CG_CELL_H = 250;
    const CG_TIMEOUT_MS = 20000;
    const TIER_COLORS = { C: '#9e9e9e', B: '#4caf50', A: '#2196f3', S: '#ffc107', SS: '#ff9800', SSS: '#f44336' };

    const totalPages = Math.max(1, Math.ceil(cards.length / CG_PER_PAGE));
    let page = parseInt(args[0]) || 1;
    if (page < 1) page = 1;
    if (page > totalPages) page = totalPages;

    const startIdx = (page - 1) * CG_PER_PAGE;
    const pageCards = cards.slice(startIdx, startIdx + CG_PER_PAGE);

    const catalogueIds = [...new Set(pageCards.map(c => c.catalogueId).filter(Boolean))];
    const catalogues = catalogueIds.length
      ? await CardCatalogue.find({ cardId: { $in: catalogueIds } })
      : [];
    const imageByCatalogueId = new Map(catalogues.map(c => [c.cardId, c.imageUrl]));

    msg.reply(`🖼️ Rendering your card grid (page ${page}/${totalPages})...`);

    const cells = pageCards.map((c, i) => ({
      index: startIdx + i + 1,
      name: c.name,
      tier: c.tier,
      imageUrl: (c.catalogueId && imageByCatalogueId.get(c.catalogueId)) || '',
    }));

    const rows = Math.ceil(cells.length / CG_COLS);
    const width = CG_COLS * CG_CELL_W;
    const height = rows * CG_CELL_H + 70; // + header

    const cellsHtml = cells.map(c => {
      const color = TIER_COLORS[c.tier] || '#9e9e9e';
      if (c.imageUrl) {
        // Had a saved URL — if THIS still shows a fallback tile after
        // rendering, the URL itself failed to load (network/CDN issue), not
        // a missing-data issue. Distinct fallback text + a data attribute
        // the load-stats check below reads, so the two failure modes never
        // look identical.
        return `
      <div class="cell">
        <div class="imgwrap" style="border-color:${color}">
          <img src="${escapeHtml(c.imageUrl)}" data-had-url="1" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
          <div class="fallback" style="display:none;background:${color}">
            <div>${c.tier}</div><div class="fallback-note">⚠️ load failed</div>
          </div>
        </div>
        <div class="label">
          <span class="tierpill" style="background:${color}">${c.tier}</span>
          <span class="name">#${c.index} ${escapeHtml(c.name)}</span>
        </div>
      </div>`;
      }
      return `
      <div class="cell">
        <div class="imgwrap" style="border-color:${color}">
          <div class="fallback" style="display:flex;background:${color}">
            <div>${c.tier}</div><div class="fallback-note">no image saved</div>
          </div>
        </div>
        <div class="label">
          <span class="tierpill" style="background:${color}">${c.tier}</span>
          <span class="name">#${c.index} ${escapeHtml(c.name)}</span>
        </div>
      </div>`;
    }).join('');

    const html = `<!DOCTYPE html>
<html>
<head>
<style>
  html, body { margin: 0; padding: 0; background: #1a1a1a; font-family: Arial, Helvetica, sans-serif; }
  .header { color: #fff; text-align: center; padding: 14px 0 6px; font-size: 20px; font-weight: 900; }
  .grid { display: grid; grid-template-columns: repeat(${CG_COLS}, ${CG_CELL_W}px); justify-content: center; }
  .cell { width: ${CG_CELL_W}px; height: ${CG_CELL_H}px; box-sizing: border-box; padding: 6px; position: relative; }
  .imgwrap { width: 100%; height: 74%; border-radius: 8px; border: 3px solid; overflow: hidden; position: relative; background: #000; }
  .imgwrap img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .fallback { width: 100%; height: 100%; flex-direction: column; align-items: center; justify-content: center; color: #fff; font-size: 28px; font-weight: 900; gap: 4px; }
  .fallback-note { font-size: 11px; font-weight: 600; opacity: .85; }
  .label { display: flex; align-items: center; justify-content: center; gap: 6px; margin-top: 7px; }
  .tierpill { color: #fff; font-weight: 900; font-size: 14px; padding: 2px 8px; border-radius: 6px; flex-shrink: 0; text-shadow: 0 1px 2px rgba(0,0,0,.6); }
  .name { color: #fff; font-size: 13px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 120px; }
</style>
</head>
<body>
  <div class="header">🎴 Card Grid — Page ${page}/${totalPages}</div>
  <div class="grid">${cellsHtml}</div>
</body>
</html>`;

    const page_ = await client.pupBrowser.newPage();
    try {
      await page_.setViewport({ width, height, deviceScaleFactor: 1 });
      await page_.setContent(html, { waitUntil: 'load', timeout: CG_TIMEOUT_MS });

      // window's 'load' event only fires once every <img> has settled
      // (loaded or errored), so this reading is reliable right after
      // setContent resolves — no extra wait needed.
      const loadStats = await page_.evaluate(() => {
        const imgs = Array.from(document.querySelectorAll('img[data-had-url]'));
        let loaded = 0, failedToLoad = 0;
        imgs.forEach(img => {
          if (img.complete && img.naturalWidth > 0) loaded++;
          else failedToLoad++;
        });
        return { loaded, failedToLoad };
      });

      const buffer = await page_.screenshot({ type: 'png' });

      const media = new MessageMedia('image/png', buffer.toString('base64'), 'cardgrid.png');
      const chat = await safeGetChat(msg);
      if (!chat) return;

      const noUrlCount = cells.filter(c => !c.imageUrl).length;
      const statusParts = [`${loadStats.loaded}/${cells.length} loaded`];
      if (loadStats.failedToLoad) statusParts.push(`${loadStats.failedToLoad} had a saved image but failed to load (network/CDN issue)`);
      if (noUrlCount) statusParts.push(`${noUrlCount} have no image saved (.backfillimages or .editcard)`);

      const caption = `🎴 *Card Grid — Page ${page}/${totalPages}*\n${statusParts.join(' • ')}\n\nUse *.cg ${page < totalPages ? page + 1 : 1}* for the next page, or *.card [index]* to view one card in detail.`;
      await chat.sendMessage(media, { caption });
    } catch (err) {
      console.error('Card grid render error:', err.message);
      msg.reply('❌ Card grid render failed (likely a network timeout loading card art). Try again, or use *.col* for a text list in the meantime.');
    } finally {
      await page_.close().catch(() => {});
    }
  },
};
