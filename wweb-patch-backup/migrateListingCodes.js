// Run once after deploying the shop/trading short-code update:
//   node migrateListingCodes.js
//
// Backfills a `code` on every existing OwnedCard and Auction document that
// doesn't have one yet. Safe to re-run — anything already migrated is skipped.

const mongoose = require('mongoose');
require('dotenv').config();

const { OwnedCard, Auction } = require('./models/Card');

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // skips ambiguous 0/O/1/I
  let id = '';
  for (let i = 0; i < 6; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

async function assignCodes(Model, label) {
  const docs = await Model.find();
  let updated = 0;

  for (const doc of docs) {
    if (doc.code) continue;

    let code;
    while (true) {
      code = generateCode();
      const exists = await Model.findOne({ code });
      if (!exists) break;
    }

    doc.code = code;
    await doc.save();

    console.log(`[${label}] ${doc.name || doc.cardName || doc._id} -> ${code}`);
    updated++;
  }

  console.log(`\n✅ Migrated ${updated} ${label} document(s).`);
}

(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);

    await assignCodes(OwnedCard, 'OwnedCard');
    await assignCodes(Auction, 'Auction');

    process.exit();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
