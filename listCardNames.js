/**
 * List all catalogue cards: name + series for manual image hunting.
 * Usage: node listCardNames.js
 *        node listCardNames.js --missing-only
 */
require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const { CardCatalogue } = require('./models/Card');

const args = process.argv.slice(2);
const MISSING_ONLY = args.includes('--missing-only');

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI is not set in .env');
    process.exit(1);
  }

  await mongoose.connect(uri);

  const filter = MISSING_ONLY
    ? { $or: [{ imageUrl: { $exists: false } }, { imageUrl: '' }, { imageUrl: null }] }
    : {};

  const cards = await CardCatalogue.find(filter)
    .select('cardId name series aliases imageUrl imageSource imageReviewStatus')
    .sort({ series: 1, name: 1 })
    .lean();

  console.log('Found ' + cards.length + ' card(s)' + (MISSING_ONLY ? ' with missing imageUrl' : '') + '\n');

  if (!cards.length) {
    await mongoose.disconnect();
    return;
  }

  const lines = cards.map(function (c, i) {
    const n = String(i + 1).padStart(3, ' ');
    const id = c.cardId || '(no id)';
    const img = c.imageUrl ? 'has image' : 'NO IMAGE';
    return n + '. [' + id + '] ' + c.name + '  —  ' + c.series + '  (' + img + ')';
  });
  const textOut = lines.join('\n') + '\n';
  fs.writeFileSync('card-names.txt', textOut, 'utf8');
  console.log(textOut);
  console.log('Wrote card-names.txt');

  function esc(v) {
    return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  }
  const header = ['cardId', 'name', 'series', 'aliases', 'imageUrl', 'imageSource', 'imageReviewStatus'];
  const rows = cards.map(function (c) {
    return [
      c.cardId,
      c.name,
      c.series,
      (c.aliases || []).join('; '),
      c.imageUrl || '',
      c.imageSource || '',
      c.imageReviewStatus || '',
    ].map(esc).join(',');
  });
  fs.writeFileSync('card-names.csv', header.join(',') + '\n' + rows.join('\n') + '\n', 'utf8');
  console.log('Wrote card-names.csv');

  const searchLines = cards.map(function (c) {
    return c.name + ' ' + c.series;
  }).join('\n') + '\n';
  fs.writeFileSync('card-search-queries.txt', searchLines, 'utf8');
  console.log('Wrote card-search-queries.txt');

  await mongoose.disconnect();
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
