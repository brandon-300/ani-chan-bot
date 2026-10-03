// Run once after deploying the pet hunger-direction fix:
//   node migratePetHunger.js
//
// Before this fix, pet.hunger meant "fullness" (100 = well-fed). After it,
// pet.hunger means "how hungry" (100 = starving) — the opposite direction.
// Any pet adopted before the fix has a stored value under the OLD meaning;
// this flips it (newValue = 100 - oldValue) so existing pets keep their
// real-world fed/hungry status instead of suddenly reading as starving.
//
// Safe to re-run — anything already migrated (pet.hunger.hungerMigrated,
// which .pet adopt/.pet feed also set going forward) is skipped.

const mongoose = require('mongoose');
require('dotenv').config();

const User = require('./models/User');

async function migrate() {
  const users = await User.find({
    'pet.type': { $ne: null },
    'pet.hungerMigrated': { $ne: true },
  });

  let updated = 0;

  for (const user of users) {
    const oldHunger = user.pet.hunger;
    user.pet.hunger = Math.max(0, Math.min(100, 100 - oldHunger));
    user.pet.hungerMigrated = true;
    await user.save();

    console.log(`[User] ${user.name || user.id} — ${user.pet.name || user.pet.type}: hunger ${oldHunger} -> ${user.pet.hunger}`);
    updated++;
  }

  console.log(`\n✅ Migrated ${updated} pet(s). ${updated === 0 ? '(Nothing to do — already migrated.)' : ''}`);
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
