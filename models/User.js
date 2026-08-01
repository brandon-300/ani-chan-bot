const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  name: { type: String, default: 'Unknown' },
  bio: { type: String, default: '✨ No bio set.' },
  age: { type: Number, default: 0 },
  coins: { type: Number, default: 1000 },
  bank: { type: Number, default: 0 },
  orbs: { type: Number, default: 5 },
  stardust: { type: Number, default: 0 },
  xp: { type: Number, default: 0 },
  level: { type: Number, default: 1 },
  lastDaily: { type: Number, default: 0 },
  lastDig: { type: Number, default: 0 },
  lastFish: { type: Number, default: 0 },
  lastBeg: { type: Number, default: 0 },
  inventory: { type: [String], default: [] },
  cards: { type: [String], default: [] },       // array of Card _id strings
  deck: { type: [String], default: [] },         // up to 5 card ids
  warns: { type: Number, default: 0 },
  nsfwEnabled: { type: Boolean, default: false },
  guildId: { type: String, default: null },
  pet: {
    name: { type: String, default: null },
    type: { type: String, default: null },
    hunger: { type: Number, default: 100 },
    happiness: { type: Number, default: 100 },
    lastFed: { type: Number, default: 0 },
    lastPlayed: { type: Number, default: 0 },
  },
  profile: {
    title: { type: String, default: '🌸 New Adventurer' },
    badge: { type: String, default: '' },
  },
  campCount: { type: Number, default: 0 },      // for anticamp
  achievements: { type: [String], default: [] }, // unlocked achievement ids
  wishlist: { type: [String], default: [] },     // card names the user wants to be notified about
  tradesCompleted: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
});

UserSchema.statics.findOrCreate = async function (id, name) {
  // `name` here is only ever a DEFAULT for a brand-new user — most call
  // sites across the bot pass the caller's live contact.pushname on every
  // single command purely so a first-time user starts with a sensible
  // name. Previously this used $set, which applies unconditionally — so
  // any of those same commands (e.g. viewing .profile) would silently
  // re-sync an EXISTING user's name back to their live WhatsApp pushname,
  // undoing .setname every time. $setOnInsert only ever applies on the
  // initial upsert, so an existing user's name is never touched here. To
  // explicitly change an existing user's name, set `user.name` directly
  // and .save() — see .setname in commands/economy.js.
  const setOnInsert = { id };
  if (name) setOnInsert.name = name;
  return this.findOneAndUpdate(
    { id },
    { $setOnInsert: setOnInsert },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
};

module.exports = mongoose.model('User', UserSchema);
