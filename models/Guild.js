// Guild member shape upgraded from a bare array of user-id strings to an
// array of small role/contribution records — this is what unlocks
// leader/officer/veteran/member permissions and a per-member contribution
// score. Existing guilds created under the old `members: [String]` shape
// MUST be run through migrateGuildMembers.js before this schema is
// deployed — see that file's header comment for why (Mongoose throws a
// CastError trying to hydrate a raw string into this subdocument shape
// otherwise).
const mongoose = require('mongoose');
const User = require('./User');
const { xpNeededForLevel, encodeIdKey } = require('../utils/helpers');

const ROLES = ['leader', 'officer', 'veteran', 'member'];
// Higher number = more senior. Used by .guild promote/.guild demote to
// step a member one rank up/down, and by leadership-handoff logic, without
// hardcoding the role order in more than one place.
const ROLE_RANK = { leader: 3, officer: 2, veteran: 1, member: 0 };

const GuildMemberSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  role: { type: String, enum: ROLES, default: 'member' },
  joinedAt: { type: Date, default: Date.now },
  contribution: { type: Number, default: 0 },
}, { _id: false });

const GuildSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  leaderId: { type: String, required: true },
  members: { type: [GuildMemberSchema], default: [] },
  pendingInvites: { type: [String], default: [] },
  emblem: { type: String, default: '🏰' },
  description: { type: String, default: '' },
  level: { type: Number, default: 1 },
  xp: { type: Number, default: 0 },
  bank: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  // Anchor for daily guild-treasury interest — see applyDailyGuildInterest()
  // below. null until the first time it's checked for this guild (existing
  // guilds get it seeded on their next read rather than backdated), exactly
  // the same convention as User.lastInterestAt in models/User.js.
  lastInterestAt: { type: Number, default: null },
  // ─── Guild Quests ─────────────────────────────────────────────────────
  // One rotating daily quest per guild. NOTE: the inner field is named
  // `questType`, not `type` — a sub-field literally named `type` sitting
  // alongside sibling fields like `goal`/`progress` happens to still parse
  // correctly in this Mongoose version (verified), but it's the single
  // most infamous Mongoose schema footgun (a lone `{ type: X }` with no
  // siblings gets read as "this whole field IS an X", not "this field HAS
  // a sub-field called type") — not worth relying on if this schema is
  // ever simplified later, so it's avoided entirely here.
  activeQuest: {
    questType: { type: String, enum: ['donate', 'cards', 'games'], default: null },
    goal: { type: Number, default: 0 },
    progress: { type: Number, default: 0 },
    // Keys are encodeIdKey()'d WhatsApp ids — see encodeIdKey/decodeIdKey in
    // utils/helpers.js and the big comment in index.js's message handler on
    // activityLog for why raw ids (which contain ".") can never be used as
    // literal Map keys. Same convention as Group.activityLog.
    contributors: { type: Map, of: Number, default: {} },
    rewardCoins: { type: Number, default: 0 },
    rewardXp: { type: Number, default: 0 },
    startedAt: { type: Number, default: null },
    expiresAt: { type: Number, default: null },
  },
  // Lifetime counter of completed quests — not used for anything yet beyond
  // display, but cheap to track from day one (achievements/prestige can
  // read this later without a migration).
  questsCompleted: { type: Number, default: 0 },
  // Unlocked guild achievement ids — see utils/guildAchievements.js for the
  // achievement list and the checker that populates this. Same shape as
  // User.achievements in models/User.js.
  achievements: { type: [String], default: [] },
});

// ─── Daily Guild Treasury Interest ─────────────────────────────────────────
// Same feature as the personal bank in models/User.js, applied to the
// guild's shared treasury (`guild.bank`) instead — money the guild has
// collectively saved (via .guild donate) now compounds once per day too.
// Deliberately kept at the SAME modest rate as the personal bank so one
// system doesn't quietly out-earn the other.
const DAILY_BANK_INTEREST_RATE = 0.002;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Lazy, not scheduled — same reasoning as the personal bank: a fixed-time
// trigger needs the Termux process alive at that exact moment, which isn't
// reliable on this setup. Instead of hooking this into every individual
// command handler (14+ places currently call Guild.findById/findOne/find
// across commands/guilds.js and commands/economy.js, and that list only
// grows), it's wired in once below as Mongoose query middleware so EVERY
// read of a guild document — present and future — gets it applied
// automatically, with no per-call-site plumbing to remember.
//
// Mutates `guild` in place and returns true if it needs saving (new day(s)
// elapsed, or this is the very first time lastInterestAt is being seeded).
// Also stashes the coins credited on the plain (non-schema, never
// persisted) `guild._interestCredited` property, same convention as
// User._interestCredited, so callers like .guild info/.guild donate in
// commands/guilds.js can mention it.
//
// Same KNOWN LIMITATION as the personal bank: interest is computed against
// whatever the CURRENT bank balance is at check-time, not a real
// day-by-day ledger of what the balance actually was each elapsed day.
function applyDailyGuildInterest(guild) {
  const now = Date.now();

  if (guild.lastInterestAt == null) {
    guild.lastInterestAt = now;
    guild._interestCredited = 0;
    return true;
  }

  const daysElapsed = Math.floor((now - guild.lastInterestAt) / ONE_DAY_MS);
  if (daysElapsed < 1) {
    guild._interestCredited = 0;
    return false;
  }

  // Advance the anchor unconditionally, even if bank is currently 0 — so
  // this same elapsed-days window can never be "cashed in" a second time
  // later (e.g. treasury spent to 0, wait, donate again).
  guild.lastInterestAt += daysElapsed * ONE_DAY_MS;

  const before = guild.bank;
  if (before > 0) {
    guild.bank = Math.floor(before * Math.pow(1 + DAILY_BANK_INTEREST_RATE, daysElapsed));
  }
  guild._interestCredited = guild.bank - before;
  return true;
}

// ─── Guild Quests engine ────────────────────────────────────────────────────
// One active daily quest per guild, its type picked randomly from these
// three activities every time a new one is generated. Goals/rewards are
// flat constants for now (not scaled by guild size/level) — simplest
// correct version; retune or scale here if a 3-person guild vs a 25-person
// guild ever feels too lopsided.
const QUEST_DURATION_MS = ONE_DAY_MS;
const QUEST_DEFS = {
  donate: { goal: 20000, rewardCoins: 5000, rewardXp: 300, label: g => `💰 Donate ${g.toLocaleString()} coins to the guild bank` },
  cards: { goal: 15, rewardCoins: 8000, rewardXp: 400, label: g => `🎴 Collect ${g} cards` },
  games: { goal: 10, rewardCoins: 6000, rewardXp: 350, label: g => `⚔️ Win ${g} games` },
};
const QUEST_TYPES = Object.keys(QUEST_DEFS);

// Mutates `guild` in place, replacing activeQuest with a fresh one IF the
// current one is missing or expired. Returns true if it needs saving.
// Deliberately does NOT pay out a partial reward for an expired-but-
// unfinished quest — an incomplete quest just quietly rolls over into a
// new one, same as a missed daily reward elsewhere in the bot.
function ensureActiveQuest(guild) {
  const now = Date.now();
  const q = guild.activeQuest;
  const expired = !q.questType || !q.expiresAt || now >= q.expiresAt;
  if (!expired) return false;

  const questType = QUEST_TYPES[Math.floor(Math.random() * QUEST_TYPES.length)];
  const def = QUEST_DEFS[questType];
  guild.activeQuest = {
    questType,
    goal: def.goal,
    progress: 0,
    contributors: {},
    rewardCoins: def.rewardCoins,
    rewardXp: def.rewardXp,
    startedAt: now,
    expiresAt: now + QUEST_DURATION_MS,
  };
  guild.markModified('activeQuest');
  return true;
}

// Same cumulative curve as personal XP (xpNeededForLevel in utils/helpers.js
// — level 1=0, 2=100, 3=300, 4=600...), reused as-is rather than inventing a
// second curve to maintain. Mutates guild.xp/guild.level in place. Unlike
// personal level-ups, this does NOT grant any bonus coins on its own —
// guild levels are a pure progression/prestige stat for now; "levels unlock
// perks" is a later feature, not built here.
function addGuildXP(guild, amount) {
  const startingLevel = guild.level;
  guild.xp += amount;
  while (guild.xp >= xpNeededForLevel(guild.level + 1)) {
    guild.level += 1;
  }
  return { levelUp: guild.level > startingLevel, level: guild.level };
}

// Pays out the active quest's reward and immediately rolls a new quest in
// if (and only if) progress has reached goal. Returns the payout details,
// or null if the quest isn't complete yet. Mutates `guild` in place; does
// NOT save — callers (applyQuestProgress below) save once at the end
// alongside their own other changes.
function completeQuestIfDone(guild) {
  const q = guild.activeQuest;
  if (!q || !q.questType || q.progress < q.goal) return null;

  const { rewardCoins, rewardXp } = q;
  guild.bank += rewardCoins;
  guild.questsCompleted = (guild.questsCompleted || 0) + 1;
  const levelResult = addGuildXP(guild, rewardXp);

  // Force ensureActiveQuest to treat this quest as expired so a fresh one
  // rolls in immediately, instead of the guild sitting quest-less until its
  // next unrelated read.
  guild.activeQuest.expiresAt = 0;
  ensureActiveQuest(guild);

  return { rewardCoins, rewardXp, levelUp: levelResult.levelUp, level: levelResult.level };
}

// Covers Guild.findById(...) too — findById is implemented internally as a
// thin wrapper around findOne, so this single hook catches both. Does NOT
// fire for findByIdAndDelete/findOneAndDelete (a different Mongoose query
// op), which is correct — a guild about to be disbanded shouldn't be
// re-saved with fresh interest/quests on the way out.
GuildSchema.post('findOne', async function (doc) {
  if (!doc) return;
  const needsInterestSave = applyDailyGuildInterest(doc);
  const needsQuestSave = ensureActiveQuest(doc);
  if (needsInterestSave || needsQuestSave) {
    await doc.save();
  }
});

// Covers Guild.find(...) (e.g. .guild leaderboard's top-10 query) — same
// logic, applied per-document across the result set.
GuildSchema.post('find', async function (docs) {
  if (!Array.isArray(docs) || docs.length === 0) return;
  const saves = [];
  for (const doc of docs) {
    const needsInterestSave = applyDailyGuildInterest(doc);
    const needsQuestSave = ensureActiveQuest(doc);
    if (needsInterestSave || needsQuestSave) saves.push(doc.save());
  }
  if (saves.length) await Promise.all(saves);
});

// ─── Public quest API ───────────────────────────────────────────────────────
// applyQuestProgress: pure in-memory op on an ALREADY-LOADED guild doc, for
// callers that already have `guild` in hand (e.g. .guild donate in
// commands/guilds.js, which is already mutating guild.bank in the same
// breath). Does nothing (returns null) if the active quest isn't currently
// focused on this activity type — donating while the active quest is
// "collect cards" simply doesn't move that quest's needle, same as the
// ChatGPT proposal's "contributors" being scoped to whichever quest is
// live. Does NOT save — caller saves, same transaction as their own edits.
// Does NOT touch member.contribution — that stays whatever each caller's
// own activity already grants it (.guild donate already grants it 1:1
// itself; card claims/game wins don't grant contribution today and adding
// that is a separate decision, not bundled in here).
GuildSchema.statics.applyQuestProgress = function (guild, userId, questType, amount) {
  if (!guild || !userId || !amount || amount <= 0) return null;
  if (guild.activeQuest.questType !== questType) return null;

  const key = encodeIdKey(userId);
  const before = guild.activeQuest.contributors.get(key) || 0;
  guild.activeQuest.contributors.set(key, before + amount);
  guild.markModified('activeQuest.contributors');
  guild.activeQuest.progress += amount;

  const result = {
    questCompleted: false,
    questType,
    progress: guild.activeQuest.progress,
    goal: guild.activeQuest.goal,
  };

  const completion = completeQuestIfDone(guild);
  if (completion) {
    result.questCompleted = true;
    result.rewardCoins = completion.rewardCoins;
    result.rewardXp = completion.rewardXp;
    result.guildLevelUp = completion.levelUp;
    result.guildLevel = completion.level;
  }
  return result;
};

// addQuestProgress: convenience wrapper for callers that DON'T already have
// a guild doc loaded — commands/cards.js (.claim) and every commands/games/
// *.js file (a game win). Looks the user's guild up, applies progress, and
// saves on its own. Deliberately swallows every error and returns null
// instead of throwing — this bot's unstable mobile connection means a
// hiccup here should never take down the primary action (claiming a card,
// finishing a game) that triggered it. Returns null if the user isn't in a
// guild, or on any failure; otherwise the same result shape as
// applyQuestProgress, plus guildName/guildEmblem for display.
GuildSchema.statics.addQuestProgress = async function (userId, questType, amount) {
  try {
    if (!userId || !amount || amount <= 0) return null;
    const user = await User.findOne({ id: userId });
    if (!user || !user.guildId) return null;

    const guild = await this.findById(user.guildId);
    if (!guild) return null;
    if (!guild.members.some(m => m.userId === userId)) return null;

    const result = this.applyQuestProgress(guild, userId, questType, amount);
    if (!result) return null;

    result.guildName = guild.name;
    result.guildEmblem = guild.emblem;
    await guild.save();
    return result;
  } catch (err) {
    console.error('Guild.addQuestProgress error:', err.message);
    return null;
  }
};

GuildSchema.statics.ROLES = ROLES;
GuildSchema.statics.ROLE_RANK = ROLE_RANK;
GuildSchema.statics.QUEST_DEFS = QUEST_DEFS;

module.exports = mongoose.model('Guild', GuildSchema);
