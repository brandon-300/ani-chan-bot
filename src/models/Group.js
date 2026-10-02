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
  muteUntil: { type: Date, default: null }, // when a timed .mute should auto-unmute; null = indefinite mute (or not muted)
  muteDurationLabel: { type: String, default: null }, // raw duration text (e.g. "30s") for the auto-unmute notice, kept so it survives a restart
  blacklist: { type: [String], default: [] },
  nsfw: { type: Boolean, default: false },
  cardsEnabled: { type: Boolean, default: false },
  activeCardId: { type: String, default: null },
  activeCardCode: { type: String, default: null },
  activeCardExpiresAt: { type: Date, default: null },
  cardDropInterval: { type: Number, default: 0 },  // ms between drops
  lastDrop: { type: Number, default: 0 },
  messageCount: { type: Number, default: 0 },
  // LEGACY — superseded by the GroupActivity collection (models/GroupActivity.js).
  // Nothing writes to this anymore; kept only so index.js's one-time
  // migrateGroupActivityLog() can still read old data out of it. Safe to
  // drop from the schema entirely once you're confident that migration has
  // run for every group that had data here (check for any
  // "GroupActivity migration failed" lines in the logs).
  activityLog: { type: Map, of: Number, default: {} }, // userId -> message count
  rules: { type: String, default: null }, // null = not set yet, per .rules/.setrules
});

module.exports = mongoose.model('Group', GroupSchema);
