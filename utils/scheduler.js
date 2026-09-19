const ScheduledTask = require('../models/ScheduledTask');

// ─── Central persistent scheduler ──────────────────────────────────────────
// One Mongo-backed timer for the whole app, instead of one setTimeout per
// lent card / timed mute / card-drop interval / etc. Every feature that
// owns a kind of "do this later" task registers a handler for its task
// type ONCE (at require time, via registerHandler — see commands/cards.js
// for the card-lend example), then calls scheduleTask(...) instead of
// setTimeout(...), and cancelTask(...) instead of clearTimeout(...).
//
// A single re-armable setTimeout always points at whichever pending task
// is due soonest. When it fires, that task is claimed (deleted) and run
// via its registered handler, then the next-nearest task is loaded and
// armed. This scales to any number of pending tasks without holding one
// timer handle per task, and — because runAt lives in Mongo, not in RAM —
// survives PM2 restarts: call init(client) once on 'ready' and whatever
// was pending picks back up.
//
// Usage:
//   scheduler.registerHandler('card_lend_return', async (payload, client) => { ... });
//   await scheduler.scheduleTask({ type: 'card_lend_return', key: `lend:${cardId}`, runAt, payload });
//   await scheduler.cancelTask(`lend:${cardId}`); // e.g. an early .unlendcard

const handlers = new Map();
let client = null;
let timer = null;
let armedKey = null;

// Longest a single setTimeout is allowed to wait before waking up and
// re-checking Mongo for the next task, rather than holding one huge timer.
// Keeps us well under Node's ~24.8-day signed 32-bit setTimeout ceiling,
// and means a task scheduled far in the future still gets armed exactly
// (not fired early) once it's actually within this window.
const MAX_DELAY_MS = 6 * 60 * 60 * 1000; // 6 hours

// Registers what to actually do when a task of this type comes due.
// Call once per type, at module load (not inside a command handler) — see
// commands/cards.js. Re-registering the same type overwrites the handler.
function registerHandler(type, handler) {
  handlers.set(type, handler);
}

// Schedules (or re-schedules, if `key` already exists) a task. Always
// re-arms the timer afterward in case this new task is now the soonest
// pending one.
async function scheduleTask({ type, key, runAt, payload = {} }) {
  if (!type || !key || !runAt) {
    throw new Error('scheduler.scheduleTask requires type, key, and runAt');
  }
  await ScheduledTask.findOneAndUpdate(
    { key },
    { type, key, runAt, payload },
    { upsert: true, setDefaultsOnInsert: true }
  );
  await armNext();
}

// Like scheduleTask, but does nothing if a task with this key already
// exists. Needed for boot-time resume of RECURRING tasks (e.g. a group's
// next card drop): scheduleTask's upsert would overwrite an already-correct
// pending runAt with a fresh "now + interval" on every single restart,
// wrongly resetting a countdown that was already partway through instead
// of resuming it. This only creates + arms a new task the first time a
// given key is ever seen.
async function scheduleIfMissing({ type, key, runAt, payload = {} }) {
  if (!type || !key || !runAt) {
    throw new Error('scheduler.scheduleIfMissing requires type, key, and runAt');
  }
  await ScheduledTask.findOneAndUpdate(
    { key },
    { $setOnInsert: { type, key, runAt, payload } },
    { upsert: true }
  );
  // Harmless if this was a no-op (key already existed) — armNext() just
  // re-confirms the current nearest task, which hasn't changed.
  await armNext();
}

// Cancels a pending task early (e.g. .unlendcard returning a card before
// its 1-hour timer). Safe to call on a key that doesn't exist / already
// fired — it's just a no-op delete.
async function cancelTask(key) {
  await ScheduledTask.deleteOne({ key }).catch(err => {
    console.error('scheduler: cancelTask failed:', err.message);
  });
  // Only need to actively re-arm if we just deleted whatever the live
  // timer was specifically waiting on — otherwise the nearest task hasn't
  // changed and the current timer (or far-future wake-up tick) is still
  // correct.
  if (armedKey === key) {
    await armNext();
  }
}

function clearTimer() {
  if (timer) clearTimeout(timer);
  timer = null;
  armedKey = null;
}

// Finds the single nearest pending task and arms exactly one setTimeout
// for it, clearing/replacing whatever was armed before. Cheap (one indexed
// Mongo query + a timer swap) — safe to call as often as scheduleTask/
// cancelTask like, and it's how init() picks back up after a restart.
async function armNext() {
  const next = await ScheduledTask.findOne().sort({ runAt: 1 }).catch(err => {
    console.error('scheduler: armNext lookup failed:', err.message);
    return null;
  });

  clearTimer();
  if (!next) return;

  const remaining = next.runAt.getTime() - Date.now();

  if (remaining > MAX_DELAY_MS) {
    // Genuinely not due within our re-check window yet — just wake up and
    // re-evaluate later instead of holding a multi-day timer (or, worse,
    // firing this specific task early). armedKey stays null: we're not
    // actually committed to THIS task yet, only to checking again.
    timer = setTimeout(() => { armNext(); }, MAX_DELAY_MS);
    return;
  }

  armedKey = next.key;
  timer = setTimeout(() => runDueTask(next.key), Math.max(0, remaining));
}

// Claims (deletes) the task by key and runs its registered handler. Claim
// happens BEFORE the handler runs, so a task can never fire twice and a
// handler that throws doesn't get retried forever on every future restart.
async function runDueTask(key) {
  const task = await ScheduledTask.findOneAndDelete({ key }).catch(err => {
    console.error('scheduler: claim failed:', err.message);
    return null;
  });

  if (task) {
    const handler = handlers.get(task.type);
    if (handler) {
      try {
        await handler(task.payload, client);
      } catch (err) {
        console.error(`scheduler: handler for "${task.type}" threw:`, err.message);
      }
    } else {
      console.error(`scheduler: no handler registered for task type "${task.type}" (key: ${key})`);
    }
  }
  // else: already cancelled a moment earlier — nothing to do.

  // Whether that task ran, threw, or had already been cancelled, load
  // whatever's next.
  await armNext();
}

// Call once from index.js's client.on('ready') handler. Loads the nearest
// task that survived a PM2 restart (if any) and arms the first timer.
// Handlers should already be registered by this point (registerHandler
// calls run at module require time, which happens well before 'ready').
async function init(readyClient) {
  client = readyClient;
  await armNext();
}

module.exports = { registerHandler, scheduleTask, scheduleIfMissing, cancelTask, init };
