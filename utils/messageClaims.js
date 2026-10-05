/**
 * Exactly-one-handler record for incoming messages (shared by the whatsapp-web.js
 * and Baileys versions of the bot; see the settings comment in utils/config.js).
 *
 * claimMessage(id) resolves true when THIS process may handle the message (it is
 * the first to claim that id) and false when another bot version already did.
 *
 * It fails OPEN: if the record is disabled, MongoDB is slow or down, or anything
 * unexpected happens, the message is handled normally. A missed message is worse
 * than a rare duplicate.
 */
const HandledMessage = require('../models/HandledMessage');
const logger = require('./logger');
const { MESSAGE_CLAIM_ENABLED, MESSAGE_CLAIM_TIMEOUT_MS, MESSAGE_CLAIM_COOLDOWN_MS, BOT_ENGINE } = require('./config');

let indexReady = null;
// After a failure or timeout, messages are let through WITHOUT asking the database for
// a while, so a slow or unreachable MongoDB cannot delay every message in turn.
let skipClaimsUntil = 0;

function ensureIndexes() {
  if (!indexReady) {
    // Creates the self-deleting (TTL) index once; a failure only means old claims
    // are not cleaned up automatically, claiming itself still works.
    indexReady = HandledMessage.createIndexes().catch(err => {
      logger.error('message.claim.index_failed', err);
    });
  }
  return indexReady;
}

function isDuplicateKey(err) {
  return err?.code === 11000 || /E11000/.test(String(err?.message || ''));
}

async function claimMessage(messageId) {
  if (!MESSAGE_CLAIM_ENABLED || !messageId) return true;
  if (Date.now() < skipClaimsUntil) return true;
  const id = String(messageId);
  try {
    const attempt = (async () => {
      ensureIndexes(); // not awaited: the unique _id is what makes claiming safe, the TTL index is only housekeeping
      await HandledMessage.collection.insertOne({ _id: id, engine: BOT_ENGINE, at: new Date() });
      return true;
    })();
    // A late answer is ignored; the timer must not keep the process alive.
    let timer;
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => resolve('timeout'), MESSAGE_CLAIM_TIMEOUT_MS);
      if (timer.unref) timer.unref();
    });
    const result = await Promise.race([attempt.catch(err => err), timeout]);
    clearTimeout(timer);
    if (result === true) return true;
    if (result === 'timeout') {
      skipClaimsUntil = Date.now() + MESSAGE_CLAIM_COOLDOWN_MS;
      logger.write('WARN', 'message.claim.timeout', { messageId: id });
      return true;
    }
    if (isDuplicateKey(result)) {
      logger.write('INFO', 'message.claim.already_handled', { messageId: id });
      return false;
    }
    skipClaimsUntil = Date.now() + MESSAGE_CLAIM_COOLDOWN_MS;
    logger.error('message.claim.failed_open', result, { messageId: id });
    return true;
  } catch (err) {
    skipClaimsUntil = Date.now() + MESSAGE_CLAIM_COOLDOWN_MS;
    logger.error('message.claim.failed_open', err, { messageId: id });
    return true;
  }
}

/**
 * whatsapp-web.js only: put the claim in front of every 'message' listener. The
 * event is held until its claim is decided, and held messages are passed on strictly
 * in arrival order. A message another bot version already handled never reaches
 * any listener.
 */
function gateClientMessages(client) {
  const emitEvent = client.emit.bind(client);
  let claimChain = Promise.resolve();
  client.emit = (event, ...args) => {
    if (event !== 'message') return emitEvent(event, ...args);
    const messageId = args[0]?.id?.id;
    claimChain = claimChain
      .then(async () => {
        if (await claimMessage(messageId)) emitEvent(event, ...args);
      })
      .catch(err => console.error('Message claim gate failed:', err.message));
    return true;
  };
  return client;
}

function _resetCooldown() { skipClaimsUntil = 0; }

module.exports = { claimMessage, gateClientMessages, _resetCooldown };
