'use strict';

// ─── AI conversation memory ─────────────────────────────────────────────────
// Reading and writing per-DM-user/persona and shared per-group/persona memory in
// Mongo (models/AiConversation.js). Rules:
//
//   • Each persona has its own conversation per DM user or group. Groups use
//     a stable synthetic sender key; previous member-specific rows stay untouched.
//   • A conversation expires AI_HISTORY_EXPIRY_DAYS (7) after the last message.
//     Every exchange moves the expiry forward, so an active conversation never
//     expires on its original date. AI_HISTORY_EXPIRY_SCOPE decides whether
//     that counts activity with any persona ('user', the default) or only with
//     the same persona ('persona').
//   • The bot owner is exempt in DMs: no expiry, and a much larger history.
//
// Expiry itself is MongoDB's native TTL index on `expiresAt`: no timers and no
// scheduler here. Documents without `expiresAt` (the owner's) are never touched.

const AiConversation = require('../models/AiConversation');
const logger = require('./logger');
const { isOwner } = require('./helpers');
const {
  AI_HISTORY_EXPIRY_DAYS,
  AI_HISTORY_EXPIRY_SCOPE,
  AI_HISTORY_MESSAGES,
  AI_HISTORY_OWNER_KEPT,
  AI_HISTORY_OWNER_CONTEXT,
} = require('./config');

const DAY_MS = 24 * 60 * 60 * 1000;
let clock = () => Date.now();

function expiryDate() {
  return new Date(clock() + AI_HISTORY_EXPIRY_DAYS * DAY_MS);
}

// Keep the existing unique index, using a distinct namespace for shared groups.
// No old per-member history is read, merged, rewritten or explicitly deleted.
function conversationSender(chatId, senderId) {
  return String(chatId).endsWith('@g.us') ? `group:${chatId}` : senderId;
}

// Returns this (chat, sender, persona) conversation as { role, content }[] for
// gemini.js: empty for a new conversation, or one that has expired. Reading
// never extends the expiry; only a new exchange does.
async function getConversationHistory({ chatId, senderId, personaId }) {
  senderId = conversationSender(chatId, senderId);
  const owner = !String(chatId).endsWith('@g.us') && isOwner(senderId);
  let convo;
  try {
    convo = await AiConversation.findOne({ chatId, senderId, personaId });
  } catch (err) {
    logger.error('ai.history.load.failed', err, { personaId });
    return [];
  }

  // MongoDB's TTL sweep runs about once a minute, so a document can outlive its
  // expiry briefly. Treat it as gone, and remove it so the next exchange starts clean.
  if (convo && !owner && convo.expiresAt && new Date(convo.expiresAt).getTime() <= clock()) {
    try { await AiConversation.deleteOne({ _id: convo._id }); } catch (err) { logger.error('ai.history.expired_cleanup.failed', err, { personaId }); }
    logger.write('INFO', 'ai.history.expired', { personaId });
    convo = null;
  }

  let messages = convo ? convo.messages.map(m => ({ role: m.role, content: m.content })) : [];
  if (owner && messages.length > AI_HISTORY_OWNER_CONTEXT) messages = messages.slice(-AI_HISTORY_OWNER_CONTEXT);
  // Gemini requires a conversation to start with the user. History is stored in
  // user/assistant pairs, but an odd configured limit could cut one in half.
  while (messages.length && messages[0].role !== 'user') messages.shift();
  logger.write('INFO', 'ai.history.loaded', { personaId, messages: messages.length, owner, continuing: Boolean(convo) });
  return messages;
}

// Appends BOTH sides of one exchange in a single atomic $push, trims to the
// history limit, and moves the expiry to "now + 7 days" (or removes it for the
// owner). Never throws: a failed save must not break the reply.
async function appendConversationTurn({ chatId, senderId, personaId, userContent, assistantContent }) {
  senderId = conversationSender(chatId, senderId);
  const owner = !String(chatId).endsWith('@g.us') && isOwner(senderId);
  const update = {
    $push: {
      messages: {
        $each: [
          { role: 'user', content: userContent },
          { role: 'assistant', content: assistantContent },
        ],
        $slice: -(owner ? AI_HISTORY_OWNER_KEPT : AI_HISTORY_MESSAGES),
      },
    },
  };
  const expiresAt = owner ? null : expiryDate();
  if (owner) update.$unset = { expiresAt: '' };
  else update.$set = { expiresAt };

  let saved = null;
  try {
    saved = await AiConversation.findOneAndUpdate({ chatId, senderId, personaId }, update, { upsert: true, new: true });
  } catch (err) {
    logger.error('ai.history.save.failed', err, { personaId });
    return false;
  }

  // 'user' scope: this user is active, so ALL of their conversations (every
  // persona, every chat) get the same fresh expiry, not just this one.
  let refreshed = 0;
  if (!owner && AI_HISTORY_EXPIRY_SCOPE === 'user') {
    try {
      const result = await AiConversation.updateMany({ senderId, ...(String(chatId).endsWith('@g.us') ? {} : { chatId: { $not: /@g\.us$/ } }) }, { $set: { expiresAt } });
      refreshed = Number(result?.modifiedCount ?? result?.nModified ?? 0);
    } catch (err) {
      logger.error('ai.history.refresh.failed', err, { personaId });
    }
  }

  logger.write('INFO', 'ai.history.saved', {
    personaId,
    kept: saved?.messages?.length ?? null,
    owner,
    expiresAt: owner ? null : expiresAt,
    days: AI_HISTORY_EXPIRY_DAYS,
    scope: AI_HISTORY_EXPIRY_SCOPE,
    refreshed,
  });
  return true;
}

// One-time, safe to run on every start. Conversations saved before personas
// were part of the key have no personaId (and mix every character's replies).
// They are kept as the conversation of `personaId`, the persona active at the
// time of the update, and given the new expiry rules (or none, for the owner).
async function migrateLegacyConversations(personaId) {
  if (!personaId) return { moved: 0 };
  const legacy = await AiConversation.find({ personaId: { $exists: false } }).lean();
  let moved = 0;
  for (const doc of legacy) {
    if (String(doc.chatId).endsWith('@g.us')) continue;
    const update = { $set: { personaId } };
    if (isOwner(doc.senderId)) update.$unset = { expiresAt: '' };
    else update.$set.expiresAt = expiryDate();
    try {
      await AiConversation.updateOne({ _id: doc._id }, update);
      moved += 1;
    } catch (err) {
      // Most likely a conversation for this persona already exists: keep the newer one.
      logger.error('ai.history.migrate.skipped', err, { personaId });
    }
  }
  if (moved) logger.write('INFO', 'ai.history.migrated', { moved, personaId });
  return { moved };
}

function _setClock(fn) { clock = typeof fn === 'function' ? fn : () => Date.now(); }

module.exports = { getConversationHistory, appendConversationTurn, migrateLegacyConversations, _setClock };
