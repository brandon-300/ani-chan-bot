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
// is due soonest. When it fires, that task is CLAIMED — marked 'running'
// and attempts incremented, but NOT deleted — and run via its registered
// handler. Only a handler that resolves without throwing gets its task
// deleted. A handler that throws is treated as a real failure: the task
// goes back to 'pending' with a backed-off runAt so it's retried, instead
// of vanishing forever the moment it was picked up. After MAX_ATTEMPTS
// failures it's marked 'failed' and left in place (not deleted, not
// retried again) so a permanently broken task doesn't spin forever and
// stays visible for manual inspection.
//
// This whole lifecycle only has teeth for handlers that actually throw on
// real failure — a handler that catches its own errors internally and
// returns normally still looks like a success from here. Auditing each
// task type's handler for that is separate follow-up work; this file is
// just the engine.
//
// Because runAt/status live in Mongo, not in RAM, all of this survives PM2
// restarts: call init(client) once on 'ready' and whatever was pending (or
// stuck 'running' from a mid-handler crash) picks back up.
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

// How long a claimed task is presumed to need before we'd consider it
// stale. Not used to force-reclaim anything today (single-instance app —
// nothing else would try), just recorded for visibility/future use.
const LEASE_MS = 5 * 60 * 1000; // 5 minutes

// Backoff before retrying a failed task, indexed by attempt number
// (attempts is 1 after the first failed try). Stays at the last value for
// every attempt beyond this list's length.
const RETRY_DELAYS_MS = [
  30 * 1000,        // after attempt 1: retry in 30s
  2 * 60 * 1000,     // after attempt 2: retry in 2min
  10 * 60 * 1000,    // after attempt 3: retry in 10min
  30 * 60 * 1000,    // after attempt 4+: retry in 30min
];

// After this many failed attempts, stop retrying and mark the task
// 'failed' instead. Tune if a particular task type needs more/fewer tries.
const MAX_ATTEMPTS = 6;

function backoffFor(attempts) {
  const idx = Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1);
  return RETRY_DELAYS_MS[idx];
}

// Registers what to actually do when a task of this type comes due.
// Call once per type, at module load (not inside a command handler) — see
// commands/cards.js. Re-registering the same type overwrites the handler.
function registerHandler(type, handler) {
  handlers.set(type, handler);
}

// Schedules (or re-schedules, if `key` already exists) a task. Always
// resets the retry state (status/attempts/lockedUntil/lastError) — a
// (re)schedule is a fresh occurrence of the task, not a continuation of a
// previous failed run, even if the same key was previously mid-retry.
// Explicit $set (rather than a bare replacement object) so this behaves
// the same regardless of Mongoose's implicit-update-operator handling.
// Always re-arms the timer afterward in case this new task is now the
// soonest pending one.
async function scheduleTask({ type, key, runAt, payload = {} }) {
  if (!type || !key || !runAt) {
    throw new Error('scheduler.scheduleTask requires type, key, and runAt');
  }
  await ScheduledTask.findOneAndUpdate(
    { key },
    {
      $set: {
        type, key, runAt, payload,
        status: 'pending',
        attempts: 0,
        lockedUntil: null,
        lastError: null,
      },
    },
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
// given key is ever seen — an existing key (pending, running, or even
// failed) is left completely untouched.
async function scheduleIfMissing({ type, key, runAt, payload = {} }) {
  if (!type || !key || !runAt) {
    throw new Error('scheduler.scheduleIfMissing requires type, key, and runAt');
  }
  await ScheduledTask.findOneAndUpdate(
    { key },
    { $setOnInsert: { type, key, runAt, payload, status: 'pending', attempts: 0 } },
    { upsert: true }
  );
  // Harmless if this was a no-op (key already existed) — armNext() just
  // re-confirms the current nearest task, which hasn't changed.
  await armNext();
}

// Cancels a pending task early (e.g. .unlendcard returning a card before
// its 1-hour timer). Safe to call on a key that doesn't exist / already
// fired / is currently 'running' — it's just a no-op delete either way. If
// it happens to be 'running' at this exact moment, the in-flight handler
// keeps executing (it already has its payload in memory); the row simply
// won't be there afterward for its success/failure update to match, which
// is harmless.
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

// Finds the single nearest PENDING task and arms exactly one setTimeout
// for it, clearing/replacing whatever was armed before. 'running' and
// 'failed' tasks are invisible here on purpose: a running task is already
// being handled by the in-flight runDueTask() call that claimed it, and a
// failed task has given up and should never be picked up again on its
// own. Cheap (one indexed Mongo query + a timer swap) — safe to call as
// often as scheduleTask/cancelTask like, and it's how init() picks back up
// after a restart.
async function armNext() {
  const next = await ScheduledTask.findOne({ status: 'pending' }).sort({ runAt: 1 }).catch(err => {
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

// Claims a due task and runs its registered handler. Claiming marks the
// task 'running' and increments attempts BEFORE the handler executes —
// this happens atomically (findOneAndUpdate matched on status: 'pending'),
// so the same task can't be claimed twice. The task is only deleted AFTER
// the handler resolves successfully; a handler that throws leaves the task
// in place for a retry (see failTask). This is the core fix over the old
// "delete first, execute second" design, where a handler failure meant the
// task was already gone and would never run again.
async function runDueTask(key) {
  const task = await ScheduledTask.findOneAndUpdate(
    { key, status: 'pending' },
    { $set: { status: 'running', lockedUntil: new Date(Date.now() + LEASE_MS) }, $inc: { attempts: 1 } },
    { new: true }
  ).catch(err => {
    console.error('scheduler: claim failed:', err.message);
    return null;
  });

  if (task) {
    const handler = handlers.get(task.type);
    if (!handler) {
      // Don't silently consume a task whose type has no registered
      // handler — that's a real misconfiguration (e.g. a typo'd type, or
      // a handler module that failed to load). Mark it failed instead of
      // deleting the evidence.
      const err = new Error(`No handler registered for task type "${task.type}"`);
      console.error(`scheduler: ${err.message} (key: ${key})`);
      await failTask(task, err);
    } else {
      try {
        await handler(task.payload, client);
        // Handler completed without throwing → treated as success.
        // Delete by _id AND status: 'running' — not just _id — so this
        // only removes the row if it's still exactly the claimed attempt
        // we ran. A self-rescheduling recurring handler (card_drop in
        // commands/cards.js) calls scheduleTask() on its OWN key mid-
        // handler to arm its next occurrence, which reuses this same
        // document (same _id, matched by the unique key) and flips its
        // status to 'pending' with a new runAt before we ever get here.
        // Without this guard, deleting unconditionally by _id would
        // destroy that freshly-armed next occurrence the instant it was
        // created, silently ending the recurring cycle after one run.
        await ScheduledTask.deleteOne({ _id: task._id, status: 'running' }).catch(err => {
          console.error('scheduler: post-success cleanup failed:', err.message);
        });
      } catch (err) {
        console.error(`scheduler: handler for "${task.type}" threw:`, err.message);
        await failTask(task, err);
      }
    }
  }
  // else: task wasn't 'pending' anymore when we tried to claim it —
  // already cancelled a moment earlier — nothing to do.

  // Whether that task succeeded, failed, or had already been cancelled,
  // load whatever's next.
  await armNext();
}

// Records a handler failure. Retries with backoff (task goes back to
// 'pending' with a future runAt) until MAX_ATTEMPTS is reached, at which
// point the task is marked 'failed' and left in Mongo — not deleted, and
// no longer picked up by armNext() — so a permanently broken task doesn't
// spin forever, but also doesn't silently disappear.
async function failTask(task, err) {
  const giveUp = task.attempts >= MAX_ATTEMPTS;
  const message = String((err && err.message) || err || 'Unknown error').slice(0, 500);

  await ScheduledTask.updateOne(
    { _id: task._id },
    {
      $set: {
        status: giveUp ? 'failed' : 'pending',
        lockedUntil: null,
        lastError: message,
        ...(giveUp ? {} : { runAt: new Date(Date.now() + backoffFor(task.attempts)) }),
      },
    }
  ).catch(e => console.error('scheduler: failTask update failed:', e.message));

  if (giveUp) {
    console.error(`scheduler: task "${task.key}" (${task.type}) exhausted ${task.attempts} attempt(s) — marked failed. Last error: ${message}`);
  }
}

// Any task still 'running' at startup can only mean the previous process
// died mid-handler (this app runs as a single PM2 instance — nothing else
// could be executing it). Reset those back to 'pending' so they get
// retried, respecting the same attempts/backoff/give-up logic as a normal
// in-process failure. Called once from init(), before the first armNext().
async function _recoverStaleRunningTasks() {
  const stale = await ScheduledTask.find({ status: 'running' }).catch(err => {
    console.error('scheduler: stale-task lookup failed:', err.message);
    return [];
  });

  for (const task of stale) {
    const giveUp = task.attempts >= MAX_ATTEMPTS;
    await ScheduledTask.updateOne(
      { _id: task._id },
      {
        $set: {
          status: giveUp ? 'failed' : 'pending',
          lockedUntil: null,
          lastError: 'Process restarted while this task was running (previous attempt likely crashed mid-handler).',
          ...(giveUp ? {} : { runAt: new Date(Date.now() + backoffFor(task.attempts)) }),
        },
      }
    ).catch(err => console.error('scheduler: stale-task recovery failed for', task.key, err.message));
  }

  if (stale.length) {
    console.log(`⏰ scheduler: recovered ${stale.length} task(s) that were mid-run during the last restart`);
  }
}

// Call once from index.js's client.on('ready') handler. Recovers any task
// left 'running' by a previous crash, then loads the nearest pending task
// and arms the first timer. Handlers should already be registered by this
// point (registerHandler calls run at module require time, which happens
// well before 'ready').
async function init(readyClient) {
  client = readyClient;
  await _recoverStaleRunningTasks();
  await armNext();
}

module.exports = { registerHandler, scheduleTask, scheduleIfMissing, cancelTask, init };
