const User = require('../models/User');
const { formatCooldown, pick } = require('../utils/helpers');

const PET_TYPES = ['🐱 Cat', '🐶 Dog', '🐰 Rabbit', '🦊 Fox', '🐸 Frog', '🐧 Penguin', '🦁 Lion'];

module.exports = {
  // .pet — view pet
  async pet(client, msg, args) {
    const contact = await msg.getContact();
    const user = await User.findOrCreate(contact.id._serialized);

    if (!user.pet.type) {
      return msg.reply(
        `🐾 *No Pet Found!*\n\nAdopt a pet with *.pet adopt*\n\nAvailable pets:\n${PET_TYPES.join('\n')}`
      );
    }

    const { name, type, hunger, happiness } = user.pet;
    const hungerBar = '🟩'.repeat(Math.floor(hunger / 10)) + '⬛'.repeat(10 - Math.floor(hunger / 10));
    const happyBar = '💛'.repeat(Math.floor(happiness / 10)) + '⬛'.repeat(10 - Math.floor(happiness / 10));

    msg.reply(
      `🐾 *${name || 'Your Pet'}* (${type})\n\n🍗 Hunger: ${hungerBar} ${hunger}%\n😊 Happiness: ${happyBar} ${happiness}%\n\nUse *.pet feed*, *.pet play*, or *.pet name [name]*`
    );
  },

  // .pet adopt [type]
  async pet_adopt(client, msg, args) {
    const contact = await msg.getContact();
    const user = await User.findOrCreate(contact.id._serialized);

    if (user.pet.type) return msg.reply('❌ You already have a pet! Use .pet to view it.');

    const type = args.join(' ') || pick(PET_TYPES);
    const validType = PET_TYPES.find(p => p.toLowerCase().includes(type.toLowerCase()));

    if (!validType) return msg.reply(`❌ Invalid pet. Choose from:\n${PET_TYPES.join('\n')}`);

    if (user.coins < 500) return msg.reply('❌ Adopting a pet costs 💰 500 coins.');

    user.coins -= 500;
    user.pet.type = validType;
    user.pet.name = validType.split(' ')[1];
    user.pet.hunger = 100;
    user.pet.happiness = 100;
    await user.save();

    msg.reply(`🎉 You adopted a *${validType}*!\n\nName it with *.pet name [name]*`);
  },

  // .pet feed
  async pet_feed(client, msg, args) {
    const contact = await msg.getContact();
    const user = await User.findOrCreate(contact.id._serialized);

    if (!user.pet.type) return msg.reply('❌ You have no pet. Use .pet adopt');

    const now = Date.now();
    const cooldown = 3 * 60 * 60 * 1000; // 3 hours

    if (now - user.pet.lastFed < cooldown) {
      return msg.reply(`⏳ Your pet is not hungry yet. Come back in *${formatCooldown(cooldown - (now - user.pet.lastFed))}*`);
    }

    user.pet.hunger = Math.min(100, user.pet.hunger + 30);
    user.pet.lastFed = now;
    await user.save();

    msg.reply(`🍗 You fed *${user.pet.name}*! Hunger: ${user.pet.hunger}%\n${user.pet.hunger === 100 ? '😋 Fully fed!' : ''}`);
  },

  // .pet play
  async pet_play(client, msg, args) {
    const contact = await msg.getContact();
    const user = await User.findOrCreate(contact.id._serialized);

    if (!user.pet.type) return msg.reply('❌ You have no pet.');

    const now = Date.now();
    const cooldown = 2 * 60 * 60 * 1000;

    if (now - user.pet.lastPlayed < cooldown) {
      return msg.reply(`⏳ Your pet is tired! Come back in *${formatCooldown(cooldown - (now - user.pet.lastPlayed))}*`);
    }

    user.pet.happiness = Math.min(100, user.pet.happiness + 25);
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
