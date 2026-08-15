const mongoose = require('mongoose');

// One document per unique (group, user, command) combination — incremented
// atomically on every use rather than logging every single invocation
// forever, so this collection stays small and cheap to query even after
// months of activity (same "counters, not raw logs" idea as Group's
// messageCount/activityLog).
const CommandUsageSchema = new mongoose.Schema({
  // 'DM' for command usage outside of any group.
  groupId: { type: String, required: true, index: true },
  userId: { type: String, required: true, index: true },
  command: { type: String, required: true, index: true },
  count: { type: Number, default: 0 },
  // Number of outbound HTTP requests (axios/fetch) this exact
  // group+user+command combination has triggered in total. Populated by
  // utils/usageTracking.js, which detects calls automatically at the
  // network layer — not a manually maintained per-command list — so this
  // can't silently go stale as new commands or external APIs get added.
  apiCallCount: { type: Number, default: 0 },
  lastUsed: { type: Date, default: Date.now },
});

CommandUsageSchema.index({ groupId: 1, userId: 1, command: 1 }, { unique: true });

module.exports = mongoose.model('CommandUsage', CommandUsageSchema);
