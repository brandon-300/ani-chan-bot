import config from './config.js';
import defaultLedger from './aiMessageLedger.js';
import logger from './logger.js';
'use strict';

// ─── AI reacts to reactions on its own messages ─────────────────────────────
// Fed by whatsapp-web.js `message_reaction` events. When someone reacts to a
// message/voice note/image/sticker the AI itself sent, the AI may put its own
// emoji reaction on that SAME message after a short, human-looking delay.
//
// Hard rules (all covered by tests):
//   • It never sends a message. The only outgoing call is client.sendReaction().
//   • It ignores reactions the bot itself made (including its own ⏳/✅ status
//     reactions) and reaction removals, so it cannot loop.
//   • It only reacts to messages recorded in utils/aiMessageLedger.js, i.e.
//     messages the AI produced — not menus, card drops or other bot output.
//   • At most one reaction per message, and a per-chat cooldown.
//   • No Gemini call, so it is unaffected by quota or the Gemini command pause.

// Emoji compare without the variation selector so "❤" and "❤️" are the same.
const normalize = emoji => String(emoji || '').replace(/\uFE0F/g, '').trim();

// What to answer with, by the family of the emoji the person used. The
// fallback mirrors their emoji. Replies are all widely supported emojis.
const FAMILIES = [
  { name: 'love', match: ['❤', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💕', '💖', '💗', '💓', '💞', '😍', '🥰', '😘', '🫶'], replies: ['❤️', '🥰', '😊', '💕'] },
  { name: 'laugh', match: ['😂', '🤣', '😆', '😹', '😄', '😁', '💀'], replies: ['😂', '🤣', '😆'] },
  { name: 'sad', match: ['😢', '😭', '🥺', '😿', '😞', '💔'], replies: ['🥺', '🤗'] },
  { name: 'approve', match: ['👍', '👌', '🙏', '✅', '💯', '👏', '🔥', '✨', '🎉', '🥳'], replies: ['👍', '😊', '🔥'] },
  { name: 'surprise', match: ['😮', '😲', '😳', '🤯', '😱'], replies: ['😳', '😮', '😅'] },
  { name: 'angry', match: ['😡', '🤬', '😠', '👎'], replies: ['😅', '🙈'] },
  { name: 'cool', match: ['😎', '🤩', '⭐', '🌟'], replies: ['😎', '✨', '🤩'] },
  { name: 'playful', match: ['😏', '😜', '😝', '😋', '🤭', '😉'], replies: ['😏', '😜', '🤭'] },
];

function familyOf(emoji) {
  const key = normalize(emoji);
  return FAMILIES.find(family => family.match.some(candidate => normalize(candidate) === key)) || null;
}

// Returns the emoji the AI should react with for a given incoming reaction.
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
  const remote = msgId?.remote;
  if (typeof remote === 'string') return remote;
  return remote?._serialized || '';
}

function createReactionHandler({
  client,
  ledger = defaultLedger,
  settings = {},
  rng = Math.random,
  now = Date.now,
  schedule = defaultSchedule,
} = {}) {
  const cfg = {
    enabled: config.AI_REACT_TO_REACTIONS,
    chance: config.AI_REACT_CHANCE,
    cooldownMs: config.AI_REACT_COOLDOWN_MS,
    delayMinMs: config.AI_REACT_DELAY_MIN_MS,
    delayMaxMs: config.AI_REACT_DELAY_MAX_MS,
    ...settings,
  };
  const lastReactionByChat = new Map();

  // Skips on a message the AI really sent are worth a log line; skips on any
  // other message (the vast majority) are not, or every reaction in every chat
  // would be logged.
  function skipOnAiMessage(reason, theirs, entry) {
    logger.write('INFO', 'ai.reaction.skip', { reason, theirs, kind: entry.kind });
    return { action: 'skip', reason };
  }

  // Returns a decision object synchronously; `done` (only when reacting) resolves
  // after the delayed reaction was attempted and never rejects.
  function handle(reaction) {
    if (!cfg.enabled) return { action: 'skip', reason: 'disabled' };

    const emoji = String(reaction?.reaction || '').trim();
    if (!emoji) return { action: 'skip', reason: 'reaction_removed' };

    const botId = client?.info?.wid?._serialized || '';
    const ownReaction = reaction?.id?.fromMe === true || (botId && reaction?.senderId === botId);
    if (ownReaction) return { action: 'skip', reason: 'own_reaction' };

    const targetId = reaction?.msgId?._serialized;
    if (!targetId) return { action: 'skip', reason: 'no_message_id' };

    const entry = ledger.get(targetId);
    if (!entry) return { action: 'skip', reason: 'not_ai_message' };
    if (entry.reactedAt) return skipOnAiMessage('already_reacted', emoji, entry);

    const chatId = chatIdOf(reaction.msgId) || targetId;
    const current = now();
    const last = lastReactionByChat.get(chatId) || 0;
    if (cfg.cooldownMs > 0 && current - last < cfg.cooldownMs) return skipOnAiMessage('cooldown', emoji, entry);

    if (!(rng() < cfg.chance)) return skipOnAiMessage('chance', emoji, entry);

    const replyEmoji = pickReactionEmoji(emoji, rng);
    if (!replyEmoji) return { action: 'skip', reason: 'no_emoji' };

    // Claim the message and the chat slot immediately so a burst of reactions
    // (or one person toggling theirs) can never produce a second reaction.
    ledger.markReacted(targetId);
    lastReactionByChat.set(chatId, current);
    while (lastReactionByChat.size > 500) lastReactionByChat.delete(lastReactionByChat.keys().next().value);

    const span = Math.max(0, cfg.delayMaxMs - cfg.delayMinMs);
    const delayMs = Math.round(cfg.delayMinMs + rng() * span);
    logger.write('INFO', 'ai.reaction.react', { kind: entry.kind, theirs: emoji, mine: replyEmoji, delayMs, chatId });

    const done = schedule(async () => {
      try {
        // The ONLY outgoing call: an emoji reaction on the same message.
        await client.sendReaction(targetId, replyEmoji);
      } catch (err) {
        logger.error('ai.reaction.send_failed', err, { chatId });
      }
    }, delayMs);

    return { action: 'react', emoji: replyEmoji, theirs: emoji, delayMs, kind: entry.kind, done };
  }

  return { handle };
}

module.exports = { createReactionHandler, pickReactionEmoji, FAMILIES };
