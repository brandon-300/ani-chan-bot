const Guild = require('../models/Guild');

// Same convention as utils/achievements.js's personal ACHIEVEMENTS list:
// only reachable, honestly-checkable achievements against fields that
// actually persist on the Guild model today (questsCompleted, bank, level,
// members.length). Nothing tied to guild features that don't exist yet
// (reputation, seasons, guild-vs-guild wins, etc.) — those get their own
// achievements if/when those features are actually built.
//
// To add a new one later: just append an entry here. Nothing else needs to
// change — checkGuildAchievements() picks it up automatically.
const GUILD_ACHIEVEMENTS = [
  {
    id: 'first_quest',
    name: 'First Guild Quest',
    emoji: '🏆',
    desc: 'Complete your first guild quest',
    check: (ctx) => ctx.questsCompleted >= 1
  },
  {
    id: 'quest_veteran',
    name: 'Quest Veteran',
    emoji: '🎖️',
    desc: 'Complete 10 guild quests',
    check: (ctx) => ctx.questsCompleted >= 10
  },
  {
    id: 'wealthy_guild',
    name: 'Wealthy Guild',
    emoji: '💰',
    desc: 'Accumulate 1,000,000 coins in the guild treasury',
    check: (ctx) => ctx.bank >= 1000000
  },
  {
    id: 'established',
    name: 'Established',
    emoji: '⭐',
    desc: 'Reach Guild Level 10',
    check: (ctx) => ctx.level >= 10
  },
  {
    id: 'legendary_guild',
    name: 'Legendary',
    emoji: '🌟',
    desc: 'Reach Guild Level 50',
    check: (ctx) => ctx.level >= 50
  },
  {
    id: 'full_house',
    name: 'Full House',
    emoji: '👥',
    desc: 'Reach 10 members',
    check: (ctx) => ctx.memberCount >= 10
  }
];

// Checks all guild achievements, unlocks any newly-earned ones, and returns
// the list of achievements unlocked just now (empty if none). Re-fetches
// the guild itself (same pattern as personal checkAchievements(userId) in
// utils/achievements.js re-fetching the User) rather than taking an
// already-loaded doc — this runs infrequently enough (only from
// commands/guilds.js's donate/info/quest/achievements handlers) that the
// extra round trip isn't worth threading an in-memory variant through, and
// keeping it self-contained avoids models/Guild.js ever having to require
// this file back (which would be a real circular require, unlike the safe
// one-directional User.js require it already has).
async function checkGuildAchievements(guildId) {
  const guild = await Guild.findById(guildId);
  if (!guild) return [];

  const alreadyUnlocked = new Set(guild.achievements || []);
  const ctx = {
    questsCompleted: guild.questsCompleted || 0,
    bank: guild.bank,
    level: guild.level,
    memberCount: guild.members.length,
  };

  const newlyUnlocked = GUILD_ACHIEVEMENTS.filter(
    a => !alreadyUnlocked.has(a.id) && a.check(ctx)
  );

  if (newlyUnlocked.length) {
    guild.achievements = [...alreadyUnlocked, ...newlyUnlocked.map(a => a.id)];
    await guild.save();
  }

  return newlyUnlocked;
}

// Formats a notification block for any newly-unlocked guild achievements.
// Returns an empty string if there's nothing new (caller should skip
// appending it). Same shape as formatUnlockNotice in utils/achievements.js.
function formatGuildUnlockNotice(newlyUnlocked) {
  if (!newlyUnlocked.length) return '';
  const lines = newlyUnlocked.map(a => `${a.emoji} *${a.name}* — ${a.desc}`);
  return `\n\n🏆 *Guild Achievement Unlocked!*\n${lines.join('\n')}`;
}

module.exports = { GUILD_ACHIEVEMENTS, checkGuildAchievements, formatGuildUnlockNotice };
