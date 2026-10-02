const User = require('../models/User');

// Ordered low -> high by the level required. Unlike achievements (a
// checklist you keep adding to), a title is a single rank you currently
// hold — checkTitle() always sets it to the HIGHEST tier your level
// qualifies for. To add a new tier, just insert a row here in level order;
// nothing else needs to change.
const TITLES = [
  { id: 'new_adventurer',    name: 'New Adventurer',    emoji: '🌸', minLevel: 1 },
  { id: 'rookie_tamer',      name: 'Rookie Tamer',      emoji: '🎴', minLevel: 5 },
  { id: 'card_hunter',       name: 'Card Hunter',       emoji: '🏹', minLevel: 10 },
  { id: 'seasoned_collector',name: 'Seasoned Collector',emoji: '📖', minLevel: 20 },
  { id: 'veteran_trainer',   name: 'Veteran Trainer',   emoji: '⚔️', minLevel: 35 },
  { id: 'elite_champion',    name: 'Elite Champion',    emoji: '🏆', minLevel: 50 },
  { id: 'legendary_master',  name: 'Legendary Master',  emoji: '👑', minLevel: 75 },
  { id: 'mythic_ascendant',  name: 'Mythic Ascendant',  emoji: '🌌', minLevel: 100 },
];

function highestEarnedTitle(level) {
  let best = TITLES[0];
  for (const t of TITLES) {
    if (level >= t.minLevel) best = t;
  }
  return best;
}

function titleLabel(title) {
  return `${title.emoji} ${title.name}`;
}

// Checks the user's current level against the title table and upgrades
// user.profile.title if they now qualify for something higher than what
// they're currently wearing. Returns the new title if it changed, null if
// their title is already correct (the common case — this is cheap and safe
// to call on every check-in, same as checkAchievements).
async function checkTitle(userId) {
  const user = await User.findOrCreate(userId);
  const earned = highestEarnedTitle(user.level);
  const label = titleLabel(earned);
  if (user.profile.title === label) return null;

  user.profile.title = label;
  await user.save();
  return earned;
}

// Formats a notification block for a newly-unlocked title. Returns an empty
// string if nothing changed (caller should skip appending it).
function formatTitleUnlockNotice(newTitle) {
  if (!newTitle) return '';
  return `\n\n🎖️ *New Title Unlocked!*\n${titleLabel(newTitle)}`;
}

module.exports = { TITLES, highestEarnedTitle, titleLabel, checkTitle, formatTitleUnlockNotice };
