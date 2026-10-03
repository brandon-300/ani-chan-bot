// Run once after deploying the guild-recruitment change (adds
// Guild.guildId, models/Counter.js, and the pre-save hook that
// auto-assigns guildId to brand-new guilds):
//   node migrateGuildIds.js
//
// Assigns sequential guildId numbers (starting at 1) to every EXISTING
// guild, in original creation order (oldest first) — so guild #1 really is
// the oldest guild, not just whichever one happened to get saved first
// after this deploy. Going forward, new guilds get their guildId
// automatically from the same counter (see the pre-save hook in
// models/Guild.js) — this script exists only to backfill guilds created
// BEFORE that hook existed.
//
// Also seeds the shared counter to the highest number assigned here, so
// the very next .guild create continues the sequence instead of colliding
// with an id this script just handed out.
//
// Safe to re-run — guilds that already have a guildId are skipped, and if
// nothing needs migrating the counter is left untouched.

const mongoose = require('mongoose');
require('dotenv').config();

const Guild = require('./models/Guild');
const { Counter } = require('./models/Counter');

async function migrate() {
  const guilds = await Guild.find({ guildId: null }).sort({ createdAt: 1 });

  // Don't just start at 1 blindly — if some guilds were somehow already
  // assigned an id (e.g. this script partially ran before, or a guild was
  // created after the code deployed but before this script ran), continue
  // from the highest one already in use.
  let next = 1;
  const highestExisting = await Guild.findOne({ guildId: { $ne: null } }).sort({ guildId: -1 });
  if (highestExisting) next = highestExisting.guildId + 1;

  let updated = 0;
  for (const guild of guilds) {
    guild.guildId = next;
    await guild.save();
    console.log(`[Guild] ${guild.name} -> #${next}`);
    next++;
    updated++;
  }

  if (updated > 0) {
    await Counter.findOneAndUpdate(
      { key: 'guildId' },
      { $set: { value: next - 1 } },
      { upsert: true }
    );
  }

  console.log(`\n✅ Migrated ${updated} guild(s). ${updated === 0 ? '(Nothing to do — already migrated.)' : ''}`);
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
