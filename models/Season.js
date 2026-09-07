const mongoose = require('mongoose');

// Global season state — ONE document total, not one per guild. Every other
// piece of the guild system so far (quests, missions, challenges, shop) is
// scoped to a single guild; a season is a competition BETWEEN every guild
// at once, so the clock itself has to be shared rather than living on any
// one Guild document.
const SeasonSchema = new mongoose.Schema({
  seasonNumber: { type: Number, required: true },
  startedAt: { type: Number, required: true },
  endsAt: { type: Number, required: true },
  // Flips to true the moment a season's winner has been paid out and
  // every guild's seasonReputation has been reset — see
  // _resolveSeasonIfDue in commands/guilds.js. Doubles as the atomic
  // "claim" a resolver uses so two people checking .guild season at
  // nearly the same moment can't both pay out the same season's reward.
  resolved: { type: Boolean, default: false },
});

module.exports = mongoose.model('Season', SeasonSchema);
