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
    // Rarity tier of the adopted pet — 'C'/'B'/'A'/'S'/'SS'/'SSS', same
    // scale as card tiers (see utils/helpers.js TIER_DROP_RATES). null for
    // any pet adopted before the rarity system existed; commands/pets.js
    // handles that gracefully (just omits the rarity tag when displaying).
    rarity: { type: String, default: null },
    // hunger = how HUNGRY the pet is (0 = full, 100 = starving). Rises over
    // time since lastFed; .pet feed lowers it. (happiness is the opposite
    // convention — 100 = happy — which matches its name, so it's untouched.)
    hunger: { type: Number, default: 0 },
    happiness: { type: Number, default: 100 },
    lastFed: { type: Number, default: 0 },
    lastPlayed: { type: Number, default: 0 },
    // False for any pet whose stored `hunger` value predates the hunger-
    // direction fix (still using the old "100 = full" meaning). The
    // migratePetHunger.js script flips those old values once and sets this
    // true; commands/pets.js also sets it true on every fresh .pet adopt,
    // since new pets are created correctly from the start.
    hungerMigrated: { type: Boolean, default: false },
  },
  profile: {
    title: { type: String, default: '🌸 New Adventurer' },
    badge: { type: String, default: '' },
    // Cloudinary-hosted profile picture (see commands/economy.js's
    // .setpic). picUrl is the permanent HTTPS URL sent back to WhatsApp via
    // MessageMedia.fromUrl; picPublicId is Cloudinary's own id for the file,
    // needed to delete/overwrite it later. Empty strings mean none set.
    picUrl: { type: String, default: '' },
    picPublicId: { type: String, default: '' },
  },
  campCount: { type: Number, default: 0 },      // for anticamp
  achievements: { type: [String], default: [] }, // unlocked achievement ids
  wishlist: { type: [String], default: [] },     // card names the user wants to be notified about
  tradesCompleted: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  // ─── Bank Loan (commands/loan.js, .loan) ───────────────────────────────
  // One active loan per user at a time, staked against one of their own
  // OwnedCard docs (see models/Card.js's OwnedCardSchema.isStaked). Amounts
  // are computed once at request time and frozen here — interest is never
  // recalculated later, so nothing here needs to change if utils LOAN
  // brackets are retuned after the fact. `cardId`/`cardName`/`cardTier` are
  // a snapshot for display in .loan status even if the live card document
  // is ever removed later; the authoritative unstake target is `cardId`.
  loan: {
    active: { type: Boolean, default: false },
    bracket: { type: String, default: null },     // '1'..'6' or 'S' — see LOAN_BRACKETS in commands/loan.js
    principal: { type: Number, default: 0 },
    interest: { type: Number, default: 0 },
    totalOwed: { type: Number, default: 0 },
    cardId: { type: String, default: null },       // staked OwnedCard._id (string)
    cardName: { type: String, default: null },
    cardTier: { type: String, default: null },
    issuedAt: { type: Number, default: null },      // ms epoch
    dueAt: { type: Number, default: null },         // ms epoch
  },
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
