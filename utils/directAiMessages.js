'use strict';

// ─── Messages sent by .gpt ─────────────────────────────────────────────────
// .gpt is a one-shot, no-memory question to Gemini. Unlike .copilot it can't
// continue a conversation, so replying to one of its messages must NOT be
// answered by the AI (index.js turns such a reply into an error telling the
// person to use .copilot instead).
//
// To recognise those messages, commands/ai.js records the id of everything
// .gpt sends here. This is deliberately separate from utils/aiMessageLedger.js:
// that ledger lists the messages the bot should REACT to, and .gpt messages
// must never be in it.
//
// In-memory only and bounded by the same two limits as the ledger
// (AI_MESSAGE_MEMORY_MS / AI_MESSAGE_MEMORY_MAX in utils/config.js): after a
// restart, or once a message is older than that, a reply to it is routed
// like any other reply to the bot.

const { AI_MESSAGE_MEMORY_MS, AI_MESSAGE_MEMORY_MAX } = require('./config');

const entries = new Map(); // serialized message id -> time it was sent
let clock = () => Date.now();

function serializedId(sent) {
  if (typeof sent === 'string') return sent;
  return sent?.id?._serialized || null;
}

function prune(now) {
  for (const [id, at] of entries) {
    if (now - at > AI_MESSAGE_MEMORY_MS) entries.delete(id);
    else break; // Map keeps insertion order, oldest first
  }
  while (entries.size > AI_MESSAGE_MEMORY_MAX) entries.delete(entries.keys().next().value);
}

// `sent` is the Message returned by msg.reply(), or an id string.
function remember(sent) {
  const id = serializedId(sent);
  if (!id) return false;
  const now = clock();
  entries.delete(id);
  entries.set(id, now);
  prune(now);
  return true;
}

function has(sentOrId) {
  const id = serializedId(sentOrId);
  if (!id) return false;
  const at = entries.get(id);
  if (at === undefined) return false;
  if (clock() - at > AI_MESSAGE_MEMORY_MS) {
    entries.delete(id);
    return false;
  }
  return true;
}

// Test hooks.
function _reset() { entries.clear(); clock = () => Date.now(); }
function _setClock(fn) { clock = typeof fn === 'function' ? fn : () => Date.now(); }

module.exports = { remember, has, _reset, _setClock };
