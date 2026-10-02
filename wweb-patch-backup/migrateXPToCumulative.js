// Run once after deploying the cumulative-XP change:
//   node migrateXPToCumulative.js
//
// Before this fix, user.xp meant "progress within the current level" — it
// reset toward 0 every time you leveled up, so a Level 2 user sitting at
// 25 XP into that level just showed "25", not their real lifetime total.
// After the fix, user.xp is a lifetime cumulative total that only ever
// goes up (see xpNeededForLevel() in utils/helpers.js) — the SAME Level 2
// / 25-into-the-level user should now read 125 (100 needed to reach Level
// 2, plus the 25 already earned since).
//
// This converts every existing user's stored xp from the old "relative to
// current level" meaning to the new cumulative meaning, using the exact
// same formula addXP()/. level now expect: newXp = xpNeededForLevel(level) + oldXp.
// Nobody's level changes and nobody loses progress — this only changes
// what the stored number means, not how far anyone actually is.
//
// Safe to re-run — anything already migrated (xpMigrated) is skipped.

const mongoose = require('mongoose');
require('dotenv').config();

const User = require('./models/User');
const { xpNeededForLevel } = require('./utils/helpers');

async function migrate() {
  const users = await User.find({ xpMigrated: { $ne: true } });

  let updated = 0;

  for (const user of users) {
    const oldXp = user.xp;
    const newXp = xpNeededForLevel(user.level) + oldXp;
    user.xp = newXp;
    user.xpMigrated = true;
    await user.save();

    console.log(`[User] ${user.name || user.id} — Level ${user.level}: xp ${oldXp} -> ${newXp}`);
    updated++;
  }

  console.log(`\n✅ Migrated ${updated} user(s). ${updated === 0 ? '(Nothing to do — already migrated.)' : ''}`);
}

(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    await migrate();
    process.exit();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
