'use strict';

// ─── Ledger of messages the AI itself sent ──────────────────────────────────
// WhatsApp's reaction event only says "someone reacted to message X". To react
// back only to the AI's own replies, voice notes, images and stickers (and not
// to every message the bot account ever sent, such as menus or card drops), the
// AI output paths record each sent message's ID here.
//
// In-memory only, bounded by size and age: after a restart, reactions to older
// messages are simply ignored. Nothing here touches the network or MongoDB.

const { AI_MESSAGE_MEMORY_MS, AI_MESSAGE_MEMORY_MAX } = require('./config');

const entries = new Map(); // serialized message id -> { kind, at, reactedAt }
let clock = () => Date.now();

function serializedId(sent) {
  if (typeof sent === 'string') return sent;
  return sent?.id?._serialized || null;
}

function prune(now) {
  for (const [id, entry] of entries) {
    if (now - entry.at > AI_MESSAGE_MEMORY_MS) entries.delete(id);
    else break; // Map keeps insertion order, oldest first
  }
  while (entries.size > AI_MESSAGE_MEMORY_MAX) entries.delete(entries.keys().next().value);
}

// `sent` is the Message returned by msg.reply()/client.sendMessage(), or an ID string.
function remember(sent, kind = 'text') {
  const id = serializedId(sent);
  if (!id) return false;
  const now = clock();
  entries.delete(id);
  entries.set(id, { kind, at: now, reactedAt: 0 });
  prune(now);
  return true;
}

function get(id) {
  const key = serializedId(id);
  const entry = key ? entries.get(key) : null;
  if (!entry) return null;
  if (clock() - entry.at > AI_MESSAGE_MEMORY_MS) {
    entries.delete(key);
    return null;
  }
  return entry;
}

function markReacted(id) {
  const entry = get(id);
  if (entry) entry.reactedAt = clock();
  return Boolean(entry);
}

// Test hooks.
function _reset() { entries.clear(); clock = () => Date.now(); }
function _setClock(fn) { clock = typeof fn === 'function' ? fn : () => Date.now(); }
function _size() { return entries.size; }

module.exports = { remember, get, markReacted, _reset, _setClock, _size };
