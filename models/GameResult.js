const mongoose = require('mongoose');
const schema = new mongoose.Schema(
  {
    chatId: { type: String, required: true },
    players: [String],
    text: { type: String, required: true },
  },
  { timestamps: true }
);
module.exports = mongoose.model('GameResult', schema);
