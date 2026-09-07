const mongoose = require('mongoose');

// A record of an owner-triggered, one-off celebration affecting every
// guild at once (e.g. "Anniversary Event — 50,000 bonus coins for every
// guild!") — see .guildevent in commands/guilds.js.
//
// Deliberately NOT an ongoing rate-multiplier (no "double rewards this
// weekend" mechanic) — that would require the quest/mission generation
// functions in models/Guild.js (ensureActiveQuest/ensureActiveMission,
// currently synchronous, in-memory, callable from the equally-synchronous
// applyQuestProgress) to become async so they could query this collection,
// which ripples out through every caller of applyQuestProgress. This is
// an instant, one-time payout instead: safe, simple, and doesn't touch
// that tested code path at all. history is kept (not just applied and
// forgotten) purely so .guild info can mention a recent event for a few
// days afterward.
const GuildEventSchema = new mongoose.Schema({
  message: { type: String, required: true },
  coinsPerGuild: { type: Number, required: true },
  guildsAffected: { type: Number, required: true },
  triggeredBy: { type: String, required: true },
  triggeredAt: { type: Number, default: () => Date.now() },
});

module.exports = mongoose.model('GuildEvent', GuildEventSchema);
