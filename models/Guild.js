const mongoose = require('mongoose');

const GuildSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  leaderId: { type: String, required: true },
  members: { type: [String], default: [] },
  pendingInvites: { type: [String], default: [] },
  emblem: { type: String, default: '🏰' },
  level: { type: Number, default: 1 },
  xp: { type: Number, default: 0 },
  bank: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Guild', GuildSchema);
