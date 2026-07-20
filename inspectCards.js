const mongoose = require('mongoose');
require('dotenv').config();

const { CardCatalogue } = require('./models/Card');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);

  const total = await CardCatalogue.countDocuments();
  console.log("Total cards:", total);

  const cards = await CardCatalogue.find().limit(10);

  console.log("\nFirst 10 cards:\n");

  cards.forEach(card => {
    console.log({
      id: card._id,
      name: card.name,
      series: card.series,
      tier: card.tier,
      imageUrl: card.imageUrl
    });
  });

  process.exit();
})();
