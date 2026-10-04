/**
 * AI Reactions Handler
 * Handles AI bot reactions to user reactions on its messages
 *
 * For Baileys v7:
 * - Uses messages.reaction event instead of messages.update
 * - Works with LID and PN identities
 * - Library-independent reaction handling
 */

import config from './config.js';
import defaultLedger from './aiMessageLedger.js';
import logger from './logger.js';

const normalize = emoji => String(emoji || '').replace(/\uFE0F/g, '').trim();

const FAMILIES = [
  { name: 'love', match: ['\u2764', '\ud83e\udde1', '\ud83d\udc9b', '\ud83d\udc9a', '\ud83d\udc99', '\ud83d\udc9c', '\ud83d\udda4', '\ud83e\udd0d', '\ud83e\udd0e', '\ud83d\udc95', '\ud83d\udc96', '\ud83d\udc97', '\ud83d\udc93', '\ud83d\udc9e', '\ud83d\ude0d', '\ud83e\udd70', '\ud83d\ude18', '\ud83e\udef6'], replies: ['\u2764\ufe0f', '\ud83e\udd70', '\ud83d\ude0a', '\ud83d\udc95'] },
  { name: 'laugh', match: ['\ud83d\ude02', '\ud83e\udd23', '\ud83d\ude06', '\ud83d\ude39', '\ud83d\ude04', '\ud83d\ude01', '\ud83d\udc80'], replies: ['\ud83d\ude02', '\ud83e\udd23', '\ud83d\ude06'] },
  { name: 'sad', match: ['\ud83d\ude22', '\ud83d\ude2d', '\ud83e\udd7a', '\ud83d\ude3f', '\ud83d\ude1e', '\ud83d\udc94'], replies: ['\ud83e\udd7a', '\ud83e\udd17'] },
  { name: 'approve', match: ['\ud83d\udc4d', '\ud83d\udc4c', '\ud83d\ude4f', '\u2705', '\ud83d\udcaf', '\ud83d\udc4f', '\ud83d\udd25', '\u2728', '\ud83c\udf89', '\ud83e\udd73'], replies: ['\ud83d\udc4d', '\ud83d\ude0a', '\ud83d\udd25'] },
  { name: 'surprise', match: ['\ud83d\ude2e', '\ud83d\ude32', '\ud83d\ude33', '\ud83e\udd2f', '\ud83d\ude31'], replies: ['\ud83d\ude33', '\ud83d\ude2e', '\ud83d\ude05'] },
  { name: 'anger', match: ['\ud83d\ude21', '\ud83e\udd2c', '\ud83d\ude20', '\ud83d\udc4e'], replies: ['\ud83d\ude05', '\ud83d\ude48'] },
  { name: 'cool', match: ['\ud83d\ude0e', '\ud83e\udd29', '\u2b50', '\ud83c\udf1f'], replies: ['\ud83d\ude0e', '\u2728', '\ud83e\udd29'] },
  { name: 'playful', match: ['\ud83d\ude0f', '\ud83d\ude1c', '\ud83d\ude1d', '\ud83d\ude0b', '\ud83e\udd2d', '\ud83d\ude09'], replies: ['\ud83d\ude0f', '\ud83d\ude1c', '\ud83e\udd2d'] },
];

function familyOf(emoji) {
  const key = normalize(emoji);
  return FAMILIES.find(family => family.match.some(candidate => normalize(candidate) === key)) || null;
}

function pickReactionEmoji(userEmoji, rng = Math.random) {
  const family = familyOf(userEmoji);
  if (!family) return String(userEmoji || '').trim();
  return family.replies[Math.floor(rng() * family.replies.length)] || family.replies[0];
}

function defaultSchedule(fn, ms) {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      Promise.resolve().then(fn).then(resolve, resolve);
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

function chatIdOf(msgId) {
  if (!msgId) return '';
  if (msgId.remoteJid) return msgId.remoteJid;
  if (msgId._serialized) return msgId._serialized;
  return '';
}

/**
 * Normalize a Baileys messages.reaction item.
 * Real shape: { key: TARGET, reaction: { key: REACTOR, text, timestamp } }
 */
function normalizeReaction(reaction) {
  if (!reaction) return null;

  const targetKey = reaction.targetKey || reaction.key || {};
  const reactionData = reaction.reaction || {};
  const reactorKey = reaction.reactorKey || reactionData.key || {};

  const emoji = reaction.emoji || reactionData.text || reactionData.emoji || '';

  const reactorFromNested = reactorKey.participant || reactorKey.remoteJid || '';
  const from = reactorFromNested || reaction.from || '';

  const fromMe = Object.prototype.hasOwnProperty.call(reactorKey, 'fromMe')
    ? Boolean(reactorKey.fromMe)
    : (Object.prototype.hasOwnProperty.call(reaction, 'fromMe') && !reactorFromNested
      ? Boolean(reaction.fromMe)
      : false);

  return {
    type: 'reaction',
    targetKey,
    reactorKey,
    emoji: String(emoji || ''),
    timestamp: reactionData.timestamp || reaction.timestamp,
    from,
    remoteJid: targetKey.remoteJid || reaction.remoteJid || '',
    messageId: targetKey.id || reaction.messageId || '',
    fromMe,
  };
}

function createReactionHandler({
  client,
  ledger = defaultLedger,
  settings = {},
  now = Date.now,
  rng = Math.random,
  schedule = defaultSchedule,
} = {}) {
  const cfg = {
    enabled: settings.enabled ?? config.AI_REACT_TO_REACTIONS ?? true,
    chance: settings.chance ?? config.AI_REACT_CHANCE ?? 0.6,
    cooldownMs: settings.cooldownMs ?? config.AI_REACT_COOLDOWN_MS ?? 15000,
    delayMinMs: settings.delayMinMs ?? config.AI_REACT_DELAY_MIN_MS ?? 1500,
    delayMaxMs: settings.delayMaxMs ?? config.AI_REACT_DELAY_MAX_MS ?? 6000,
  };

  const lastReactionByChat = new Map();

  function skipOnAiMessage(reason, emoji, entry) {
    return { action: 'skip', reason, emoji, kind: entry?.kind };
  }

  function handle(reaction) {
    if (!cfg.enabled) return { action: 'skip', reason: 'disabled' };

    const normalized = normalizeReaction(reaction);
    if (!normalized) return { action: 'skip', reason: 'invalid_reaction' };

    const emoji = String(normalized.emoji || '').trim();
    if (!emoji) return { action: 'skip', reason: 'reaction_removed' };

    const botId = client?.info?.wid?._serialized || '';
    const ownReaction = normalized.fromMe === true || (botId && normalized.from === botId);
    if (ownReaction) return { action: 'skip', reason: 'own_reaction' };

    const targetId = normalized.messageId;
    if (!targetId) return { action: 'skip', reason: 'no_message_id' };

    const messageKey = { id: targetId, remoteJid: normalized.remoteJid };
    const entry = ledger.get(messageKey);
    if (!entry) return { action: 'skip', reason: 'not_ai_message' };
    if (entry.reactedAt) return skipOnAiMessage('already_reacted', emoji, entry);

    const chatId = chatIdOf(messageKey) || normalized.remoteJid;
    const current = now();
    const last = lastReactionByChat.get(chatId) || 0;
    if (cfg.cooldownMs > 0 && current - last < cfg.cooldownMs) return skipOnAiMessage('cooldown', emoji, entry);

    if (!(rng() < cfg.chance)) return skipOnAiMessage('chance', emoji, entry);

    const replyEmoji = pickReactionEmoji(emoji, rng);
    if (!replyEmoji) return { action: 'skip', reason: 'no_emoji' };

    ledger.markReacted(messageKey);
    lastReactionByChat.set(chatId, current);
    while (lastReactionByChat.size > 500) lastReactionByChat.delete(lastReactionByChat.keys().next().value);

    const span = Math.max(0, cfg.delayMaxMs - cfg.delayMinMs);
    const delayMs = Math.round(cfg.delayMinMs + rng() * span);
    logger.write('INFO', 'ai.reaction.react', { kind: entry.kind, theirs: emoji, mine: replyEmoji, delayMs, chatId });

    const done = schedule(async () => {
      try {
        await client.react(messageKey, replyEmoji);
      } catch (err) {
        logger.error('ai.reaction.send_failed', err, { chatId });
      }
    }, delayMs);

    return { action: 'react', emoji: replyEmoji, theirs: emoji, delayMs, kind: entry.kind, done };
  }

  return { handle };
}

function createBaileysReactionAdapter(client, ledger) {
  const handler = createReactionHandler({ client, ledger });
  return {
    handleBaileysReaction: (baileysReactions) => {
      if (!Array.isArray(baileysReactions)) return;
      for (const reaction of baileysReactions) {
        try {
          handler.handle(reaction);
        } catch (err) {
          logger.error('ai.reaction.baileys_adapter_error', err);
        }
      }
    },
    handle: handler.handle,
  };
}

export { normalizeReaction, createReactionHandler, createBaileysReactionAdapter, pickReactionEmoji };

export default {
  createReactionHandler,
  createBaileysReactionAdapter,
  normalizeReaction,
  pickReactionEmoji,
  FAMILIES,
};
