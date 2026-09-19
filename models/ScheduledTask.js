const mongoose = require('mongoose');

// One collection backing the whole app's persistent scheduler
// (utils/scheduler.js) instead of a separate setTimeout/setInterval — and a
// separate ad-hoc "expiry" field/lazy-cleanup pattern — for every "do this
// later" feature (card-lend auto-return today; timed mutes, card-drop
// intervals, etc. as they migrate over next).
//
// A task's existence in this collection IS its "pending" state: the
// scheduler deletes a task the moment it's claimed to run, or the moment
// it's explicitly cancelled (e.g. an early .unlendcard). Nothing lingers
// here afterward — no separate status field to keep in sync — which keeps
// this collection tiny. That matters: AniChan's MongoDB Atlas tier has a
// 512MB storage cap, and this table can otherwise see a lot of churn (a
// card-lend or timed-mute row per action, across every user/group).
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
}, { timestamps: true });

module.exports = mongoose.model('ScheduledTask', ScheduledTaskSchema);
