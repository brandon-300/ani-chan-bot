// Run once, BEFORE deploying the new models/Guild.js + commands/guilds.js
// (the roles/contribution upgrade):
//   node migrateGuildMembers.js
//
// Before this, Guild.members was a flat array of user-id strings. The
// roles/contribution upgrade changes it to an array of
// { userId, role, joinedAt, contribution } records. Mongoose will throw a
// CastError trying to hydrate an old plain string into that new
// subdocument shape, so every existing guild needs converting first.
//
// Runs against the RAW collection (not the Mongoose model) on purpose —
// that way it works correctly no matter which version of models/Guild.js
// happens to be loaded when you run it, since it never touches Mongoose's
// schema/casting at all.
//
// - The guild's current leaderId becomes that member's role: 'leader'.
// - Everyone else becomes role: 'member' (nobody had officer/veteran
//   before this existed, so there's nothing to preserve there).
// - joinedAt is set to the guild's own createdAt for every member, since
//   the old schema never recorded individual join dates — this is the
//   earliest date we can honestly attribute, not a guess at the real one.
// - contribution starts at 0 for everyone.
// - description defaults to '' if the guild doesn't have one yet.
//
// Safe to re-run — any guild whose members are already objects (not
// strings) is left untouched.
//
// IMPORTANT: run this BEFORE restarting PM2 with the new code, with
// nobody actively using guild commands. The OLD code is still writing the
// OLD string-array shape until you restart, so a `.guild accept`/`.guild
// remove`/etc. mid-migration could resave a guild this script already
// converted, undoing the conversion for that one guild. On a low-traffic
// bot this window is small — just avoid guild activity for the minute or
// two between running this and restarting PM2.

const mongoose = require('mongoose');
require('dotenv').config();

async function migrate() {
  const db = mongoose.connection.db;
  const guilds = await db.collection('guilds').find({}).toArray();

  let migrated = 0;
  let skipped = 0;

  for (const guild of guilds) {
    const alreadyMigrated = !guild.members || guild.members.length === 0 || typeof guild.members[0] === 'object';
    if (alreadyMigrated) {
      skipped++;
      continue;
    }

    const newMembers = guild.members.map(userId => ({
      userId,
      role: userId === guild.leaderId ? 'leader' : 'member',
      joinedAt: guild.createdAt || new Date(),
      contribution: 0,
    }));

    await db.collection('guilds').updateOne(
      { _id: guild._id },
      {
        $set: {
          members: newMembers,
          description: guild.description || '',
        },
      }
    );

    console.log(`[Guild] ${guild.name} — migrated ${newMembers.length} member(s).`);
    migrated++;
  }

  console.log(`\n✅ Migrated ${migrated} guild(s). Skipped ${skipped} (already migrated or empty).`);
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
