const mongoose = require('mongoose');

// Global season state — ONE document total, not one per guild. Every other
// piece of the guild system so far (quests, missions, challenges, shop) is
// scoped to a single guild; a season is a competition BETWEEN every guild
// at once, so the clock itself has to be shared rather than living on any
// one Guild document.
const SeasonSchema = new mongoose.Schema({
  seasonNumber: { type: Number, required: true, unique: true },
  startedAt: { type: Number, required: true },
  endsAt: { type: Number, required: true },
  // New payouts and completion commit together. 'resolving' is retained
  // for old interrupted rows, which are closed without another payment.
  status: { type: String, enum: ['active', 'resolving', 'completed'], default: 'active' },
  // Historical winner/recovery flags are retained as recorded. Closure
  // does not infer whether a legacy payout or reset actually happened.
  // True for an old interrupted payout closed by policy, without another award.
  closedWithoutPayment: { type: Boolean, default: false },
  closedAt: { type: Date, default: null },
  winnerGuildId: { type: String, default: null },
  payoutComplete: { type: Boolean, default: false },
  guildsResetComplete: { type: Boolean, default: false },
});

module.exports = mongoose.model('Season', SeasonSchema);
