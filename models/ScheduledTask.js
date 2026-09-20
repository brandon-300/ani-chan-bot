const mongoose = require('mongoose');

// One collection backing the whole app's persistent scheduler
// (utils/scheduler.js) instead of a separate setTimeout/setInterval — and a
// separate ad-hoc "expiry" field/lazy-cleanup pattern — for every "do this
// later" feature (card-lend auto-return today; timed mutes, card-drop
// intervals, etc. as they migrate over next).
//
// A task's existence in this collection with status 'pending' IS its
// "waiting to run" state. Unlike the original version of this model, a
// task is NOT deleted the instant it's picked up — it's marked 'running'
// first, then only deleted on confirmed success. That's what lets the
// scheduler retry a task whose handler actually failed instead of losing
// it forever (see utils/scheduler.js for the claim/retry logic). This
// still keeps the collection small in the common case: a successful task
// (the overwhelming majority) is deleted just as before, one write later
// than it used to be.
const ScheduledTaskSchema = new mongoose.Schema({
  // What kind of task this is. The scheduler looks up the handler that was
  // registered for this type via scheduler.registerHandler(type, fn) —
  // e.g. 'card_lend_return'.
  type: { type: String, required: true, index: true },
  // Unique key used to find/dedupe/cancel this specific task — e.g.
  // `lend:<cardId>`. Re-scheduling the same key (scheduleTask does an
  // upsert) replaces the pending task instead of creating a second one.
  key: { type: String, required: true, unique: true },
  // When this task should fire.
  runAt: { type: Date, required: true, index: true },
  // Whatever the handler needs at execution time (IDs, chat id, a display
  // name, etc.) — shape differs per task type, so left as Mixed rather than
  // declared field-by-field here.
  payload: { type: mongoose.Schema.Types.Mixed, default: {} },

  // ── Retry lifecycle (new) ────────────────────────────────────────────
  // 'pending' = waiting for its timer / eligible to be picked up next.
  // 'running' = currently being executed by runDueTask() (or was, when the
  //             process died mid-handler — see scheduler.init()'s startup
  //             recovery, which resets any 'running' row back to
  //             'pending' since this app only ever runs one instance).
  // 'failed'  = exhausted its retry attempts. Left in place on purpose
  //             (not deleted) so it's visible for manual inspection —
  //             armNext() ignores anything that isn't 'pending', so a
  //             failed task never spins forever.
  status: { type: String, enum: ['pending', 'running', 'failed'], default: 'pending', index: true },
  // How many times this task has been claimed and handed to its handler.
  // Incremented at claim time (before the handler runs), so a crash mid-
  // handler still counts as an attempt when recovered on restart.
  attempts: { type: Number, default: 0 },
  // Set while a task is 'running', to roughly when its attempt should be
  // considered stale. Not currently used to force-reclaim a task early
  // (this app is single-instance, so nothing else would try) — kept as a
  // diagnostic breadcrumb and a hook for future multi-instance safety.
  lockedUntil: { type: Date, default: null },
  // Message from the most recent failed attempt, if any. Cleared whenever
  // the task is freshly (re)scheduled via scheduleTask.
  lastError: { type: String, default: null },
}, { timestamps: true });

// Supports armNext()'s "nearest pending task" query directly with an
// index, rather than scanning every row (including 'running'/'failed'
// ones) to find the soonest 'pending' one.
ScheduledTaskSchema.index({ status: 1, runAt: 1 });

module.exports = mongoose.model('ScheduledTask', ScheduledTaskSchema);
