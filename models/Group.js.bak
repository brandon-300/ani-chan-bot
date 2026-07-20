const mongoose = require('mongoose');

const GroupSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  antilink: { type: Boolean, default: false },
  antilinkAction: { type: String, default: 'warn' },  // 'warn' | 'kick'
  antispam: { type: Boolean, default: false },
  welcome: { type: Boolean, default: false },
  welcomeMsg: { type: String, default: '👋 Welcome to the group, @user!' },
  leave: { type: Boolean, default: false },
  leaveMsg: { type: String, default: '👋 @user has left the group.' },
  isOpen: { type: Boolean, default: true },
  isMuted: { type: Boolean, default: false },
  blacklist: { type: [String], default: [] },
  nsfw: { type: Boolean, default: false },
  cardsEnabled: { type: Boolean, default: false },
  activeCardId: { type: String, default: null },
  activeCardCode: { type: String, default: null },
  activeCardExpiresAt: { type: Date, default: null },
  cardDropInterval: { type: Number, default: 0 },  // ms between drops
  lastDrop: { type: Number, default: 0 },
  messageCount: { type: Number, default: 0 },
  activityLog: { type: Map, of: Number, default: {} }, // userId -> message count
});

module.exports = mongoose.model('Group', GroupSchema);
