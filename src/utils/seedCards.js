// Run this anytime: node utils/seedCards.js
require('dotenv').config();
const mongoose = require('mongoose');
const { CardCatalogue } = require('../models/Card');

const cards = [
  // ── Anime Series ──
  { name: 'Rem', series: 'Re:Zero', tier: 'A' },
  { name: 'Emilia', series: 'Re:Zero', tier: 'A' },
  { name: 'Beatrice', series: 'Re:Zero', tier: 'S' },
  { name: 'Asuna', series: 'Sword Art Online', tier: 'A' },
  { name: 'Kirito', series: 'Sword Art Online', tier: 'B' },
  { name: 'Levi', series: 'Attack on Titan', tier: 'SS' },
  { name: 'Mikasa', series: 'Attack on Titan', tier: 'S' },
  { name: 'Eren', series: 'Attack on Titan', tier: 'A' },
  { name: 'Naruto', series: 'Naruto', tier: 'S' },
  { name: 'Sasuke', series: 'Naruto', tier: 'S' },
  { name: 'Sakura', series: 'Naruto', tier: 'B' },
  { name: 'Goku', series: 'Dragon Ball Z', tier: 'SSS' },
  { name: 'Vegeta', series: 'Dragon Ball Z', tier: 'SS' },
  { name: 'Frieza', series: 'Dragon Ball Z', tier: 'SS' },
  { name: 'Luffy', series: 'One Piece', tier: 'SS' },
  { name: 'Zoro', series: 'One Piece', tier: 'S' },
  { name: 'Nami', series: 'One Piece', tier: 'A' },
  { name: 'Zero Two', series: 'Darling in the FranXX', tier: 'SSS' },
  { name: 'Ichigo', series: 'Darling in the FranXX', tier: 'B' },
  { name: 'Aqua', series: 'KonoSuba', tier: 'B' },
  { name: 'Megumin', series: 'KonoSuba', tier: 'A' },
  { name: 'Darkness', series: 'KonoSuba', tier: 'A' },
  { name: 'Ai Hoshino', series: 'Oshi no Ko', tier: 'SSS' },
  { name: 'Ruby Hoshino', series: 'Oshi no Ko', tier: 'S' },
  { name: 'Kaguya Shinomiya', series: 'Kaguya-sama', tier: 'SS' },
  { name: 'Chika Fujiwara', series: 'Kaguya-sama', tier: 'A' },
  { name: 'Nezuko', series: 'Demon Slayer', tier: 'SS' },
  { name: 'Tanjiro', series: 'Demon Slayer', tier: 'S' },
  { name: 'Rengoku', series: 'Demon Slayer', tier: 'S' },
  { name: 'Inosuke', series: 'Demon Slayer', tier: 'A' },
  { name: 'Gojo Satoru', series: 'Jujutsu Kaisen', tier: 'SSS' },
  { name: 'Yuji Itadori', series: 'Jujutsu Kaisen', tier: 'A' },
  { name: 'Megumi', series: 'Jujutsu Kaisen', tier: 'A' },
  { name: 'Nobara', series: 'Jujutsu Kaisen', tier: 'B' },
  { name: 'Marin Kitagawa', series: 'My Dress-Up Darling', tier: 'SS' },
  { name: 'Yor Forger', series: 'Spy x Family', tier: 'SS' },
  { name: 'Anya Forger', series: 'Spy x Family', tier: 'S' },
  { name: 'Loid Forger', series: 'Spy x Family', tier: 'A' },
  { name: 'Raiden Shogun', series: 'Genshin Impact', tier: 'SSS' },
  { name: 'Hu Tao', series: 'Genshin Impact', tier: 'SS' },
  { name: 'Ganyu', series: 'Genshin Impact', tier: 'SS' },
  { name: 'Ayaka', series: 'Genshin Impact', tier: 'S' },
  { name: 'Venti', series: 'Genshin Impact', tier: 'S' },
  { name: 'Mori Calliope', series: 'Hololive EN', tier: 'SS' },
  { name: 'Gawr Gura', series: 'Hololive EN', tier: 'S' },
  { name: 'Ninomae Inanis', series: 'Hololive EN', tier: 'A' },
  // ── Common fillers ──
  { name: 'Slime', series: 'Common', tier: 'C' },
  { name: 'Goblin', series: 'Common', tier: 'C' },
  { name: 'Fairy', series: 'Common', tier: 'C' },
  { name: 'Witch', series: 'Common', tier: 'B' },
  { name: 'Knight', series: 'Common', tier: 'B' },
];

async function main() {
  try {
    if (!process.env.MONGO_URI) {
      throw new Error('MONGO_URI is missing in your environment variables.');
    }

    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ MongoDB connected');

    const ops = cards.map((card) => ({
      updateOne: {
        filter: {
          name: card.name,
          series: card.series,
        },
        update: {
          $set: {
            name: card.name,
            series: card.series,
            tier: card.tier,
          },
        },
        upsert: true,
      },
    }));

    const result = await CardCatalogue.bulkWrite(ops, { ordered: false });

    const upserted = result.upsertedCount || 0;
    const modified = result.modifiedCount || 0;
    const matched = result.matchedCount || 0;

    console.log(`🌱 Card seeding complete`);
    console.log(`📚 Total cards in file: ${cards.length}`);
    console.log(`➕ Newly added: ${upserted}`);
    console.log(`🔄 Updated: ${modified}`);
    console.log(`✅ Matched existing: ${matched}`);

    await mongoose.disconnect();
    console.log('✅ MongoDB disconnected');
  } catch (err) {
    console.error('❌ Seed failed:', err.message);
    try {
      await mongoose.disconnect();
    } catch {}
    process.exitCode = 1;
  }
}

main();