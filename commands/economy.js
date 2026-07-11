const User = require('../models/User');
const { formatNum, formatCooldown, rand, pick } = require('../utils/helpers');

const SHOP_ITEMS = [
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
    const user = await User.findOrCreate(contact.id._serialized, contact.pushname);
    const now = Date.now();
    const cooldown = 24 * 60 * 60 * 1000;

    if (now - user.lastDaily < cooldown) {
      const remaining = cooldown - (now - user.lastDaily);
      return msg.reply(`⏳ Come back in *${formatCooldown(remaining)}* for your daily!`);
    }

    const reward = rand(400, 800);
    const orbReward = Math.random() > 0.7 ? 1 : 0;
    user.coins += reward;
    user.orbs += orbReward;
    user.lastDaily = now;
    await user.save();

    msg.reply(
      `🎁 *Daily Reward!*\n\n💰 +${reward} coins${orbReward ? '\n🔮 +1 orb (bonus!)' : ''}\n\nTotal: ${formatNum(user.coins)} coins`
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

  // .lottery
  async lottery(client, msg, args) {
    const contact = await msg.getContact();
    const user = await User.findOrCreate(contact.id._serialized);
    const ticket = 100;
    if (user.coins < ticket) return msg.reply(`❌ Lottery ticket costs 💰 ${ticket} coins.`);

    user.coins -= ticket;
    const win = Math.random();
    let result;
    if (win < 0.01) {
      result = { label: '🎰 JACKPOT!', gain: 50000 };
    } else if (win < 0.1) {
      result = { label: '🏆 Big Win!', gain: 5000 };
    } else if (win < 0.3) {
      result = { label: '✅ Small Win', gain: 300 };
    } else {
      result = { label: '❌ No Win', gain: 0 };
    }

    user.coins += result.gain;
    await user.save();
    msg.reply(`🎟️ *Lottery*\n\n${result.label}\n${result.gain > 0 ? `+${result.gain} coins` : 'Better luck next time!'}\nBalance: ${formatNum(user.coins)}`);
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
    const chat = await msg.getChat();
    if (!chat.isGroup) return msg.reply('❌ Group only.');
    const ids = chat.participants.map(p => p.id._serialized);
    const users = await User.find({ id: { $in: ids } }).sort({ coins: -1 }).limit(10);
    let text = `💰 *Group Rich List*\n\n`;
    users.forEach((u, i) => { text += `${i + 1}. ${u.name || u.id} — 💰 ${formatNum(u.coins)}\n`; });
    msg.reply(text);
  },

  // .profile
  async profile(client, msg, args) {
    const mentioned = await msg.getMentions();
    const contact = mentioned.length ? mentioned[0] : await msg.getContact();
    const user = await User.findOrCreate(contact.id._serialized, contact.pushname);

    msg.reply(
      `👤 *${contact.pushname}'s Profile*\n\n` +
      `📛 Name: ${user.name}\n🎂 Age: ${user.age || 'Not set'}\n📝 Bio: ${user.bio}\n` +
      `⚡ Level: ${user.level} (${user.xp} XP)\n💰 Coins: ${formatNum(user.coins)}\n🔮 Orbs: ${user.orbs}\n` +
      `🃏 Cards: ${user.cards.length}\n🏰 Guild: ${user.guildId || 'None'}\n` +
      `🏅 Title: ${user.profile.title}`
    );
  },

  // .edit — show editable fields
  async edit(client, msg, args) {
    msg.reply(`✏️ *Editable Profile Fields*\n\n.bio [your bio]\n.setage [age]\n\nMore options coming soon!`);
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
  async use(client, msg, args) {
    const contact = await msg.getContact();
    const itemName = args.join(' ');
    if (!itemName) return msg.reply('❌ Usage: .use [item name]');

    const user = await User.findOrCreate(contact.id._serialized);
    const idx = user.inventory.findIndex(i => i.toLowerCase() === itemName.toLowerCase());
    if (idx === -1) return msg.reply('❌ Item not in inventory.');

    user.inventory.splice(idx, 1);

    let effect = '';
    if (itemName === 'Health Potion') effect = '💊 HP restored!';
    else if (itemName === 'Orb Pack') { user.orbs += 3; effect = '🔮 Got 3 orbs!'; }
    else if (itemName === 'Lucky Charm') effect = '🍀 Drop rates boosted for 1 hour!';
    else if (itemName === 'Star Fragment') { user.stardust += 50; effect = '⭐ Got 50 stardust!'; }
    else effect = '✅ Used!';

    await user.save();
    msg.reply(`${effect}`);
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
    const user = await User.findOrCreate(contact.id._serialized);
    const now = Date.now();
    const cooldown = 30 * 60 * 1000;

    if (now - user.lastDig < cooldown) {
      return msg.reply(`⏳ You're tired! Come back in *${formatCooldown(cooldown - (now - user.lastDig))}*.`);
    }

    const loot = pick(DIG_LOOT);
    user.coins += loot.coins;
    user.lastDig = now;
    await user.save();

    if (loot.coins === 0) {
      msg.reply('⛏️ You dug for a while... and found *nothing*. Unlucky!');
    } else {
      msg.reply(`⛏️ You dug and found a *${loot.item}*!\n💰 +${loot.coins} coins`);
    }
  },

  // .fish
  async fish(client, msg, args) {
    const contact = await msg.getContact();
    const user = await User.findOrCreate(contact.id._serialized);
    const now = Date.now();
    const cooldown = 20 * 60 * 1000;

    if (now - user.lastFish < cooldown) {
      return msg.reply(`⏳ Fishing on cooldown! Come back in *${formatCooldown(cooldown - (now - user.lastFish))}*.`);
    }

    const loot = pick(FISH_LOOT);
    user.coins += loot.coins;
    user.lastFish = now;
    await user.save();
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
    const target = mentioned.length ? `@${mentioned[0].number}` : 'you';
    const line = pick(ROAST_LINES);
    msg.reply(`🔥 *Roasting ${target}*\n\n${line}`);
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
    const user = await User.findOrCreate(contact.id._serialized);
    const now = Date.now();
    const cooldown = 5 * 60 * 1000;

    if (now - user.lastBeg < cooldown) {
      return msg.reply(`❌ You already begged recently. Wait *${formatCooldown(cooldown - (now - user.lastBeg))}*.`);
    }

    const responses = [
      { text: 'A kind stranger gave you some coins!', coins: rand(10, 80) },
      { text: 'You begged on the street corner...', coins: rand(1, 30) },
      { text: 'Nobody cared.', coins: 0 },
      { text: 'A merchant took pity on you.', coins: rand(50, 100) },
    ];
    const res = pick(responses);
    user.coins += res.coins;
    user.lastBeg = now;
    await user.save();
    msg.reply(`🙏 ${res.text}\n${res.coins > 0 ? `+💰 ${res.coins} coins` : ''}`);
  },
};
