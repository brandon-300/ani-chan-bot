const crypto = require('node:crypto');
const ScheduledTask = require('../models/ScheduledTask');
const logger = require('./logger');

const handlers = new Map();
const active = new Set();
const runningKeys = new Set();
let client, timer, armedKey;
let stopped = true;
let arming = null;
let armAgain = false;
const LEASE_MS = 5 * 60000;
const POLL_MS = 30000;
const MAX_ATTEMPTS = 6;
const DELAYS = [30000, 120000, 600000, 1800000];
const backoff = attempts => DELAYS[Math.min(Math.max(attempts - 1, 0), DELAYS.length - 1)];

function registerHandler(type, handler) { handlers.set(type, handler); }
function wake(delay = POLL_MS, key = null) {
  if (stopped) return;
  clearTimeout(timer);
  armedKey = key;
  timer = setTimeout(() => { (key ? runDueTask(key) : armNext()).catch(err => {
    logger.error('scheduler.tick.failed', err); wake();
  }); }, Math.max(0, delay));
  timer.unref?.();
}

async function recoverRunning(restart = false) {
  const filter = { status: 'running', runToken: { $nin: [...active] } };
  if (!restart) filter.$or = [{ lockedUntil: { $lte: new Date() } }, { lockedUntil: null }];
  const tasks = await ScheduledTask.find(filter);
  for (const task of tasks) {
    await ScheduledTask.updateOne({ _id: task._id, status: 'running', runToken: task.runToken ?? null }, {
      $set: { status: task.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
        lockedUntil: null, runToken: null, lastError: 'Recovered interrupted scheduler attempt',
        runAt: new Date(Date.now() + backoff(task.attempts)) },
    });
  }
}

async function armNext() {
  if (stopped) return;
  if (arming) { armAgain = true; return arming; }
  arming = (async () => {
    do {
      armAgain = false;
      try {
        await recoverRunning();
        const next = await ScheduledTask.findOne({ status: 'pending', key: { $nin: [...runningKeys] } }).sort({ runAt: 1 });
        const remaining = next ? new Date(next.runAt).getTime() - Date.now() : POLL_MS;
        if (next && remaining <= POLL_MS) wake(remaining, next.key);
        else wake();
      } catch (err) {
        // A failed lookup is not an empty queue. Always schedule recovery.
        logger.error('scheduler.arm.lookup_failed', err);
        wake();
      }
    } while (armAgain && !stopped);
  })();
  try { await arming; } finally { arming = null; }
}

async function scheduleTask({ type, key, runAt, payload = {} }) {
  if (!type || !key || !Number.isFinite(new Date(runAt).getTime())) throw new Error('Invalid scheduler task');
  await ScheduledTask.findOneAndUpdate({ key }, { $set: {
    type, key, runAt, payload, status: 'pending', attempts: 0,
    lockedUntil: null, runToken: null, lastError: null,
  } }, { upsert: true, setDefaultsOnInsert: true });
  await armNext();
}
async function scheduleIfMissing({ type, key, runAt, payload = {} }) {
  if (!type || !key || !Number.isFinite(new Date(runAt).getTime())) throw new Error('Invalid scheduler task');
  try {
    await ScheduledTask.findOneAndUpdate({ key }, { $setOnInsert: {
      type, key, runAt, payload, status: 'pending', attempts: 0,
    } }, { upsert: true });
  } catch (err) { if (err.code !== 11000) throw err; }
  await armNext();
}
async function cancelTask(key) {
  await ScheduledTask.deleteOne({ key });
  if (armedKey === key) await armNext();
}

async function runDueTask(key) {
  if (runningKeys.has(key)) { await armNext(); return; }
  runningKeys.add(key);
  const token = crypto.randomUUID();
  let heartbeat;
  try {
    const task = await ScheduledTask.findOneAndUpdate({ key, status: 'pending', runAt: { $lte: new Date() } }, {
      $set: { status: 'running', runToken: token, lockedUntil: new Date(Date.now() + LEASE_MS) },
      $inc: { attempts: 1 },
    }, { new: true });
    if (!task) return;
    active.add(token);
    const owned = { _id: task._id, status: 'running', runToken: token };
    heartbeat = setInterval(() => {
      ScheduledTask.updateOne(owned, { $set: { lockedUntil: new Date(Date.now() + LEASE_MS) } })
        .catch(err => logger.error('scheduler.lease.refresh_failed', err, { key }));
    }, POLL_MS);
    heartbeat.unref?.();
    try {
      const handler = handlers.get(task.type);
      if (!handler) throw new Error(`No scheduler handler for ${task.type}`);
      await handler(task.payload, client);
      // The token also fences self-rescheduled tasks and newer attempts.
      await ScheduledTask.deleteOne(owned);
      logger.write('INFO', 'scheduler.task.completed', { key, type: task.type });
    } catch (err) {
      logger.error('scheduler.task.failed', err, { key });
      await ScheduledTask.updateOne(owned, { $set: {
        status: task.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
        runAt: new Date(Date.now() + backoff(task.attempts)), lockedUntil: null,
        runToken: null, lastError: String(err.message || err).slice(0, 500),
      } });
    }
  } catch (err) {
    // If cleanup/failure recording failed, the expired lease is recovered by
    // the next polling tick. Never strand the scheduler without a timer.
    logger.error('scheduler.attempt.record_failed', err, { key });
  } finally {
    clearInterval(heartbeat);
    active.delete(token);
    runningKeys.delete(key);
    await armNext();
  }
}
async function init(readyClient) {
  client = readyClient; stopped = false;
  try { await recoverRunning(true); }
  catch (err) { logger.error('scheduler.startup.recovery_failed', err); }
  await armNext();
}
async function reviveFailed() {
  // Essential handlers are idempotent. Retry exhausted batches after a long
  // cooldown, while retaining failures in Mongo for inspection between batches.
  const result = await ScheduledTask.updateMany({ status: 'failed',
    type: { $in: ['card_drop', 'card_lend_return', 'group_unmute', 'auction_end', 'multiplayer_deadline', 'game_result', 'asset_cleanup'] },
    runAt: { $lte: new Date(Date.now() - 30 * 60000) },
  }, { $set: { status: 'pending', attempts: 0, runAt: new Date(), lockedUntil: null, runToken: null } });
  if (result.modifiedCount) { logger.write('INFO', 'scheduler.failed_batch.rearmed', { count: result.modifiedCount }); await armNext(); }
}
function _stop() { stopped = true; clearTimeout(timer); timer = null; }
module.exports = { registerHandler, scheduleTask, scheduleIfMissing, cancelTask, init, reviveFailed,
  _runDueTask: runDueTask, _armNext: armNext, _recoverRunning: recoverRunning, _stop };
