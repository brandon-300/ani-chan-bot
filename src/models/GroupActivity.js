const mongoose = require('mongoose');

// Per-(group, user) message-activity counter — replaces the old
// Group.activityLog Map field. That field required a full load -> read
// count -> increment -> save() cycle on the WHOLE Group document for every
// single group message (see index.js's message handler), which is a
// classic lost-update race: two messages processed close together could
// both read the same stale count and whichever save() finished last would
// silently discard the other's increment. This collection uses one atomic
// $inc instead, so there's nothing to race.
//
// A dedicated collection (rather than trying to $inc straight into a Map
// field) also sidesteps a real bug the old code hit: WhatsApp ids contain
// literal "." characters, and Mongo's dot-path update syntax
// ("activityLog.234...@c.us") splits on every ".", corrupting the write
// into a nested object instead of a number. Here userId is a plain VALUE
// in a query filter, not part of a dynamically-built path string, so that
// whole class of problem doesn't apply — no more "~"-encoding a WhatsApp
// id just to use it as a Map key.
const GroupActivitySchema = new mongoose.Schema({
  groupId: { type: String, required: true },
  userId: { type: String, required: true },
  count: { type: Number, default: 0 },
  lastAt: { type: Date, default: Date.now },
});

// findOneAndUpdate's upsert relies on this being unique per (groupId,
// userId) pair.
GroupActivitySchema.index({ groupId: 1, userId: 1 }, { unique: true });
// .activity/.inactive (commands/admin.js) both query and sort by count
// within one group.
GroupActivitySchema.index({ groupId: 1, count: -1 });

module.exports = mongoose.model('GroupActivity', GroupActivitySchema);
