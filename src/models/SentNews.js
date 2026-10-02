const mongoose = require('mongoose');

// Same shape/purpose as models/SentPin.js and models/SentWallpaper.js — one
// record per (chat, article) pair, so a chat is never sent the same article
// twice across either .news or the daily auto-broadcast (both draw from the
// same feed and both check this).
const SentNewsSchema = new mongoose.Schema({
  chatId: { type: String, required: true },
  // The article's Google News link — stable and unique per article, so it
  // doubles as that article's identity here (same role pinId/wallpaperId
  // play in the two models above).
  articleId: { type: String, required: true },
  // TTL: auto-deleted 30 days after being sent. By then the article has
  // long since rotated out of Google News' own feed anyway, so keeping the
  // record around forever would only cost storage (see this project's
  // 512MB MongoDB limit, noted in models/User.js's AgeVerification-style
  // TTL comments) for zero remaining dedup value.
  sentAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 30 },
});

// One chat can't have the same article recorded twice
SentNewsSchema.index({ chatId: 1, articleId: 1 }, { unique: true });

module.exports = mongoose.model('SentNews', SentNewsSchema);
