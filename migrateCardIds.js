const mongoose = require('mongoose');
require('dotenv').config();

const { CardCatalogue, OwnedCard } = require('./models/Card');

function generateId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // skips ambiguous 0/O/1/I
  let id = '';

  for (let i = 0; i < 6; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }

  return id;
}

(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);

    const cards = await CardCatalogue.find();

    let updated = 0;

    for (const card of cards) {

      // Skip cards already migrated
      if (card.cardId) continue;

      let cardId;

      while (true) {
        cardId = generateId();

        const exists = await CardCatalogue.findOne({ cardId });

        if (!exists) break;
      }

      // Save old Mongo ID
      const oldId = card._id.toString();

      // Assign new short ID
      card.cardId = cardId;
      await card.save();

      // Update owned cards
      await OwnedCard.updateMany(
        { catalogueId: oldId },
        { $set: { catalogueId: cardId } }
      );

      console.log(`${card.name} -> ${cardId}`);

      updated++;
    }

    console.log(`\n✅ Migrated ${updated} cards.`);

    process.exit();

  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
