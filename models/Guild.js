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
const { getNextSequence } = require('./Counter');
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
  // Personal tally of guild-quest contributions — distinct from the
  // guild's OWN overall `xp`/`level` (which only grow on a full quest
  // completion, a shared/collective outcome). This grows from a member's
  // own individual actions the moment they count toward the active quest
  // (see applyQuestProgress below), whether or not the quest ends up
  // completing — so steady individual participation is visible even in a
  // guild that rarely finishes a quest.
  xp: { type: Number, default: 0 },
  // Consecutive-day guild activity streak — see updateMemberStreak below.
  // lastStreakDate is a 'YYYY-MM-DD' (UTC) string, not a timestamp,
  // specifically so "did they do anything TODAY yet" and "was yesterday
  // the last day" are both simple string comparisons instead of needing
  // day-boundary math on raw millisecond timestamps.
  streak: { type: Number, default: 0 },
  lastStreakDate: { type: String, default: null },
}, { _id: false });

const GuildSchema = new mongoose.Schema({
  // Human-facing sequential id (1, 2, 3, ...) — separate from Mongo's own
  // _id, which is what leaderId/members/etc. actually reference internally.
  // Assigned automatically for new guilds by the pre-save hook below, via
  // the shared atomic counter in models/Counter.js. Existing guilds created
  // BEFORE this field existed need a one-time backfill — see
  // migrateGuildIds.js. `sparse: true` alongside `unique` matters here:
  // a plain unique index would choke the first time it saw a SECOND guild
  // whose guildId is still null (pre-migration) — sparse tells MongoDB to
  // only enforce uniqueness among documents where the field actually has a
  // value, so pre-migration guilds coexisting with post-migration ones is
  // completely safe.
  guildId: { type: Number, unique: true, sparse: true, default: null },
  name: { type: String, required: true, unique: true },
  leaderId: { type: String, required: true },
  members: { type: [GuildMemberSchema], default: [] },
  pendingInvites: { type: [String], default: [] },
  // Users who've requested to join via .guild join — separate from
  // pendingInvites (leader/officer invites a specific person) since this is
  // the reverse direction: a person asks, leader/officer approves. Only
  // reachable when recruitment is 'open' — see .guild join in
  // commands/guilds.js.
  pendingApplications: { type: [String], default: [] },
  // 'open'    — anyone can browse (bare .guild) and apply (.guild join);
  //             applications still need a leader/officer's approval, they
  //             don't join instantly.
  // 'invite'  — existing behavior, unchanged: leader/officer must invite
  //             the specific person first.
  // 'closed'  — not accepting anyone, invite or application.
  recruitment: { type: String, enum: ['open', 'invite', 'closed'], default: 'invite' },
  // Flat base cap — the effective cap (see Guild.effectiveMaxMembers) also
  // adds level and Guild Hall upgrade bonuses on top of this. Existing
  // guilds silently pick this default up via Mongoose's normal
  // missing-field-gets-the-default behavior; no migration needed for this
  // one, unlike guildId above.
  maxMembers: { type: Number, default: 25 },
  // ─── Guild Upgrades ─────────────────────────────────────────────────────
  // Purchased with treasury coins (leader only) — see .guild upgrade in
  // commands/guilds.js. Each is an integer level, 0 = not purchased, capped
  // at UPGRADE_MAX_LEVEL. This is the treasury's actual spending sink,
  // alongside .guild withdraw — before this, coins could leave the bank
  // for a single person's wallet but never for the guild's own lasting
  // benefit.
  upgrades: {
    hall: { type: Number, default: 0 },       // +5 member slots per level, stacks with the level-based cap bonus
    vault: { type: Number, default: 0 },      // +0.02%/day interest per level, stacks with the base 0.2%/day rate
    questBoard: { type: Number, default: 0 }, // +3% quest/mission reward per level, stacks with the level-based reward bonus
  },
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
  // Prestige score, separate from level/xp on purpose — level/xp measure
  // raw activity volume and can be rushed; reputation only comes from
  // discrete accomplishments (an achievement unlocked, a quest or mission
  // actually completed), so a guild that's been consistently good for a
  // long time outranks one that just leveled up fast. See where this is
  // incremented: completeQuestIfDone/completeMissionIfDone below, and
  // checkGuildAchievements in utils/guildAchievements.js.
  reputation: { type: Number, default: 0 },
  // Same events feed this as `reputation` above, but resets to 0 at the
  // end of each season (see _resolveSeasonIfDue in commands/guilds.js) —
  // this is what season standings are actually ranked by, so a guild that
  // was reputable two seasons ago doesn't coast on old accomplishments.
  // Lifetime `reputation` itself is never reset.
  seasonReputation: { type: Number, default: 0 },
  // Lifetime count of seasons this guild has WON — a permanent trophy,
  // unaffected by the seasonReputation reset above.
  seasonWins: { type: Number, default: 0 },
  // Which anniversary year has already been paid out (0 = none yet) — see
  // _maybeSendGuildEvents in commands/guilds.js. Prevents an anniversary
  // reward from firing every single day for the rest of the guild's life
  // once it's crossed that mark; only the day it's crossed pays out.
  lastAnniversaryYearRewarded: { type: Number, default: 0 },
  // ─── Weekly Guild Missions ────────────────────────────────────────────
  // A second, fully independent progress track alongside activeQuest
  // above — same shape, same three activities, but a week-long window
  // with bigger goals and bigger rewards. A single donate/claim/win can
  // advance BOTH the daily quest and the weekly mission at once if their
  // types happen to align; they never interfere with each other (own
  // progress, own contributors, own completion/reward/rollover).
  activeMission: {
    questType: { type: String, enum: ['donate', 'cards', 'games'], default: null },
    goal: { type: Number, default: 0 },
    progress: { type: Number, default: 0 },
    contributors: { type: Map, of: Number, default: {} },
    rewardCoins: { type: Number, default: 0 },
    rewardXp: { type: Number, default: 0 },
    startedAt: { type: Number, default: null },
    expiresAt: { type: Number, default: null },
  },
  missionsCompleted: { type: Number, default: 0 },
  // Unlocked guild achievement ids — see utils/guildAchievements.js for the
  // achievement list and the checker that populates this. Same shape as
  // User.achievements in models/User.js.
  achievements: { type: [String], default: [] },
  // ─── Cosmetics ──────────────────────────────────────────────────────────
  // Purchased from .guild shop with treasury coins (leader only) — the
  // guild's first cosmetic. Only a banner for now (a decorative
  // top/bottom border shown around .guild info instead of the plain
  // default one); more slots (theme color, badge, title) are a natural
  // follow-on, not built here. ownedBanners is the purchase history,
  // activeBanner is which one (if any) is currently equipped — a guild
  // can own several and switch between them for free.
  ownedBanners: { type: [String], default: [] },
  activeBanner: { type: String, default: null },
  // A single current announcement — not a history, just whatever the
  // leader/an officer posted most recently. See .guild announce in
  // commands/guilds.js.
  announcement: {
    text: { type: String, default: '' },
    postedBy: { type: String, default: null },
    postedAt: { type: Date, default: null },
  },
  // Recent guild activity feed — see logActivity()/.guild activity below.
  // Field named `eventType`, not `type`, for the same reason activeQuest's
  // discriminator field is `questType` — avoids the classic Mongoose
  // "a field literally named type" ambiguity entirely rather than relying
  // on sibling fields saving it.
  activityLog: {
    type: [{
      eventType: { type: String, enum: ['donate', 'withdraw', 'quest_completed', 'mission_completed', 'member_joined', 'member_left', 'announcement', 'upgrade', 'shop_purchase', 'season_won', 'event_bonus'], required: true },
      userId: { type: String, default: null },
      amount: { type: Number, default: null },
      questType: { type: String, default: null },
      rewardCoins: { type: Number, default: null },
      rewardXp: { type: Number, default: null },
      text: { type: String, default: null },
      at: { type: Date, default: Date.now },
    }],
    default: [],
  },
});

// ─── Daily Guild Treasury Interest ─────────────────────────────────────────
// Same feature as the personal bank in models/User.js, applied to the
// guild's shared treasury (`guild.bank`) instead — money the guild has
// collectively saved (via .guild donate) now compounds once per day too.
// Deliberately kept at the SAME modest BASE rate as the personal bank so
// one system doesn't quietly out-earn the other — the Treasury Vault
// upgrade (see UPGRADE_NAMES further down) is what lets a guild exceed it,
// purchased deliberately with treasury coins rather than just given away.
const DAILY_BANK_INTEREST_RATE = 0.002;
const VAULT_INTEREST_BONUS_PER_LEVEL = 0.0002;
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
    const rate = DAILY_BANK_INTEREST_RATE + (guild.upgrades?.vault || 0) * VAULT_INTEREST_BONUS_PER_LEVEL;
    guild.bank = Math.floor(before * Math.pow(1 + rate, daysElapsed));
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
// A quest can't be cashed in before it's been active this long, even if
// progress already hit the goal — see completeQuestIfDone below for the
// exploit this closes. 30 minutes is long enough to kill rapid automated
// farming (dozens of cycles/hour) without meaningfully hurting a
// legitimate multi-member guild that just happens to finish a quest fast —
// they simply collect the payout on their next qualifying action once the
// window passes, losing nothing.
const MIN_QUEST_DURATION_MS = 30 * 60 * 1000;
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
  const multiplier = getRewardMultiplier(guild);
  guild.activeQuest = {
    questType,
    goal: def.goal,
    progress: 0,
    contributors: {},
    rewardCoins: Math.round(def.rewardCoins * multiplier),
    rewardXp: Math.round(def.rewardXp * multiplier),
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
// Every reputation source (quest/mission completion, achievement unlock,
// challenge win) should feed BOTH the lifetime `reputation` stat AND the
// season-scoped `seasonReputation` — this is the one place that does
// both, so no call site can award one and forget the other.
function awardReputation(guild, amount) {
  guild.reputation = (guild.reputation || 0) + amount;
  guild.seasonReputation = (guild.seasonReputation || 0) + amount;
}

function addGuildXP(guild, amount) {
  const startingLevel = guild.level;
  guild.xp += amount;
  while (guild.xp >= xpNeededForLevel(guild.level + 1)) {
    guild.level += 1;
  }
  return { levelUp: guild.level > startingLevel, level: guild.level };
}

// Consecutive-day guild activity streak for one member. Called from
// applyQuestProgress below — the same single place that already knows
// "this member's action just counted toward the guild's focus" — so a
// member's streak only grows from genuine guild-quest-relevant activity
// (donate/cards/games matching whatever's currently active), not from
// merely being in a guild. Deliberately forgiving, not punitive: missing a
// day just resets the counter to 1 on their next contribution, there's no
// separate penalty, and nothing about a broken streak is shown as a loss —
// per the original proposal's own caution not to make this a "mandatory
// maintenance system".
function updateMemberStreak(member) {
  const todayKey = new Date().toISOString().slice(0, 10);
  if (member.lastStreakDate === todayKey) return; // already counted today

  const yesterdayKey = new Date(Date.now() - ONE_DAY_MS).toISOString().slice(0, 10);
  member.streak = member.lastStreakDate === yesterdayKey ? (member.streak || 0) + 1 : 1;
  member.lastStreakDate = todayKey;
}

// ─── Guild level perks ──────────────────────────────────────────────────────
// Levels didn't do anything besides "the number goes up" until this point —
// two small, purely additive perks now scale with level. "Additive" matters
// here: neither perk can ever make an existing guild worse off than it is
// today (below the relevant level threshold, both formulas reduce to
// exactly the pre-perk behavior), so this never regresses a guild that's
// already relying on today's numbers.

// Every 10 levels adds +5% to a freshly-generated quest/mission's reward
// (coins and XP alike), capped at +50% (level 100+). Baked into the
// reward the moment ensureActiveQuest/ensureActiveMission generate it,
// using the guild's level AT THAT TIME — so whatever .guild quest/mission
// displays as the reward is exactly what gets paid, no hidden multiplier
// applied later at payout that could make the displayed number a lie.
function levelRewardMultiplier(level) {
  return 1 + Math.min(0.5, Math.floor(level / 10) * 0.05);
}

// Combines the passive level bonus above with the purchased Quest Board
// upgrade (+3%/level, uncapped unlike the level bonus — deliberately
// purchased rather than free, so no reason to cap it the same way). This
// is what ensureActiveQuest/ensureActiveMission actually call — the plain
// levelRewardMultiplier above is kept separate purely so .guild info can
// still show "what does level alone get you" distinctly from "what did
// you pay for on top of that", not because anything else needs the
// level-only figure in isolation.
function getRewardMultiplier(guild) {
  return levelRewardMultiplier(guild.level) + (guild.upgrades?.questBoard || 0) * 0.03;
}

// Every 5 levels adds +5 member slots on top of whatever maxMembers is
// already set to — never less than the stored value, so a level 1-4 guild
// sees exactly today's flat 25 (Math.floor(level/5) is 0 there). Reads
// guild.maxMembers rather than hardcoding 25, so a guild whose cap was
// ever changed some other way (a future "buy more slots" feature, say)
// still gets its level bonus on top of THAT number, not a hardcoded reset
// back to 25.
GuildSchema.statics.effectiveMaxMembers = function (guild) {
  return guild.maxMembers + Math.floor(guild.level / 5) * 5 + (guild.upgrades?.hall || 0) * 5;
};

// ─── Guild Upgrades ─────────────────────────────────────────────────────────
// Shared cost table across all three upgrades, for simplicity — no reason
// today for one to be pricier than another, since their effects are all
// deliberately similar in magnitude (see the schema comment above).
// UPGRADE_COSTS[i] is the cost to go FROM level i TO level i+1, so
// UPGRADE_COSTS[0] is the cost of the guild's first purchase of that
// upgrade. Rises steeply on purpose — this is meant to be a real, ongoing
// use for a treasury a guild has been building up via quests/missions/
// donations, not a one-time trivial purchase.
const UPGRADE_MAX_LEVEL = 5;
const UPGRADE_COSTS = [50000, 125000, 250000, 500000, 1000000];
const UPGRADE_NAMES = {
  hall: { label: 'Guild Hall', effect: 'member cap', perLevel: '+5 members' },
  vault: { label: 'Treasury Vault', effect: 'daily interest', perLevel: '+0.02%/day' },
  questBoard: { label: 'Quest Board', effect: 'quest/mission rewards', perLevel: '+3%' },
};

// ─── Guild Shop ─────────────────────────────────────────────────────────────
// Purely cosmetic — a banner changes nothing about how the guild plays,
// unlike upgrades above. Bought once, owned forever, freely switchable
// between anything already owned via .guild banner. Prices are flat
// (unlike upgrades' rising cost) since there's no "level" to a cosmetic —
// you either own it or you don't.
const SHOP_BANNERS = {
  sakura: { name: 'Sakura', cost: 20000, top: '🌸━━━━━━━━━━🌸', bottom: '🌸━━━━━━━━━━🌸' },
  flame: { name: 'Flame', cost: 30000, top: '🔥━━━━━━━━━━🔥', bottom: '🔥━━━━━━━━━━🔥' },
  royal: { name: 'Royal', cost: 50000, top: '👑━━━━━━━━━━👑', bottom: '👑━━━━━━━━━━👑' },
  starlight: { name: 'Starlight', cost: 75000, top: '✨━━━━━━━━━━✨', bottom: '✨━━━━━━━━━━✨' },
};

// Cost to advance FROM currentLevel, or null if already at UPGRADE_MAX_LEVEL.
function getUpgradeCost(currentLevel) {
  return currentLevel >= UPGRADE_MAX_LEVEL ? null : UPGRADE_COSTS[currentLevel];
}

// ─── Guild activity feed ────────────────────────────────────────────────────
// Bounded recent-activity log — see .guild activity in commands/guilds.js
// for the display side. Deliberately scoped to events that already flow
// through this model (donations, quest completions, member join/leave) —
// individual card claims/game wins are NOT logged here, since most of them
// never touch a guild doc at all (Guild.addQuestProgress is a no-op
// whenever the active quest isn't currently focused on that activity type)
// — logging every claim/win unconditionally would mean hooking
// commands/cards.js and every commands/games/*.js file again for this one
// feature, which isn't worth it just for a log.
const MAX_ACTIVITY_LOG = 20;

// Mutates `guild` in place — does NOT save; every caller (both inside this
// file and commands/guilds.js via the Guild.logActivity static below) is
// already about to save the guild for its own reasons.
function logActivity(guild, entry) {
  guild.activityLog.push({ at: Date.now(), ...entry });
  if (guild.activityLog.length > MAX_ACTIVITY_LOG) {
    guild.activityLog.splice(0, guild.activityLog.length - MAX_ACTIVITY_LOG);
  }
}

// Pays out the active quest's reward and immediately rolls a new quest in
// if (and only if) progress has reached goal AND it's been active long
// enough. Returns the payout details, or null if the quest isn't
// completable yet (either not at goal, or at goal but still too fresh —
// see MIN_QUEST_DURATION_MS above). Progress itself is never reduced or
// lost while waiting on the cooldown; the next qualifying action after
// the window passes completes it normally. Mutates `guild` in place; does
// NOT save — callers (applyQuestProgress below) save once at the end
// alongside their own other changes.
function completeQuestIfDone(guild) {
  const q = guild.activeQuest;
  if (!q || !q.questType || q.progress < q.goal) return null;
  if (Date.now() - q.startedAt < MIN_QUEST_DURATION_MS) return null;

  const { questType, rewardCoins, rewardXp } = q;
  guild.bank += rewardCoins;
  guild.questsCompleted = (guild.questsCompleted || 0) + 1;
  awardReputation(guild, 5);
  const levelResult = addGuildXP(guild, rewardXp);
  logActivity(guild, { eventType: 'quest_completed', questType, rewardCoins, rewardXp });

  // Force ensureActiveQuest to treat this quest as expired so a fresh one
  // rolls in immediately, instead of the guild sitting quest-less until its
  // next unrelated read.
  guild.activeQuest.expiresAt = 0;
  ensureActiveQuest(guild);

  return { rewardCoins, rewardXp, levelUp: levelResult.levelUp, level: levelResult.level };
}

// ─── Weekly mission engine (parallel to the daily quest engine above) ──────
// Same three activities, week-long window, bigger numbers. Goals/rewards
// are roughly 5x the daily quest's — big enough to matter, not scaled
// precisely to anything (no upgrades/reputation system exists yet to tie
// this to).
const MISSION_DURATION_MS = 7 * ONE_DAY_MS;
// Same anti-exploit principle as MIN_QUEST_DURATION_MS (see there for the
// exploit it closes) — scaled up since a mission's reward is much bigger,
// so the payoff for trying to rush one is bigger too.
const MIN_MISSION_DURATION_MS = 4 * 60 * 60 * 1000; // 4 hours
const MISSION_DEFS = {
  donate: { goal: 100000, rewardCoins: 30000, rewardXp: 1500, label: g => `💰 Donate ${g.toLocaleString()} coins to the guild bank` },
  cards: { goal: 75, rewardCoins: 45000, rewardXp: 2000, label: g => `🎴 Collect ${g} cards` },
  games: { goal: 50, rewardCoins: 35000, rewardXp: 1750, label: g => `⚔️ Win ${g} games` },
};
const MISSION_TYPES = Object.keys(MISSION_DEFS);

// Mirrors ensureActiveQuest exactly, operating on activeMission instead.
function ensureActiveMission(guild) {
  const now = Date.now();
  const m = guild.activeMission;
  const expired = !m.questType || !m.expiresAt || now >= m.expiresAt;
  if (!expired) return false;

  const questType = MISSION_TYPES[Math.floor(Math.random() * MISSION_TYPES.length)];
  const def = MISSION_DEFS[questType];
  const multiplier = getRewardMultiplier(guild);
  guild.activeMission = {
    questType,
    goal: def.goal,
    progress: 0,
    contributors: {},
    rewardCoins: Math.round(def.rewardCoins * multiplier),
    rewardXp: Math.round(def.rewardXp * multiplier),
    startedAt: now,
    expiresAt: now + MISSION_DURATION_MS,
  };
  guild.markModified('activeMission');
  return true;
}

// Mirrors completeQuestIfDone exactly, operating on activeMission instead.
function completeMissionIfDone(guild) {
  const m = guild.activeMission;
  if (!m || !m.questType || m.progress < m.goal) return null;
  if (Date.now() - m.startedAt < MIN_MISSION_DURATION_MS) return null;

  const { questType, rewardCoins, rewardXp } = m;
  guild.bank += rewardCoins;
  guild.missionsCompleted = (guild.missionsCompleted || 0) + 1;
  awardReputation(guild, 25);
  const levelResult = addGuildXP(guild, rewardXp);
  logActivity(guild, { eventType: 'mission_completed', questType, rewardCoins, rewardXp });

  guild.activeMission.expiresAt = 0;
  ensureActiveMission(guild);

  return { rewardCoins, rewardXp, levelUp: levelResult.levelUp, level: levelResult.level };
}

// Only fires for brand-new guilds (isNew) — existing guilds created before
// this field existed are backfilled once by migrateGuildIds.js instead,
// in proper creation-chronological order, which this hook (running at an
// arbitrary later save, in arbitrary order) couldn't guarantee.
GuildSchema.pre('save', async function (next) {
  if (this.isNew && this.guildId == null) {
    this.guildId = await getNextSequence('guildId');
  }
  next();
});

// Covers Guild.findById(...) too — findById is implemented internally as a
// thin wrapper around findOne, so this single hook catches both. Does NOT
// fire for findByIdAndDelete/findOneAndDelete (a different Mongoose query
// op), which is correct — a guild about to be disbanded shouldn't be
// re-saved with fresh interest/quests on the way out.
GuildSchema.post('findOne', async function (doc) {
  if (!doc) return;
  // Defensive: a query that projects out fields this normalization needs
  // (.select(...)) or returns a plain object instead of a document
  // (.lean()) can't be safely normalized or saved — skip rather than
  // crash reading .questType (etc.) off a field that was never fetched.
  // Every current Guild.find/findOne/findById call in this codebase
  // fetches full documents, so this only guards against a FUTURE
  // .select()/.lean() being added without remembering this hook exists.
  if (typeof doc.save !== 'function' || doc.activeQuest === undefined) return;
  const needsInterestSave = applyDailyGuildInterest(doc);
  const needsQuestSave = ensureActiveQuest(doc);
  const needsMissionSave = ensureActiveMission(doc);
  if (needsInterestSave || needsQuestSave || needsMissionSave) {
    await doc.save();
  }
});

// Covers Guild.find(...) (e.g. .guild leaderboard's top-10 query) — same
// logic, applied per-document across the result set.
GuildSchema.post('find', async function (docs) {
  if (!Array.isArray(docs) || docs.length === 0) return;
  const saves = [];
  for (const doc of docs) {
    // Same defensive skip as the findOne hook above.
    if (typeof doc.save !== 'function' || doc.activeQuest === undefined) continue;
    const needsInterestSave = applyDailyGuildInterest(doc);
    const needsQuestSave = ensureActiveQuest(doc);
    const needsMissionSave = ensureActiveMission(doc);
    if (needsInterestSave || needsQuestSave || needsMissionSave) saves.push(doc.save());
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
// that is a separate decision, not bundled in here). DOES award
// member.xp, 1:1 with the amount recorded — unlike contribution, this
// field has no other source today, so awarding it here (the one place
// that already knows "this member's action just counted toward the
// guild's focus") doesn't risk double-counting.
GuildSchema.statics.applyQuestProgress = function (guild, userId, questType, amount) {
  if (!guild || !userId || !amount || amount <= 0) return null;

  const questMatches = guild.activeQuest.questType === questType;
  const missionMatches = guild.activeMission.questType === questType;
  if (!questMatches && !missionMatches) return null;

  // Awarded once per action regardless of whether it touches one track or
  // both — a single donate that happens to match both the daily quest AND
  // the weekly mission shouldn't double-credit the member's own xp tally
  // (or double-advance their streak) just because two trackers noticed it.
  const member = guild.members.find(m => m.userId === userId);
  if (member) {
    member.xp = (member.xp || 0) + amount;
    updateMemberStreak(member);
  }

  const result = { questCompleted: false, missionCompleted: false, questType };

  if (questMatches) {
    const key = encodeIdKey(userId);
    guild.activeQuest.contributors.set(key, (guild.activeQuest.contributors.get(key) || 0) + amount);
    guild.markModified('activeQuest.contributors');
    guild.activeQuest.progress += amount;
    result.progress = guild.activeQuest.progress;
    result.goal = guild.activeQuest.goal;

    const completion = completeQuestIfDone(guild);
    if (completion) {
      result.questCompleted = true;
      result.rewardCoins = completion.rewardCoins;
      result.rewardXp = completion.rewardXp;
      result.guildLevelUp = completion.levelUp;
      result.guildLevel = completion.level;
    }
  }

  if (missionMatches) {
    const key = encodeIdKey(userId);
    guild.activeMission.contributors.set(key, (guild.activeMission.contributors.get(key) || 0) + amount);
    guild.markModified('activeMission.contributors');
    guild.activeMission.progress += amount;
    result.missionProgress = guild.activeMission.progress;
    result.missionGoal = guild.activeMission.goal;

    const missionCompletion = completeMissionIfDone(guild);
    if (missionCompletion) {
      result.missionCompleted = true;
      result.missionRewardCoins = missionCompletion.rewardCoins;
      result.missionRewardXp = missionCompletion.rewardXp;
      result.missionGuildLevelUp = missionCompletion.levelUp;
      result.missionGuildLevel = missionCompletion.level;
    }
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
GuildSchema.statics.MIN_QUEST_DURATION_MS = MIN_QUEST_DURATION_MS;
GuildSchema.statics.MISSION_DEFS = MISSION_DEFS;
GuildSchema.statics.MIN_MISSION_DURATION_MS = MIN_MISSION_DURATION_MS;
GuildSchema.statics.levelRewardMultiplier = levelRewardMultiplier;
GuildSchema.statics.getRewardMultiplier = getRewardMultiplier;
GuildSchema.statics.UPGRADE_MAX_LEVEL = UPGRADE_MAX_LEVEL;
GuildSchema.statics.UPGRADE_NAMES = UPGRADE_NAMES;
GuildSchema.statics.getUpgradeCost = getUpgradeCost;
GuildSchema.statics.SHOP_BANNERS = SHOP_BANNERS;
GuildSchema.statics.awardReputation = awardReputation;
GuildSchema.statics.logActivity = logActivity;

module.exports = mongoose.model('Guild', GuildSchema);
