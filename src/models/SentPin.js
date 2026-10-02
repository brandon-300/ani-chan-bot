const mongoose = require('mongoose');

const SentPinSchema = new mongoose.Schema({
  chatId: { type: String, required: true },
  pinId: { type: String, required: true },
  sentAt: { type: Date, default: Date.now },
});

// One chat can't have the same pin recorded twice
SentPinSchema.index({ chatId: 1, pinId: 1 }, { unique: true });

module.exports = mongoose.model('SentPin', SentPinSchema);
