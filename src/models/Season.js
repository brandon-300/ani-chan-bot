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
  // Replaces the old plain `resolved: Boolean` with a real state machine —
  // see _resolveSeasonIfDue in commands/guilds.js for the full walk
  // through. 'resolving' is the important addition: it's the atomic claim
  // a resolver uses so two people checking .guild season at nearly the
  // same moment can't both start paying out the same season, AND it's
  // what lets a resolution that got interrupted (bot crash/restart
  // mid-payout) be picked back up and finished on the next check instead
  // of leaving the season permanently stuck between "ended" and "next
  // season exists".
  status: { type: String, enum: ['active', 'resolving', 'completed'], default: 'active' },
  // The next three fields exist so each individual step of resolving a
  // season (decide winner -> pay winner -> reset every guild -> create
  // next season) can be safely re-run after a crash without re-deciding
  // a different winner from already-reset data, or double-paying, or
  // creating a duplicate next season. null = "not decided yet"; 'none' =
  // "decided, nobody qualified"; a Guild _id string = the winner.
  winnerGuildId: { type: String, default: null },
  payoutComplete: { type: Boolean, default: false },
  guildsResetComplete: { type: Boolean, default: false },
});

module.exports = mongoose.model('Season', SeasonSchema);
