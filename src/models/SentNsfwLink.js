const mongoose = require('mongoose');

// ─── SentNsfwLink (.ehentai / .nhentai dedup) ──────────────────────────────
// Every gallery link the bot actually sends is recorded here so the same
// link is never sent again. Same reasoning as SentPin/SentNews: a permanent
// Mongo-backed flag, unique index enforces no-duplicates at the DB level,
// no scheduler needed on Termux.
//
// `source` distinguishes e-hentai from nhentai. `query` keeps the search the
// link came from (informational). `title` is stored so future features can
// show what a link was without refetching.
const SentNsfwLinkSchema = new mongoose.Schema({
  source: { type: String, required: true, enum: ['ehentai', 'nhentai'] },
  url: { type: String, required: true },
  galleryId: { type: String, default: null },
  title: { type: String, default: '' },
  query: { type: String, default: '' },
  sentAt: { type: Date, default: Date.now },
});

// The same gallery must never be flagged twice, even across restarts/queries
SentNsfwLinkSchema.index({ url: 1 }, { unique: true });

module.exports = mongoose.model('SentNsfwLink', SentNsfwLinkSchema);
