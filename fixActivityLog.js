// One-time repair for Group documents corrupted by the activityLog dot-path
// bug in index.js (see the fix in that file for the full explanation).
//
// WhatsApp ids like "234801234567@c.us" contain a ".", which broke Mongo's
// old `$inc: { [\`activityLog.${senderId}\`]: 1 }` update path. Instead of
// writing a plain number under a key for "234801234567@c.us", it silently
// wrote a nested object like { us: 19 } under the key "234801234567@c".
// Since the schema is `activityLog: Map of Number`, any Group document
// holding one of these corrupted entries fails full-document validation on
// every .save() from then on — .setrules, antilink toggles, welcome/leave
// messages, anything — with:
//   "Group validation failed: activityLog.$*: Cast to Number failed..."
//
// This script finds every corrupted entry and reconstructs the real id +
// count it was supposed to be. It CANNOT write that id back as a literal Map
// key, though — Mongoose's Map type hard-rejects any key containing "."
// (checkValidKey() throws 'Mongoose maps do not support keys that contain
// "."' the moment a Map value is fully cast, which a $set update triggers).
// So it encodes the id the same way index.js now does going forward
// (encodeIdKey — swaps "." for "~") before writing it back.
//
// Reads with .lean() (plain objects, no schema casting — so a corrupted
// document can't throw just from being read) and writes with updateOne
// (skips validators, unlike .save()), so it's safe to run even while
// documents are still corrupted.
//
// Run this ONCE, before restarting the bot with the fixed index.js.
//
// Usage (from the project root):
//   node fixActivityLog.js

require('dotenv').config();
const mongoose = require('mongoose');
const Group = require('./models/Group');
const { encodeIdKey } = require('./utils/helpers');

(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ MongoDB connected');

    const groups = await Group.find({}).lean();
    console.log(`🔍 Scanning ${groups.length} group document(s)...`);

    let fixedGroups = 0;
    let fixedEntries = 0;

    for (const doc of groups) {
      const log = doc.activityLog;
      if (!log || typeof log !== 'object') continue;

      const repaired = {};
      let changed = false;

      for (const [key, value] of Object.entries(log)) {
        if (typeof value === 'number') {
          // Already a plain count. Re-encode the key anyway (a no-op for
          // keys that never had a "." in them, which is every already-good
          // entry) so every entry in the document ends up in the same
          // encoded format that index.js/admin.js now expect. Uses += in
          // case a corrupted entry below also reconstructs into this same
          // real id.
          const encoded = encodeIdKey(key);
          repaired[encoded] = (repaired[encoded] || 0) + value;
          continue;
        }

        if (value && typeof value === 'object') {
          // Corrupted shape: key "234801234567@c" holding { us: 19 }
          // instead of a real id "234801234567@c.us" holding 19. WhatsApp
          // ids only ever contain one "." (in "@c.us"), so a single level
          // of reconstruction (key + "." + subKey) covers every real case.
          for (const [subKey, count] of Object.entries(value)) {
            if (typeof count !== 'number') continue;
            const realId = `${key}.${subKey}`;
            const encoded = encodeIdKey(realId);
            repaired[encoded] = (repaired[encoded] || 0) + count;
            changed = true;
          }
          continue;
        }
        // Anything else (null, string, etc.) is unexpected — drop it
        // rather than guess, and log so it can be checked manually.
        console.log(`  ⚠️ Skipped unrecognized activityLog entry in group ${doc.id}: ${key} =`, value);
      }

      if (!changed) continue;

      await Group.updateOne({ _id: doc._id }, { $set: { activityLog: repaired } });
      fixedGroups++;
      fixedEntries += Object.values(repaired).length;
      console.log(`🔧 Repaired activityLog for group ${doc.id} (${Object.keys(repaired).length} entries)`);
    }

    console.log(`\n✅ Done. Repaired ${fixedGroups} group document(s).`);
    process.exit(0);
  } catch (err) {
    console.error('❌ Repair failed:', err);
    process.exit(1);
  }
})();
