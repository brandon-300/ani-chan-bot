const mongoose = require('mongoose');

const SentWallpaperSchema = new mongoose.Schema({
  chatId: { type: String, required: true },
  wallpaperId: { type: String, required: true },
  sentAt: { type: Date, default: Date.now },
});

// One chat can't have the same wallpaper recorded twice
SentWallpaperSchema.index({ chatId: 1, wallpaperId: 1 }, { unique: true });

module.exports = mongoose.model('SentWallpaper', SentWallpaperSchema);
