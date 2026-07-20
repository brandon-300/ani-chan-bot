const mongoose = require('mongoose');
require('dotenv').config();

const { OwnedCard } = require('./models/Card');

(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);

const cards = await OwnedCard.find().sort({ obtainedAt: 1 });

    const seen = new Set();
    let removed = 0;

    for (const card of cards) {
      const key = `${card.ownerId}:${card.catalogueId}`;

      if (seen.has(key)) {
        await OwnedCard.deleteOne({ _id: card._id });
        console.log(`🗑️ Deleted duplicate: ${card.name}`);
        removed++;
      } else {
        seen.add(key);
      }
    }

    console.log(`✅ Removed ${removed} duplicate card(s).`);
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
