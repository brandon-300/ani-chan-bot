const User = require('../models/User');
const { formatCooldown, pick, rollTier, tierEmoji } = require('../utils/helpers');

// ─── Pet Catalogue ──────────────────────────────────────────────────────────
// Anime-themed companions, grouped on the exact same C/B/A/S/SS/SSS rarity
// scale (and odds table, via rollTier) as the card system, so a random
// ".pet adopt" pull feels consistent with a card pull.
//
// SSS is reserved for the nine Tailed Beasts from Naruto — deliberately the
// rarest and most expensive pets in the game, matching how godlike they are
// in-universe. Everything else is a real anime/game companion creature,
// ramping up in fame/power as rarity increases.
const PET_CATALOGUE = {
  C: [
    { emoji: '🐱', name: 'Cat', series: 'Generic Companion' },
    { emoji: '🐶', name: 'Dog', series: 'Generic Companion' },
    { emoji: '🐰', name: 'Rabbit', series: 'Generic Companion' },
    { emoji: '🦊', name: 'Fox', series: 'Generic Companion' },
    { emoji: '🐸', name: 'Frog', series: 'Generic Companion' },
    { emoji: '🐧', name: 'Penguin', series: 'Generic Companion' },
    { emoji: '🐹', name: 'Hamster', series: 'Generic Companion' },
    { emoji: '🦉', name: 'Owl', series: 'Generic Companion' },
  ],
  B: [
    { emoji: '⚡', name: 'Pikachu', series: 'Pokémon' },
    { emoji: '🐧', name: 'Piplup', series: 'Pokémon' },
    { emoji: '🐱', name: 'Happy', series: 'Fairy Tail' },
    { emoji: '🧸', name: 'Kon', series: 'Bleach' },
    { emoji: '🐈', name: 'Jiji', series: "Kiki's Delivery Service" },
    { emoji: '🐾', name: 'Puar', series: 'Dragon Ball' },
    { emoji: '🐕', name: 'Plue', series: 'Fairy Tail' },
    { emoji: '🦁', name: 'Kero-chan', series: 'Cardcaptor Sakura' },
  ],
  A: [
    { emoji: '🐕', name: 'Akamaru', series: 'Naruto' },
    { emoji: '🐾', name: 'Pakkun', series: 'Naruto' },
    { emoji: '🦖', name: 'Agumon', series: 'Digimon' },
    { emoji: '🔥', name: 'Charizard', series: 'Pokémon' },
    { emoji: '🐺', name: 'Lucario', series: 'Pokémon' },
    { emoji: '🦮', name: 'Cerberus', series: 'Cardcaptor Sakura' },
  ],
  S: [
    { emoji: '🐸', name: 'Gamabunta', series: 'Naruto — Toad Boss' },
    { emoji: '🐌', name: 'Katsuyu', series: 'Naruto — Slug Boss' },
    { emoji: '🐅', name: 'Byakko', series: 'Guardian Beasts — White Tiger' },
    { emoji: '🐦', name: 'Suzaku', series: 'Guardian Beasts — Vermillion Bird' },
    { emoji: '🐉', name: 'Seiryu', series: 'Guardian Beasts — Azure Dragon' },
    { emoji: '🐢', name: 'Genbu', series: 'Guardian Beasts — Black Tortoise' },
  ],
  SS: [
    { emoji: '🐍', name: 'Manda', series: 'Naruto — Snake Boss' },
    { emoji: '🐲', name: 'Haku', series: 'Spirited Away' },
    { emoji: '🧬', name: 'Mewtwo', series: 'Pokémon' },
    { emoji: '🌪️', name: 'Rayquaza', series: 'Pokémon' },
  ],
  SSS: [
    { emoji: '🦡', name: 'Shukaku', series: 'Naruto — One-Tail' },
    { emoji: '🐈', name: 'Matatabi', series: 'Naruto — Two-Tails' },
    { emoji: '🐢', name: 'Isobu', series: 'Naruto — Three-Tails' },
    { emoji: '🐒', name: 'Son Gokū', series: 'Naruto — Four-Tails' },
    { emoji: '🐴', name: 'Kokuō', series: 'Naruto — Five-Tails' },
    { emoji: '🐌', name: 'Saiken', series: 'Naruto — Six-Tails' },
    { emoji: '🐛', name: 'Chōmei', series: 'Naruto — Seven-Tails' },
    { emoji: '🐂', name: 'Gyūki', series: 'Naruto — Eight-Tails' },
    { emoji: '🦊', name: 'Kurama', series: 'Naruto — Nine-Tails' },
  ],
};

const RARITY_LABEL = { C: 'Common', B: 'Uncommon', A: 'Rare', S: 'Epic', SS: 'Legendary', SSS: 'Mythic' };
const ADOPT_COST = { C: 500, B: 1500, A: 4000, S: 9000, SS: 20000, SSS: 50000 };
const RARITY_ORDER = ['C', 'B', 'A', 'S', 'SS', 'SSS'];

// Flattened, tagged-with-rarity lookup built once at module load — used for
// name search on ".pet adopt [name]".
const ALL_PETS = RARITY_ORDER.flatMap(rarity =>
  PET_CATALOGUE[rarity].map(p => ({ ...p, rarity }))
);

function findPetByName(query) {
  const q = query.toLowerCase().trim();
  return (
    ALL_PETS.find(p => p.name.toLowerCase() === q) ||
    ALL_PETS.find(p => p.name.toLowerCase().includes(q))
  );
}

function formatPetType(entry) {
  return `${entry.emoji} ${entry.name}`;
}

// ─── Hunger / Happiness Drift ───────────────────────────────────────────────
// BUG #1 THIS FIXES: hunger/happiness previously only ever went UP — set to
// 100 on adopt, nudged up (capped at 100) by .pet feed/.pet play. Nothing in
// the codebase ever decreased them, so every pet sat at 100% forever.
//
// BUG #2 THIS FIXES: the first fix for #1 kept hunger meaning "fullness"
// (100 = well-fed), which reads backwards — "hunger" going UP should mean
// the pet is getting MORE hungry, and feeding should bring it back DOWN.
// That's what this version does. happiness keeps its original, intuitive
// direction (100 = happy), so it's untouched.
//
// Both stats are stored as a snapshot value paired with the timestamp it was
// set at (lastFed / lastPlayed), and the CURRENT value is computed lazily
// from elapsed real time wherever it's needed. This needs no cron/
// setInterval, so it stays correct even if the bot process gets killed and
// restarted by Termux/PM2, or the phone drops connectivity for hours.
//
//   Hunger:    +10%/hour since fed   → maxes out (starving) ~10h after feeding
//   Happiness: -12.5%/hour since played → empties ~8h after playing
// Feeding no longer has a time cooldown — instead it requires consuming a
// Pet Food item from inventory (bought via .shop/.buy), and reduces hunger
// by FEED_HUNGER_REDUCTION (floor 0) per food used. Playing is unchanged:
// still a straight 2-hour cooldown, adds 25 to happiness (cap 100).
const HUNGER_RISE_PER_HOUR = 10;
const HAPPINESS_DECAY_PER_HOUR = 12.5;
const FEED_HUNGER_REDUCTION = 25; // % hunger restored per Pet Food used

function clamp(v) {
  return Math.max(0, Math.min(100, v));
}

// direction: +1 for stats that RISE over time since the anchor (hunger),
// -1 for stats that FALL over time since the anchor (happiness).
function driftedStat(storedValue, sinceTimestamp, ratePerHour, direction) {
  // sinceTimestamp === 0 means "no real anchor yet" — either a brand new
  // pet field or (for hunger specifically) a pet adopted before hunger had
  // real decay at all. Nothing to compute drift from, so hold the stored
  // value as-is rather than guessing.
  if (!sinceTimestamp) return clamp(storedValue);
  const hoursElapsed = (Date.now() - sinceTimestamp) / 3_600_000;
  if (hoursElapsed <= 0) return clamp(storedValue);
  return clamp(Math.round(storedValue + direction * ratePerHour * hoursElapsed));
}

// Returns the pet's CURRENT live hunger/happiness without mutating anything.
// Every read path (.pet, .pet feed, .pet play) goes through this so feed/play
// bonuses always stack onto the true current value, not a stale stored one.
//
// `hungerMigrated` gates hunger drift specifically: a pet whose stored
// hunger value still uses the pre-fix "100 = full" meaning must NOT have the
// new rising formula applied to it (that would compound with the stale
// value in the wrong direction). migratePetHunger.js flips old values once
// and sets this true; freshly adopted pets are created with it already true.
function getLiveStats(pet) {
  const hunger = pet.hungerMigrated
    ? driftedStat(pet.hunger, pet.lastFed, HUNGER_RISE_PER_HOUR, +1)
    : clamp(pet.hunger);
  return {
    hunger,
    happiness: driftedStat(pet.happiness, pet.lastPlayed, HAPPINESS_DECAY_PER_HOUR, -1),
  };
}

function hungerBar(value) {
  const filled = Math.max(0, Math.min(10, Math.round(value / 10)));
  return '🟥'.repeat(filled) + '⬜'.repeat(10 - filled);
}

function happinessBar(value) {
  const filled = Math.max(0, Math.min(10, Math.round(value / 10)));
  return '💛'.repeat(filled) + '⬛'.repeat(10 - filled);
}

function hungerStatus(hunger) {
  if (hunger >= 100) return '🚨 Starving!';
  if (hunger >= 80) return '😣 Very hungry';
  if (hunger >= 50) return '😕 Getting hungry';
  if (hunger >= 20) return '🙂 Fine';
  return '😋 Well fed';
}

module.exports = {
  // .pet — view pet
  async pet(client, msg, args) {
    const contact = await msg.getContact();
    const user = await User.findOrCreate(contact.id._serialized);

    if (!user.pet.type) {
      return msg.reply(
        `🐾 *No Pet Found!*\n\nAdopt one with *.pet adopt* for a random pull (card-style odds), or *.pet adopt [name]* for a specific pet.\n\nSee everything available with *.pet catalogue*.`
      );
    }

    const { name, type, rarity } = user.pet;
    const { hunger, happiness } = getLiveStats(user.pet);
    const rarityTag = rarity ? ` [${tierEmoji(rarity)} ${rarity}]` : '';

    let warning = '';
    if (hunger >= 100) warning += `\n⚠️ *${name || type}* is starving! Use *.pet feed*.`;
    if (happiness === 0) warning += `\n⚠️ *${name || type}* is miserable! Use *.pet play*.`;

    msg.reply(
      `🐾 *${name || 'Your Pet'}* (${type}${rarityTag})\n\n` +
      `🍗 Hunger: ${hungerBar(hunger)} ${hunger}% — ${hungerStatus(hunger)}\n` +
      `😊 Happiness: ${happinessBar(happiness)} ${happiness}%\n\n` +
      `Use *.pet feed*, *.pet play*, or *.pet name [name]*${warning}`
    );
  },

  // .pet catalogue — browse every adoptable pet, grouped by rarity
  async pet_catalogue(client, msg, args) {
    const lines = ['🐾 *Pet Catalogue*'];
    for (const rarity of RARITY_ORDER) {
      lines.push('');
      lines.push(`${tierEmoji(rarity)} *${rarity} — ${RARITY_LABEL[rarity]}*  (💰${ADOPT_COST[rarity].toLocaleString()})`);
      lines.push(PET_CATALOGUE[rarity].map(p => `  ${p.emoji} ${p.name} — ${p.series}`).join('\n'));
    }
    lines.push('');
    lines.push('Adopt a specific one with *.pet adopt [name]*, or *.pet adopt* for a random pull using card-style odds.');
    msg.reply(lines.join('\n'));
  },

  // .pet adopt [name]
  async pet_adopt(client, msg, args) {
    const contact = await msg.getContact();
    const user = await User.findOrCreate(contact.id._serialized);

    if (user.pet.type) return msg.reply('❌ You already have a pet! Use .pet to view it.');

    const query = args.join(' ');
    let entry, rarity;

    if (query) {
      entry = findPetByName(query);
      if (!entry) {
        return msg.reply(`❌ No pet matches "${query}". Use *.pet catalogue* to see the full list.`);
      }
      rarity = entry.rarity;
    } else {
      rarity = rollTier();
      entry = pick(PET_CATALOGUE[rarity]);
    }

    const cost = ADOPT_COST[rarity];
    if (user.coins < cost) {
      return msg.reply(
        `❌ Adopting ${formatPetType(entry)} (${tierEmoji(rarity)} ${RARITY_LABEL[rarity]}) costs 💰 ${cost.toLocaleString()} coins. You have 💰 ${user.coins.toLocaleString()}.`
      );
    }

    const now = Date.now();
    user.coins -= cost;
    user.pet.type = formatPetType(entry);
    user.pet.name = entry.name;
    user.pet.rarity = rarity;
    user.pet.hunger = 0; // freshly adopted = freshly fed, not hungry
    user.pet.happiness = 100;
    user.pet.lastFed = now;
    user.pet.lastPlayed = now;
    user.pet.hungerMigrated = true; // created under the new hunger-direction semantics from the start
    await user.save();

    msg.reply(
      `🎉 You adopted a ${tierEmoji(rarity)} *${RARITY_LABEL[rarity]}* ${formatPetType(entry)} *(${entry.series})*!\n\nName it with *.pet name [name]*`
    );
  },

  // .pet feed
  // .pet feed — requires a Pet Food item (buy from .shop). No time cooldown:
  // you can feed as often as you have food for, same as any other
  // consumable in the game. Consumes exactly one Pet Food per feed.
  async pet_feed(client, msg, args) {
    const contact = await msg.getContact();
    const user = await User.findOrCreate(contact.id._serialized);

    if (!user.pet.type) return msg.reply('❌ You have no pet. Use .pet adopt');

    const foodIdx = user.inventory.findIndex(i => i.toLowerCase() === 'pet food');
    if (foodIdx === -1) {
      return msg.reply(`🍖 You're out of Pet Food! Buy some with *.buy Pet Food* (see *.shop*).`);
    }

    const { hunger: liveHunger } = getLiveStats(user.pet);
    user.pet.hunger = Math.max(0, liveHunger - FEED_HUNGER_REDUCTION);
    user.pet.lastFed = Date.now();
    user.pet.hungerMigrated = true;
    user.inventory.splice(foodIdx, 1);
    await user.save();

    const remaining = user.inventory.filter(i => i.toLowerCase() === 'pet food').length;
    msg.reply(
      `🍗 You fed *${user.pet.name}* a Pet Food! Hunger: ${user.pet.hunger}% — ${hungerStatus(user.pet.hunger)}\n🎒 Pet Food left: ${remaining}`
    );
  },

  // .pet play
  async pet_play(client, msg, args) {
    const contact = await msg.getContact();
    const user = await User.findOrCreate(contact.id._serialized);

    if (!user.pet.type) return msg.reply('❌ You have no pet.');

    const now = Date.now();
    const cooldown = 2 * 60 * 60 * 1000; // 2 hours

    if (now - user.pet.lastPlayed < cooldown) {
      return msg.reply(`⏳ Your pet is tired! Come back in *${formatCooldown(cooldown - (now - user.pet.lastPlayed))}*`);
    }

    const { happiness: liveHappiness } = getLiveStats(user.pet);
    user.pet.happiness = Math.min(100, liveHappiness + 25);
    user.pet.lastPlayed = now;
    await user.save();

    const reactions = ['🎾 Ball toss!', '🎀 Ribbon play!', '🧸 Toy time!', '🏃 Running around!'];
    msg.reply(`${pick(reactions)}\n\n😊 *${user.pet.name}* is happy! Happiness: ${user.pet.happiness}%`);
  },

  // .pet name [name]
  async pet_name(client, msg, args) {
    const contact = await msg.getContact();
    const name = args.join(' ');
    if (!name) return msg.reply('❌ Usage: .pet name [name]');
    if (name.length > 20) return msg.reply('❌ Name too long (max 20 chars).');

    const user = await User.findOrCreate(contact.id._serialized);
    if (!user.pet.type) return msg.reply('❌ You have no pet.');

    user.pet.name = name;
    await user.save();
    msg.reply(`✅ Pet renamed to *${name}*!`);
  },
};
