const mongoose = require('mongoose');

// A time-boxed reputation race between two guilds — the guild-vs-guild
// competition system. Kept as its own collection rather than embedded on
// either Guild document, since a challenge is inherently about TWO guilds
// and needs one shared source of truth both sides read from — embedding
// it on one guild would mean keeping a second, easily-out-of-sync copy on
// the other.
const GuildChallengeSchema = new mongoose.Schema({
  challengerGuildId: { type: String, required: true },
  challengedGuildId: { type: String, required: true },
  status: { type: String, enum: ['pending', 'active', 'completed', 'declined', 'cancelled'], default: 'pending' },
  // Reputation snapshots taken the moment the challenge is ACCEPTED, not
  // when it's proposed — so the racing window is exactly the same length
  // for both guilds regardless of how long the challenged guild took to
  // respond. Reputation (not level/xp/bank) is the metric on purpose: it's
  // already the one guild stat that specifically resists being rushed —
  // see models/Guild.js's `reputation` field comment.
  startRepChallenger: { type: Number, default: 0 },
  startRepChallenged: { type: Number, default: 0 },
  startedAt: { type: Number, default: null },
  endsAt: { type: Number, default: null },
  winnerGuildId: { type: String, default: null }, // a Guild _id string, or 'tie'
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('GuildChallenge', GuildChallengeSchema);
