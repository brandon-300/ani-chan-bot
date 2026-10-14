const mongoose = require('mongoose');

// Per-(group, user) warning counter for .antibot (commands/antibot.js).
// Same shape and reasoning as models/GroupActivity.js: one atomic $inc
// upsert per detected bot message, so two messages arriving close together
// can't both read a stale count, and the WhatsApp id is a plain query VALUE
// (never part of a dotted update path).
//
// A document is deleted when the bot account is removed from the group, so
// a bot that is later re-added starts again from 0.
const AntibotWarnSchema = new mongoose.Schema({
  groupId: { type: String, required: true },
  userId: { type: String, required: true },
  count: { type: Number, default: 0 },
  lastAt: { type: Date, default: Date.now },
});

// findOneAndUpdate's upsert relies on this being unique per pair.
AntibotWarnSchema.index({ groupId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('AntibotWarn', AntibotWarnSchema);
