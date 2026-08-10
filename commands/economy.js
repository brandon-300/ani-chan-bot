const User = require('../models/User');
const Guild = require('../models/Guild');
const { CardCatalogue, OwnedCard } = require('../models/Card');
const { formatNum, formatCooldown, rand, pick, tierEmoji, mentionName, mentionTag, safeGetChat, safeGetQuotedMessage, isOwner, isMod, addXP, XP_REWARDS, boldSans, doubleStruck, encodeIdKey } = require('../utils/helpers');
const { battleGames } = require('./games');
const { checkAchievements, formatUnlockNotice, ACHIEVEMENTS } = require('../utils/achievements');
const { checkTitle, formatTitleUnlockNotice, titleLabel, TITLES } = require('../utils/titles');
const { MessageMedia } = require('whatsapp-web.js');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { uploadToCloud, deleteFromCloud, isCloudConfigured } = require('../utils/cloudinary');

// ─── Profile pictures (.setpic) ───────────────────────────────────────────────
// Processed locally with ffmpeg (resize/recompress), then uploaded to
// Cloudinary — nothing but the resulting URL + public_id goes in MongoDB, so
// this stays well clear of the 512MB Mongo storage cap regardless of how
// many users set a picture. Local files here are pure scratch space (input
// download + ffmpeg output) and get deleted right after upload.
const TMP = os.tmpdir();

function tmpFile(ext) {
  return path.join(TMP, `ani-chan_setpic_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`);
}

function runFfmpeg(inputPath, outputPath, outputOptions = []) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions(outputOptions)
      .output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

function cleanupFiles(...files) {
  for (const file of files) {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {}
  }
}

// Resolves either a directly-attached image (.setpic sent as the image's own
// caption) or a reply to one (.setpic sent as a reply to an earlier image) —
// same pattern commands/converter.js uses for .sticker.
async function getTargetMessage(msg) {
  if (!msg.hasQuotedMsg) return msg;
  try {
    const quoted = await safeGetQuotedMessage(msg);
    return quoted || msg;
  } catch (err) {
    console.error('getTargetMessage: quoted message fetch failed:', err.message);
    return 'ERROR';
  }
}

function mimeToExt(mime = '') {
  const m = mime.split(';')[0].toLowerCase();
  const map = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/heic': 'heic',
    'image/heif': 'heif',
  };
  return map[m] || 'jpg';
}

// Owner-gate for the testing command below — same pattern as
// commands/cardmanager.js's checkOwner. Reuses the isOwner already imported
// above.
async function checkOwner(msg) {
  const contact = await msg.getContact();
  if (!isOwner(contact.id._serialized)) {
    await msg.reply('❌ Only the bot owner can use this command.');
    return false;
  }
  return true;
}

// Simple block-style progress bar for .level/.xp.
function xpProgressBar(current, max, length = 12) {
  const filled = Math.max(0, Math.min(length, Math.round((current / max) * length)));
  return '█'.repeat(filled) + '░'.repeat(length - filled);
}

const SHOP_ITEMS = [
  { name: 'Pet Food', price: 100, emoji: '🍖', effect: "Feed your pet (-25% hunger) via .pet feed" },
  { name: 'Health Potion', price: 200, emoji: '🧪', effect: 'Restore HP in battles' },
  { name: 'Orb Pack', price: 500, emoji: '🔮', effect: 'Get 3 orbs' },
  { name: 'Lucky Charm', price: 800, emoji: '🍀', effect: 'Boost drop rates for 1 hour' },
  { name: 'Card Pack', price: 1000, emoji: '🎴', effect: 'Summon 3 random cards' },
  { name: 'Star Fragment', price: 1500, emoji: '⭐', effect: 'Convert to 50 stardust' },
  { name: 'VIP Badge', price: 5000, emoji: '👑', effect: 'Profile VIP badge' },
];

const DIG_LOOT = [
  { item: 'Old Coin', coins: 50 },
  { item: 'Rusty Sword', coins: 80 },
  { item: 'Gem Shard', coins: 150 },
  { item: 'Ancient Relic', coins: 300 },
  { item: 'Nothing', coins: 0 },
];

const FISH_LOOT = [
  { item: 'Small Fish', coins: 40 },
  { item: 'Medium Fish', coins: 80 },
  { item: 'Rare Fish', coins: 200 },
  { item: 'Treasure Chest', coins: 500 },
  { item: 'Old Boot', coins: 5 },
];

const ROAST_LINES = [
  "You're the human equivalent of a participation trophy.",
  "I've seen smarter decisions made by a vending machine.",
  "Your face makes onions cry.",
  "You're like a cloud — when you disappear, it's a beautiful day.",
  "I'd agree with you, but then we'd both be wrong.",
  "You have the personality of a wet sock.",
  "Somewhere out there, a village is missing their idiot.",
  "You're the human equivalent of a software bug that never gets fixed.",
  "Your face looks like it caught on fire and someone tried to put it out with a fork.",
  "You have the personality of expired yogurt left in the sun.",
  "Your brain cells are on permanent vacation.",
  "Somewhere out there, a tree is producing oxygen just to regret it.",
  "You're what happens when laziness breeds with stupidity.",
  "Your ideas are as fresh as week-old roadkill.",
  "You couldn't find your way out of a paper bag with a map and GPS.",
  "Your existence is a waste of perfectly good atoms.",
  "You're like a broken elevator — never going anywhere.",
  "Your fashion sense called; it wants its mistakes back.",
  "You have the charisma of a damp sponge.",
  "I'd explain it to you, but I left my crayons at home.",
  "Your logic is as sound as a house of cards in a hurricane.",
  "You're the reason warning labels exist on everyday items.",
  "Your common sense is on life support.",
  "You move slower than a snail on tranquilizers.",
  "Your presence makes paint dry faster out of boredom.",
  "You're as sharp as a bag of wet mice.",
  "Your contributions to society are negative numbers.",
  "You have the depth of a puddle after a light drizzle.",
  "I bet even your shadow tries to leave you.",
  "You're a few fries short of a Happy Meal and the whole damn order.",
  "Your ambition is as visible as a black cat in a coal mine.",
  "You couldn't organize a piss-up in a brewery.",
  "Your IQ is room temperature... in Antarctica.",
  "You're the human version of a participation trophy for losing.",
  "Your jokes are older than your grandparents and twice as dead.",
  "You have all the leadership skills of a headless chicken.",
  "Your decision-making is sponsored by bad choices.",
  "You're as useful as a chocolate teapot.",
  "Your social skills are in the negatives.",
  "I'd agree with you, but then we'd both be wrong... again.",
  "You're proof that not everyone should reproduce.",
  "Your vibe is 'abandoned building' energy.",
  "You bring nothing to the table except disappointment.",
  "Your wit is as quick as continental drift.",
  "You're the reason glue has 'do not eat' instructions.",
  "Your life is a series of unfortunate events without the charm.",
  "You have the enthusiasm of a wet blanket at a bonfire.",
  "Your potential died before it was born.",
  "You're as inspiring as a rainy Monday morning.",
  "You couldn't light up a room if you were on fire.",
  "Your memory is shorter than a goldfish with dementia.",
  "You're a walking 'do not disturb' sign for success.",
  "Your excuses are more creative than your actual work.",
  "You have the drive of a parked car with no engine.",
  "You're the human equivalent of background noise.",
  "Your talent is hiding in witness protection.",
  "You're why some people prefer talking to walls."
];

module.exports = {
  // .balance
  async balance(client, msg, args) {
    const contact = await msg.getContact();
    const user = await User.findOrCreate(contact.id._serialized, contact.pushname);
    msg.reply(
      `💳 *${contact.pushname}'s Balance*\n\n💰 Wallet: ${formatNum(user.coins)} coins\n🏦 Bank: ${formatNum(user.bank)} coins\n🔮 Orbs: ${user.orbs}\n✨ Stardust: ${user.stardust}`
    );
  },

  // .orbs
  async orbs(client, msg, args) {
    const contact = await msg.getContact();
    const user = await User.findOrCreate(contact.id._serialized);
    msg.reply(`🔮 You have *${user.orbs}* orbs.\n\nOrbs are used for card summons and special events!`);
  },

  // .ebal [@user]
  async ebal(client, msg, args) {
    const mentioned = await msg.getMentions();
    let target;
    if (mentioned.length) {
      target = mentioned[0];
    } else {
      target = await msg.getContact();
    }
    const user = await User.findOrCreate(target.id._serialized);
    msg.reply(`💳 *${target.pushname}'s Economy*\n\nWallet: 💰 ${formatNum(user.coins)}\nBank: 🏦 ${formatNum(user.bank)}\nOrbs: 🔮 ${user.orbs}\nLevel: ⚡ ${user.level}`);
  },

  // .daily
  async daily(client, msg, args) {
    const contact = await msg.getContact();
    await User.findOrCreate(contact.id._serialized, contact.pushname);

    const now = Date.now();
    const cooldown = 24 * 60 * 60 * 1000;
    const reward = 600;
    const orbReward = Math.random() > 0.7 ? 1 : 0;

    // Atomic: only succeeds if lastDaily is still outside the cooldown window,
    // preventing two near-simultaneous .daily calls from both paying out.
    const updated = await User.findOneAndUpdate(
      { id: contact.id._serialized, lastDaily: { $lt: now - cooldown } },
      { $inc: { coins: reward, orbs: orbReward }, $set: { lastDaily: now } },
      { new: true }
    );

    if (!updated) {
      const user = await User.findOne({ id: contact.id._serialized });
      const remaining = cooldown - (now - user.lastDaily);
      return msg.reply(`⏳ Come back in *${formatCooldown(remaining)}* for your daily!`);
    }

    const unlocked = await checkAchievements(contact.id._serialized);
    const xpResult = await addXP(contact.id._serialized, XP_REWARDS.daily);
    const newTitle = await checkTitle(contact.id._serialized);
    const xpLine = `\n⭐ +${XP_REWARDS.daily} XP${xpResult.levelUp ? ` — 🎉 Level up! You're now level ${xpResult.level}!` : ''}`;
    msg.reply(
      `🎁 *Daily Reward!*\n\n💰 +${reward} coins${orbReward ? '\n🔮 +1 orb (bonus!)' : ''}\n\nTotal: ${formatNum(updated.coins)} coins` + xpLine + formatUnlockNotice(unlocked) + formatTitleUnlockNotice(newTitle)
    );
  },

  // .withdraw [amount]
  async withdraw(client, msg, args) {
    const contact = await msg.getContact();
    const amount = parseInt(args[0]);
    if (!amount || amount < 1) return msg.reply('❌ Usage: .withdraw [amount]');

    const user = await User.findOrCreate(contact.id._serialized);
    if (user.bank < amount) return msg.reply(`❌ Not enough in bank. Bank: ${user.bank}`);
    user.bank -= amount;
    user.coins += amount;
    await user.save();
    msg.reply(`🏦 Withdrawn 💰 *${amount}* coins.\nWallet: ${formatNum(user.coins)} | Bank: ${formatNum(user.bank)}`);
  },

  // .deposit [amount]
  async deposit(client, msg, args) {
    const contact = await msg.getContact();
    const amount = parseInt(args[0]);
    if (!amount || amount < 1) return msg.reply('❌ Usage: .deposit [amount]');

    const user = await User.findOrCreate(contact.id._serialized);
    if (user.coins < amount) return msg.reply(`❌ Not enough coins. Wallet: ${user.coins}`);
    user.coins -= amount;
    user.bank += amount;
    await user.save();
    msg.reply(`🏦 Deposited 💰 *${amount}* coins.\nWallet: ${formatNum(user.coins)} | Bank: ${formatNum(user.bank)}`);
  },

  // .donate [@user] [amount]
  async donate(client, msg, args) {
    const contact = await msg.getContact();
    const mentioned = await msg.getMentions();
    if (!mentioned.length) return msg.reply('❌ Usage: .donate [@user] [amount]');
    const amount = parseInt(args[1]);
    if (!amount || amount < 1) return msg.reply('❌ Usage: .donate [@user] [amount]');

    const sender = await User.findOrCreate(contact.id._serialized);
    const receiver = await User.findOrCreate(mentioned[0].id._serialized);

    if (sender.coins < amount) return msg.reply('❌ Not enough coins.');
    sender.coins -= amount;
    receiver.coins += amount;
    await Promise.all([sender.save(), receiver.save()]);
    msg.reply(`💝 *${contact.pushname}* donated 💰 ${amount} coins to *${mentioned[0].pushname}*!`);
  },

async lottery(client, msg, args) {
    const contact = await msg.getContact();
    const user = await User.findOrCreate(contact.id._serialized);
    const ticket = 100;
    if (user.coins < ticket) return msg.reply(`❌ Lottery ticket costs 💰 ${ticket} coins.`);

    user.coins -= ticket;
    const win = Math.random();
    let result;
    if (win < 0.01) {
      result = { label: '🎰 JACKPOT!', gain: 50000, odds: '1%' };
    } else if (win < 0.1) {
      result = { label: '🏆 Big Win!', gain: 5000, odds: '9%' };
    } else if (win < 0.3) {
      result = { label: '✅ Small Win', gain: 300, odds: '20%' };
    } else {
      result = { label: '❌ No Win', gain: 0, odds: '70%' };
    }

    user.coins += result.gain;
    await user.save();

    const net = result.gain - ticket;
    const netLine = net > 0 ? `📈 Net: +${formatNum(net)} coins` : `📉 Net: -${formatNum(Math.abs(net))} coins`;

    msg.reply(
      `🎟️ *Lottery*\n\n` +
      `🎫 Ticket: -${ticket} coins\n` +
      `${result.label}${result.gain > 0 ? ` (+${formatNum(result.gain)} coins)` : ''}\n` +
      `${netLine}\n\n` +
      `Balance: ${formatNum(user.coins)}`
    );
  },

  // .rich — top 10 richest users
  async rich(client, msg, args) {
    const users = await User.find().sort({ coins: -1 }).limit(10);
    let text = `💰 *Richest Users*\n\n`;
    users.forEach((u, i) => {
      text += `${i + 1}. ${u.name || u.id} — 💰 ${formatNum(u.coins)}\n`;
    });
    msg.reply(text);
  },

  // .richg — richest in this group
  async richg(client, msg, args) {
    const chat = await safeGetChat(msg).catch(err => { console.error("getChat failed:", err.message); msg.reply("⚠️ WhatsApp connection hiccup — please try again in a moment."); return null; });
    if (!chat) return;
    if (!chat.isGroup) return msg.reply('❌ Group only.');
    const ids = chat.participants.map(p => p.id._serialized);
    const users = await User.find({ id: { $in: ids } }).sort({ coins: -1 }).limit(10);
    let text = `💰 *Group Rich List*\n\n`;
    users.forEach((u, i) => { text += `${i + 1}. ${u.name || u.id} — 💰 ${formatNum(u.coins)}\n`; });
    msg.reply(text);
  },

  // .profile
  async profile(client, msg, args) {
    // React first, then reply — a failed reaction (flaky connection) should
    // never block the actual profile reply.
    try {
      await msg.react('👤');
    } catch (err) {
      console.error('Profile react failed:', err.message);
    }

    const mentioned = await msg.getMentions();
    const contact = mentioned.length ? mentioned[0] : await msg.getContact();
    const targetId = contact.id._serialized;
    const user = await User.findOrCreate(targetId, contact.pushname);
    // Recheck in case the level changed since the title was last set (same
    // safety-net idea as .achievements re-checking on view). checkTitle
    // saves against its own fresh copy of the user, so if it changed
    // anything, mirror that onto the local `user` object too — otherwise
    // the profile below would print the title this same call just replaced.
    const refreshedTitle = await checkTitle(targetId);
    if (refreshedTitle) user.profile.title = titleLabel(refreshedTitle);

    let guildLabel = 'None';
    if (user.guildId) {
      const guild = await Guild.findById(user.guildId);
      if (guild) {
        guildLabel = `${guild.emblem} ${guild.name}`;
      } else {
        // Guild was disbanded/deleted but this user's record never got cleared.
        guildLabel = 'None';
        user.guildId = null;
        await user.save();
      }
    }

    // Role: bot-wide Owner/Mod (see isOwner/isMod in utils/helpers.js) takes
    // priority over being a WhatsApp admin in whichever group this was sent
    // in — which only applies at all when this was sent in a group, and only
    // reflects THAT group, not a bot-wide status.
    let role = 'User';
    if (isOwner(targetId)) {
      role = 'Owner';
    } else if (isMod(targetId)) {
      role = 'Mod';
    } else {
      const chat = await msg.getChat().catch(() => null);
      if (chat?.isGroup) {
        const participant = chat.participants.find(p => p.id._serialized === targetId);
        if (participant?.isAdmin || participant?.isSuperAdmin) role = 'Admin';
      }
    }

    const registered = new Date(user.createdAt)
      .toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

    // BUGFIX (Aug 2026): this used to read user.cards.length — a field
    // that's declared on the User schema but that nothing in the codebase
    // ever writes to (not .claim, not .sc, not .tc/accepttrade), so it was
    // permanently stuck at 0 regardless of how many cards someone actually
    // owned. The real source of truth for ownership is the OwnedCard
    // collection (same place .col and .cg read from), so count from there
    // instead.
    const cardCount = await OwnedCard.countDocuments({ ownerId: targetId });

    const line = (label, value) => `ꕥ ${boldSans(label)}: ${value}`;

    const card = [
      `╭━━━★彡 ${doubleStruck('PROFILE')} 彡★━━━╮`,
      '',
      line('Name', user.name),
      line('Age', user.age || 'Not set'),
      line('Bio', user.bio),
      line('Registered', registered),
      line('Role', role),
      line('Guild', guildLabel),
      line('Level', `${user.level} (${user.xp} XP)`),
      line('Coins', formatNum(user.coins)),
      line('Orbs', user.orbs),
      line('Cards', cardCount),
      line('Title', user.profile.title),
    ].join('\n');

    // If they've set a profile picture (.setpic), send it as an actual
    // image with the card as the caption — otherwise fall back to the plain
    // text version, same as it's always worked.
    if (user.profile.picUrl) {
      try {
        const media = await MessageMedia.fromUrl(user.profile.picUrl, { unsafeMime: true });
        const chat = await safeGetChat(msg);
        return await chat.sendMessage(media, { caption: card });
      } catch (err) {
        console.error('profile pic send failed, falling back to text:', err.message);
      }
    }

    msg.reply(card);
  },

// .edit — show editable fields
  async edit(client, msg, args) {
    msg.reply(`✏️ *Editable Profile Fields*\n\n.setname [name]\n.bio [your bio]\n.setage [age]\n\nMore options coming soon!`);
  },

  // .setname [name]
  async setname(client, msg, args) {
    const contact = await msg.getContact();
    const name = args.join(' ');
    if (!name) return msg.reply('❌ Usage: .setname [name]');
    if (name.length > 30) return msg.reply('❌ Name must be 30 characters or less.');
    const user = await User.findOrCreate(contact.id._serialized);
    user.name = name;
    await user.save();
    msg.reply(`✅ Name set to *${name}*!`);
  },

  // .bio [bio]
  async bio(client, msg, args) {
    const contact = await msg.getContact();
    const bio = args.join(' ');
    if (!bio) return msg.reply('❌ Usage: .bio [your bio]');
    if (bio.length > 150) return msg.reply('❌ Bio must be 150 characters or less.');
    const user = await User.findOrCreate(contact.id._serialized);
    user.bio = bio;
    await user.save();
    msg.reply('✅ Bio updated!');
  },

  // .setage [age]
  async setage(client, msg, args) {
    const contact = await msg.getContact();
    const age = parseInt(args[0]);
    if (!age || age < 1 || age > 120) return msg.reply('❌ Invalid age.');
    const user = await User.findOrCreate(contact.id._serialized);
    user.age = age;
    await user.save();
    msg.reply('✅ Age updated!');
  },

  // .inventory
  async inventory(client, msg, args) {
    const contact = await msg.getContact();
    const user = await User.findOrCreate(contact.id._serialized);
    if (!user.inventory.length) return msg.reply('🎒 Your inventory is empty.');

    const counts = {};
    user.inventory.forEach(item => { counts[item] = (counts[item] || 0) + 1; });
    let text = `🎒 *Your Inventory*\n\n`;
    Object.entries(counts).forEach(([item, count]) => { text += `• ${item} x${count}\n`; });
    msg.reply(text);
  },

  // .use [item]
// .use [item]
  async use(client, msg, args) {
    const contact = await msg.getContact();
    const itemName = args.join(' ');
    if (!itemName) return msg.reply('❌ Usage: .use [item name]');

    const user = await User.findOrCreate(contact.id._serialized);
    const idx = user.inventory.findIndex(i => i.toLowerCase() === itemName.toLowerCase());
    if (idx === -1) return msg.reply('❌ Item not in inventory.');

    // Use the item's canonical stored name, not whatever casing the user typed,
    // so the effect below always matches correctly.
    const matchedName = user.inventory[idx];
    user.inventory.splice(idx, 1);

    let effect = '';
    let refund = false;

    if (matchedName === 'Health Potion') {
      const chat = await safeGetChat(msg).catch(err => { console.error("getChat failed:", err.message); msg.reply("⚠️ WhatsApp connection hiccup — please try again in a moment."); return null; });
      if (!chat) return;
      const game = battleGames.get(chat.id._serialized);
      const inBattle = game && (game.p1.id === contact.id._serialized || game.p2.id === contact.id._serialized);
      if (!inBattle) {
        effect = '💊 No active battle here for you. Health Potion only works during a .startbattle fight!';
        refund = true;
      } else {
        const player = game.p1.id === contact.id._serialized ? game.p1 : game.p2;
        const healed = Math.min(30, 100 - player.hp);
        player.hp += healed;
        battleGames.set(chat.id._serialized, game);
        effect = `💊 Healed +${healed} HP! (${player.hp}/100 HP)`;
      }
    } else if (matchedName === 'Orb Pack') {
      user.orbs += 3;
      effect = '🔮 Got 3 orbs!';
    } else if (matchedName === 'Lucky Charm') {
      effect = '🍀 Drop rates boosted for 1 hour!';
    } else if (matchedName === 'Card Pack') {
      const picks = await CardCatalogue.aggregate([{ $sample: { size: 3 } }]);
      if (!picks.length) {
        effect = '❌ No cards available in the catalogue right now.';
        refund = true;
      } else {
        const gained = [];
        for (const c of picks) {
          await OwnedCard.create({
            ownerId: contact.id._serialized,
            // catalogueId must be the 6-char CardCatalogue.cardId, not the
            // Mongo _id — every join (.col, .cg, .ci) looks cards up via
            // `CardCatalogue.findOne({ cardId: owned.catalogueId })`, so
            // storing c._id here silently broke images/series lookups for
            // anything pulled from a Card Pack specifically.
            catalogueId: c.cardId,
            name: c.name,
            series: c.series,
            tier: c.tier,
          });
          gained.push(`${tierEmoji(c.tier)} ${c.name} [${c.tier}]`);
        }
        effect = `🎴 *Card Pack opened!*\n\n${gained.join('\n')}`;
      }
    } else if (matchedName === 'Star Fragment') {
      user.stardust += 50;
      effect = '⭐ Got 50 stardust!';
    } else if (matchedName === 'Pet Food') {
      // Pet Food is consumed automatically by .pet feed itself (it checks
      // and removes it from inventory directly) rather than through this
      // generic .use command, so it can be paired with feeding in one step.
      // Refund it here rather than letting .use silently burn it with no
      // effect.
      effect = "🍖 Use *.pet feed* to feed this to your pet — it's consumed automatically from there, not through .use.";
      refund = true;
    } else {
      effect = '✅ Used!';
    }

    if (refund) user.inventory.push(matchedName);
    await user.save();
    msg.reply(effect);
  },

  // .sell [item]
  async sell(client, msg, args) {
    const contact = await msg.getContact();
    const itemName = args.join(' ');
    if (!itemName) return msg.reply('❌ Usage: .sell [item name]');

    const user = await User.findOrCreate(contact.id._serialized);
    const idx = user.inventory.findIndex(i => i.toLowerCase() === itemName.toLowerCase());
    if (idx === -1) return msg.reply('❌ Item not found.');

    const shopItem = SHOP_ITEMS.find(s => s.name.toLowerCase() === itemName.toLowerCase());
    const sellPrice = shopItem ? Math.floor(shopItem.price * 0.5) : 50;

    user.inventory.splice(idx, 1);
    user.coins += sellPrice;
    await user.save();
    msg.reply(`✅ Sold *${itemName}* for 💰 ${sellPrice} coins.`);
  },

  // .shop
  async shop(client, msg, args) {
    let text = `🛍️ *Ani-Chan Bot Shop*\n\n`;
    SHOP_ITEMS.forEach((item, i) => {
      text += `${i + 1}. ${item.emoji} *${item.name}*\n   💰 ${item.price} coins — ${item.effect}\n\n`;
    });
    text += `Type *.buy [item name]* to purchase!`;
    msg.reply(text);
  },

  // .buy [item]
  async buy(client, msg, args) {
    const contact = await msg.getContact();
    const itemName = args.join(' ');
    const item = SHOP_ITEMS.find(s => s.name.toLowerCase() === itemName.toLowerCase());
    if (!item) return msg.reply('❌ Item not found. Use .shop to see available items.');

    const user = await User.findOrCreate(contact.id._serialized);
    if (user.coins < item.price) return msg.reply(`❌ Not enough coins. Need 💰 ${item.price}.`);

    user.coins -= item.price;
    user.inventory.push(item.name);
    await user.save();
    msg.reply(`✅ Bought ${item.emoji} *${item.name}*!\nBalance: 💰 ${formatNum(user.coins)}`);
  },

  // .dig
  async dig(client, msg, args) {
    const contact = await msg.getContact();
    await User.findOrCreate(contact.id._serialized);

    const now = Date.now();
    const cooldown = 30 * 60 * 1000;
    const loot = pick(DIG_LOOT);

    const updated = await User.findOneAndUpdate(
      { id: contact.id._serialized, lastDig: { $lt: now - cooldown } },
      { $inc: { coins: loot.coins }, $set: { lastDig: now } },
      { new: true }
    );

    if (!updated) {
      const user = await User.findOne({ id: contact.id._serialized });
      return msg.reply(`⏳ You're tired! Come back in *${formatCooldown(cooldown - (now - user.lastDig))}*.`);
    }

    if (loot.coins === 0) {
      msg.reply('⛏️ You dug for a while... and found *nothing*. Unlucky!');
    } else {
      msg.reply(`⛏️ You dug and found a *${loot.item}*!\n💰 +${loot.coins} coins`);
    }
  },

  // .fish
  async fish(client, msg, args) {
    const contact = await msg.getContact();
    await User.findOrCreate(contact.id._serialized);

    const now = Date.now();
    const cooldown = 20 * 60 * 1000;
    const loot = pick(FISH_LOOT);

    const updated = await User.findOneAndUpdate(
      { id: contact.id._serialized, lastFish: { $lt: now - cooldown } },
      { $inc: { coins: loot.coins }, $set: { lastFish: now } },
      { new: true }
    );

    if (!updated) {
      const user = await User.findOne({ id: contact.id._serialized });
      return msg.reply(`⏳ Fishing on cooldown! Come back in *${formatCooldown(cooldown - (now - user.lastFish))}*.`);
    }

    msg.reply(`🎣 You cast your line and caught a *${loot.item}*!\n💰 +${loot.coins} coins`);
  },

  // .leaderboard
  async leaderboard(client, msg, args) {
    const users = await User.find().sort({ level: -1, coins: -1 }).limit(10);
    let text = `🏆 *Leaderboard*\n\n`;
    users.forEach((u, i) => {
      text += `${i + 1}. ${u.name || 'Unknown'} — ⚡ Lv.${u.level} | 💰 ${formatNum(u.coins)}\n`;
    });
    msg.reply(text);
  },

  // .roast
  async roast(client, msg, args) {
    const mentioned = await msg.getMentions();
    const target = mentioned.length ? `@${mentionTag(mentioned[0])}` : 'you';
    const line = pick(ROAST_LINES);
    msg.reply(
      `🔥 *Roasting ${target}*\n\n${line}`,
      undefined,
      mentioned.length ? { mentions: [mentioned[0].id._serialized] } : undefined
    );
  },

  // .gamble [amount]
  async gamble(client, msg, args) {
    const contact = await msg.getContact();
    const amount = parseInt(args[0]);
    if (!amount || amount < 10) return msg.reply('❌ Minimum gamble is 10 coins. Usage: .gamble [amount]');

    const user = await User.findOrCreate(contact.id._serialized);
    if (user.coins < amount) return msg.reply('❌ Not enough coins.');

    const win = Math.random() > 0.5;
    user.coins += win ? amount : -amount;
    await user.save();
    msg.reply(
      win
        ? `🎲 *You won!* 🎉\n+💰 ${amount} coins\nBalance: ${formatNum(user.coins)}`
        : `🎲 *You lost.* 😢\n-💰 ${amount} coins\nBalance: ${formatNum(user.coins)}`
    );
  },

  // .beg
  async beg(client, msg, args) {
    const contact = await msg.getContact();
    await User.findOrCreate(contact.id._serialized);

    const now = Date.now();
    const cooldown = 5 * 60 * 1000;

    const responses = [
      { text: 'A kind stranger gave you some coins!', coins: rand(10, 80) },
      { text: 'You begged on the street corner...', coins: rand(1, 30) },
      { text: 'Nobody cared.', coins: 0 },
      { text: 'A merchant took pity on you.', coins: rand(50, 100) },
    ];
    const res = pick(responses);

    const updated = await User.findOneAndUpdate(
      { id: contact.id._serialized, lastBeg: { $lt: now - cooldown } },
      { $inc: { coins: res.coins }, $set: { lastBeg: now } },
      { new: true }
    );

    if (!updated) {
      const user = await User.findOne({ id: contact.id._serialized });
      return msg.reply(`❌ You already begged recently. Wait *${formatCooldown(cooldown - (now - user.lastBeg))}*.`);
    }

    msg.reply(`🙏 ${res.text}\n${res.coins > 0 ? `+💰 ${res.coins} coins` : ''}`);
  },

  // .achievements / .ach — list unlocked and locked achievements
  async achievements(client, msg, args) {
    const contact = await msg.getContact();
    // Recheck first, in case something changed since the last time a
    // triggering command ran (e.g. cards acquired outside .claim/.accepttrade).
    await checkAchievements(contact.id._serialized);
    const user = await User.findOrCreate(contact.id._serialized, contact.pushname);
    const unlockedIds = new Set(user.achievements || []);

    let text = `🏅 *Achievements* (${unlockedIds.size}/${ACHIEVEMENTS.length})\n\n`;
    for (const a of ACHIEVEMENTS) {
      const done = unlockedIds.has(a.id);
      text += `${done ? '✅' : '🔒'} ${a.emoji} *${a.name}* — ${a.desc}\n`;
    }
    msg.reply(text);
  },

  // .ach alias
  async ach(client, msg, args) {
    return module.exports.achievements(client, msg, args);
  },

  // .level / .xp — current level, XP progress toward the next level, current
  // title, and how far off the next title tier is. Add @mention to check
  // someone else's.
  async level(client, msg, args) {
    const mentioned = await msg.getMentions();
    const contact = mentioned.length ? mentioned[0] : await msg.getContact();
    const targetId = contact.id._serialized;
    const user = await User.findOrCreate(targetId, contact.pushname);

    const needed = user.level * 100;
    const bar = xpProgressBar(user.xp, needed);
    const pct = Math.floor((user.xp / needed) * 100);

    const nextTitle = TITLES.find(t => t.minLevel > user.level);
    const nextTitleLine = nextTitle
      ? `\n🔒 Next title: ${nextTitle.emoji} ${nextTitle.name} at level ${nextTitle.minLevel} (${nextTitle.minLevel - user.level} to go)`
      : `\n👑 You've hit the highest title tier!`;

    msg.reply(
      `⚡ *Level ${user.level}*${mentioned.length ? ` — ${contact.pushname}` : ''}\n\n` +
      `${bar} ${pct}%\n` +
      `${user.xp} / ${needed} XP\n\n` +
      `🎖️ Title: ${user.profile.title}` +
      nextTitleLine,
      undefined,
      mentioned.length ? { mentions: [targetId] } : undefined
    );
  },

  // .xp alias
  async xp(client, msg, args) {
    return module.exports.level(client, msg, args);
  },

  // .addxp <amount> [@mention] — owner-only. Grants XP directly so you can
  // verify level-ups and title unlocks immediately, instead of repeatedly
  // claiming/daily-ing to accumulate enough naturally.
  async addxp(client, msg, args) {
    if (!(await checkOwner(msg))) return;

    const amount = parseInt(args[0]);
    if (!amount || amount <= 0) {
      return msg.reply('Usage:\n.addxp <amount> [@mention]\n\nGrants XP directly — testing tool for checking level-ups and title unlocks.');
    }

    const mentioned = await msg.getMentions();
    const contact = mentioned.length ? mentioned[0] : await msg.getContact();
    const targetId = contact.id._serialized;
    await User.findOrCreate(targetId, contact.pushname);

    const xpResult = await addXP(targetId, amount);
    const newTitle = await checkTitle(targetId);

    msg.reply(
      `🧪 Granted ${amount} XP to @${targetId.split('@')[0]}.\n` +
      `${xpResult.levelUp ? `🎉 Leveled up to *${xpResult.level}*!` : `Still level ${xpResult.level}.`}` +
      formatTitleUnlockNotice(newTitle),
      undefined,
      { mentions: [targetId] }
    );
  },

  // .setpic — reply to a photo (or send one with .setpic as the caption) to
  // set it as your profile picture. Downscaled/recompressed with ffmpeg
  // (already a project dependency via .sticker) to a fixed 512x512 JPEG —
  // keeps it small and consistent regardless of what format/size came in,
  // without needing sharp/jimp/canvas, none of which build on this Termux
  // setup. Saved to disk under data/profile_pics/, overwriting any previous
  // picture; only the file path is stored in Mongo.
  async setpic(client, msg, args) {
    if (!isCloudConfigured()) {
      return msg.reply('⚠️ Profile pictures aren\'t set up yet — Cloudinary credentials are missing from .env. Ask the bot owner to finish setup.');
    }

    const targetMsg = await getTargetMessage(msg);
    if (targetMsg === 'ERROR') return msg.reply('⚠️ WhatsApp connection hiccup — please try again in a moment.');
    if (!targetMsg.hasMedia) {
      return msg.reply('❌ Reply to a photo with .setpic (or send a photo with .setpic as the caption).');
    }

    const media = await targetMsg.downloadMedia().catch(() => null);
    if (!media) return msg.reply('❌ Failed to download that image — try again.');
    if (!media.mimetype.startsWith('image/')) {
      return msg.reply('❌ That\'s not an image — .setpic only works on photos.');
    }

    const contact = await msg.getContact();
    const userId = contact.id._serialized;
    await User.findOrCreate(userId, contact.pushname);

    await msg.reply('🖼️ Processing and uploading your profile picture...');

    const inputExt = mimeToExt(media.mimetype);
    const inputPath = tmpFile(inputExt);
    const outputPath = tmpFile('jpg');

    try {
      fs.writeFileSync(inputPath, Buffer.from(media.data, 'base64'));
      await runFfmpeg(inputPath, outputPath, [
        '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white',
        '-frames:v', '1', // in case it's an animated image — just take the first frame
        '-q:v', '4',      // JPEG quality, roughly equivalent to ~80%
      ]);

      const { url, publicId } = await uploadToCloud(outputPath, {
        folder: 'anichan/profile_pics',
        publicId: encodeIdKey(userId), // same id every time -> overwrites their old picture instead of piling up
        resourceType: 'image',
      });

      await User.updateOne({ id: userId }, { $set: { 'profile.picUrl': url, 'profile.picPublicId': publicId } });
      msg.reply('✅ Profile picture updated! Check it with .profile.');
    } catch (err) {
      console.error('setpic error:', err.message);
      msg.reply('❌ Could not set that as your profile picture — try again in a moment.');
    } finally {
      cleanupFiles(inputPath, outputPath);
    }
  },

  // .removepic — clears your profile picture, if you have one set.
  async removepic(client, msg, args) {
    const contact = await msg.getContact();
    const userId = contact.id._serialized;
    const user = await User.findOrCreate(userId, contact.pushname);

    if (!user.profile.picUrl) return msg.reply('❌ You don\'t have a profile picture set.');

    await deleteFromCloud(user.profile.picPublicId);
    await User.updateOne({ id: userId }, { $set: { 'profile.picUrl': '', 'profile.picPublicId': '' } });

    msg.reply('🗑 Profile picture removed.');
  },
};
