const User = require('../models/User');
const { rand, pick, formatNum } = require('../utils/helpers');

// ─── Slots ────────────────────────────────────────────────────────────────────
const SLOT_SYMBOLS = ['🍒', '🍋', '🍊', '🍇', '⭐', '💎', '7️⃣'];
const SLOT_WEIGHTS = [30, 25, 20, 15, 5, 3, 2]; // % chance

function spinSlots() {
  const pick = (weights) => {
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r < 0) return SLOT_SYMBOLS[i];
    }
    return SLOT_SYMBOLS[0];
  };
  return [pick(SLOT_WEIGHTS), pick(SLOT_WEIGHTS), pick(SLOT_WEIGHTS)];
}

function slotsMultiplier(reels) {
  const [a, b, c] = reels;
  if (a === b && b === c) {
    if (a === '7️⃣') return 50;
    if (a === '💎') return 20;
    if (a === '⭐') return 10;
    return 5;
  }
  if (a === b || b === c || a === c) return 1.5;
  return 0;
}

// ─── Roulette ─────────────────────────────────────────────────────────────────
const ROULETTE_NUMS = Array.from({ length: 37 }, (_, i) => i); // 0-36
const RED_NUMS = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];

// ─── Horse ───────────────────────────────────────────────────────────────────
const HORSES = [
  { name: 'Thunder', emoji: '🐎', odds: 2 },
  { name: 'Storm', emoji: '🦄', odds: 3 },
  { name: 'Blaze', emoji: '🐴', odds: 5 },
  { name: 'Shadow', emoji: '🏇', odds: 8 },
  { name: 'Eclipse', emoji: '⚡', odds: 15 },
];

module.exports = {
  // .slots [amount]
  async slots(client, msg, args) {
    const contact = await msg.getContact();
    const amount = parseInt(args[0]) || 50;
    if (amount < 10) return msg.reply('❌ Minimum bet is 10 coins.');

    const user = await User.findOrCreate(contact.id._serialized);
    if (user.coins < amount) return msg.reply(`❌ Not enough coins. You have 💰 ${user.coins}.`);

    user.coins -= amount;
    const reels = spinSlots();
    const mult = slotsMultiplier(reels);
    const winnings = Math.floor(amount * mult);
    user.coins += winnings;
    await user.save();

    const display = `[ ${reels.join(' | ')} ]`;
    if (mult === 0) {
      msg.reply(`🎰 *Slots*\n\n${display}\n\n❌ No match! Lost 💰 ${amount}\nBalance: ${formatNum(user.coins)}`);
    } else if (mult >= 10) {
      msg.reply(`🎰 *JACKPOT!* 🎉🎉🎉\n\n${display}\n\n${mult}x multiplier!\n+💰 ${winnings} coins!\nBalance: ${formatNum(user.coins)}`);
    } else {
      msg.reply(`🎰 *Slots*\n\n${display}\n\n✅ ${mult}x win! +💰 ${winnings}\nBalance: ${formatNum(user.coins)}`);
    }
  },

  // .cf [amount] — coin flip
  async cf(client, msg, args) {
    const contact = await msg.getContact();
    const amount = parseInt(args[0]);
    if (!amount || amount < 1) return msg.reply('❌ Usage: .cf [amount]');

    const user = await User.findOrCreate(contact.id._serialized);
    if (user.coins < amount) return msg.reply('❌ Not enough coins.');

    const heads = Math.random() > 0.5;
    user.coins += heads ? amount : -amount;
    await user.save();

    msg.reply(
      `🪙 *Coin Flip*\n\n${heads ? '🟡 HEADS — You win!' : '⚫ TAILS — You lose!'}\n${heads ? `+💰 ${amount}` : `-💰 ${amount}`}\nBalance: ${formatNum(user.coins)}`
    );
  },

  // .dice [amount]
  async dice(client, msg, args) {
    const contact = await msg.getContact();
    const amount = parseInt(args[0]) || 100;
    const user = await User.findOrCreate(contact.id._serialized);
    if (user.coins < amount) return msg.reply('❌ Not enough coins.');

    const myRoll = rand(1, 6);
    const botRoll = rand(1, 6);
    const win = myRoll > botRoll;
    const draw = myRoll === botRoll;

    if (!draw) user.coins += win ? amount : -amount;
    await user.save();

    msg.reply(
      `🎲 *Dice*\n\nYou rolled: *${myRoll}*\nBot rolled: *${botRoll}*\n\n${draw ? '🤝 Draw! No coins lost.' : win ? `🏆 You win! +💰 ${amount}` : `😢 You lose! -💰 ${amount}`}\nBalance: ${formatNum(user.coins)}`
    );
  },

  // .db [amount] — double or bust
  async db(client, msg, args) {
    const contact = await msg.getContact();
    const amount = parseInt(args[0]);
    if (!amount || amount < 1) return msg.reply('❌ Usage: .db [amount]');

    const user = await User.findOrCreate(contact.id._serialized);
    if (user.coins < amount) return msg.reply('❌ Not enough coins.');

    const win = Math.random() > 0.5;
    user.coins += win ? amount * 2 : -amount;
    await user.save();

    msg.reply(
      win
        ? `💥 *Double!* +💰 ${amount * 2}\nBalance: ${formatNum(user.coins)}`
        : `💥 *Bust!* -💰 ${amount}\nBalance: ${formatNum(user.coins)}`
    );
  },

  // .dp [amount] — double or pass (lower risk, lower reward)
  async dp(client, msg, args) {
    const contact = await msg.getContact();
    const amount = parseInt(args[0]);
    if (!amount || amount < 1) return msg.reply('❌ Usage: .dp [amount]');

    const user = await User.findOrCreate(contact.id._serialized);
    if (user.coins < amount) return msg.reply('❌ Not enough coins.');

    const r = Math.random();
    let result;
    if (r < 0.45) result = { label: '✅ Double', gain: amount };
    else if (r < 0.75) result = { label: '➡️ Pass', gain: Math.floor(amount * 0.5) };
    else result = { label: '❌ Bust', gain: -amount };

    user.coins += result.gain;
    await user.save();
    msg.reply(`🎯 *Double or Pass*\n\n${result.label}\n${result.gain >= 0 ? '+' : ''}💰 ${result.gain}\nBalance: ${formatNum(user.coins)}`);
  },

  // .roulette [amount] [bet_type]
  async roulette(client, msg, args) {
    const contact = await msg.getContact();
    const amount = parseInt(args[0]);
    const betType = args[1]?.toLowerCase() || 'red';

    if (!amount || amount < 1) return msg.reply('❌ Usage: .roulette [amount] [red/black/even/odd/number]');

    const user = await User.findOrCreate(contact.id._serialized);
    if (user.coins < amount) return msg.reply('❌ Not enough coins.');

    const spinNum = pick(ROULETTE_NUMS);
    const isRed = RED_NUMS.includes(spinNum);
    const isBlack = spinNum !== 0 && !isRed;
    const isEven = spinNum !== 0 && spinNum % 2 === 0;
    const isOdd = spinNum % 2 !== 0;
    const color = spinNum === 0 ? '🟩' : isRed ? '🔴' : '⚫';

    let win = false;
    let mult = 2;

    if (betType === 'red' && isRed) win = true;
    else if (betType === 'black' && isBlack) win = true;
    else if (betType === 'even' && isEven) win = true;
    else if (betType === 'odd' && isOdd) win = true;
    else if (!isNaN(parseInt(betType)) && parseInt(betType) === spinNum) { win = true; mult = 35; }

    const gain = win ? amount * mult : -amount;
    user.coins += gain;
    await user.save();

    msg.reply(
      `🎡 *Roulette*\n\nBall landed on: ${color} *${spinNum}*\nYour bet: ${betType} — ${win ? '✅ WIN' : '❌ LOSE'}\n${gain >= 0 ? '+' : ''}💰 ${gain}\nBalance: ${formatNum(user.coins)}`
    );
  },

  // .horse [horse_number] [amount]
  async horse(client, msg, args) {
    const contact = await msg.getContact();
    const pick_num = parseInt(args[0]);
    const amount = parseInt(args[1]) || 100;

    if (!pick_num || pick_num < 1 || pick_num > HORSES.length) {
      let text = `🏇 *Horse Racing*\n\nChoose a horse:\n\n`;
      HORSES.forEach((h, i) => { text += `${i + 1}. ${h.emoji} ${h.name} — ${h.odds}x odds\n`; });
      text += `\nUsage: *.horse [1-5] [amount]*`;
      return msg.reply(text);
    }

    const user = await User.findOrCreate(contact.id._serialized);
    if (user.coins < amount) return msg.reply('❌ Not enough coins.');

    user.coins -= amount;

    // Weight: lower odds = more likely to win
    const winnerIdx = HORSES.reduce((best, horse, i) => {
      const score = Math.random() / horse.odds;
      return score > best.score ? { idx: i, score } : best;
    }, { idx: 0, score: 0 }).idx;

    const winner = HORSES[winnerIdx];
    const chosen = HORSES[pick_num - 1];
    const win = winnerIdx === pick_num - 1;

    if (win) {
      const prize = amount * chosen.odds;
      user.coins += prize;
    }
    await user.save();

    msg.reply(
      `🏇 *Horse Race!*\n\n${HORSES.map((h, i) => `${h.emoji} ${h.name}${i === winnerIdx ? ' 🏆' : ''}`).join('\n')}\n\n${win ? `🎉 Your horse *${chosen.name}* won!\n+💰 ${amount * chosen.odds}` : `😢 *${winner.name}* won. You lost 💰 ${amount}`}\nBalance: ${formatNum(user.coins)}`
    );
  },
};
