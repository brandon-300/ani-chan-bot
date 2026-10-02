const mongoose = require('mongoose');

// Persists .copilot/.voice's per-chat, per-user conversation memory in
// Mongo instead of the old in-memory chatHistory Map in commands/ai.js.
// Fixes: it no longer resets on every PM2 restart, and it removes a real
// bug the old Map had — every addToHistory() call created its OWN
// `setTimeout(() => chatHistory.delete(chatId), 30 * 60 * 1000)`, so an
// earlier call's timer could fire and wipe out a chat's newer history
// while the conversation was still actively going.
//
// Here there's exactly one document per (chat, sender) pair (upserted),
// and expiresAt is a genuine MongoDB TTL index: Mongo's own background
// process deletes the document once `expiresAt` is in the past, so
// there's no setTimeout/scheduler task involved at all for the 30-minute
// idle cleanup — the database does it natively. (That background sweep
// runs roughly once a minute, not instantly on the second — fine for a
// 30-minute idle window.)
const AiConversationSchema = new mongoose.Schema({
  chatId: { type: String, required: true },
  // Who this specific conversation belongs to. In a DM, chatId alone was
  // already unique per person — but in a GROUP, chatId is the same for
  // every member, so keying on chatId alone (the old design) meant the
  // whole group shared one conversation: everyone's messages and the AI's
  // replies to them all got mixed into one shared history. senderId
  // (msg.author in a group, msg.from in a DM — see commands/ai.js) splits
  // that back out so each person gets their own thread even inside the
  // same group.
  senderId: { type: String, required: true },
  // Capped to the most recent 20 turns via $slice in addTurnToHistory() —
  // see commands/ai.js — rather than enforced here.
  messages: [{
    role: { type: String, required: true }, // 'user' | 'assistant'
    content: { type: String, required: true },
  }],
  // TTL field. `expires: 0` (a SchemaType option, not a query operator)
  // tells Mongoose to create the index as expireAfterSeconds: 0 — meaning
  // "expire exactly at the date stored here", not N seconds after some
  // other fixed timestamp. addTurnToHistory() pushes this out another 30
  // minutes on every new exchange, so it always reflects "30 minutes
  // since the last activity in this conversation".
  expiresAt: { type: Date, required: true, expires: 0 },
}, { timestamps: true });

// Compound unique index (replaces the old single-field unique index on
// chatId) — findOneAndUpdate's upsert relies on this being unique per
// (chatId, senderId) pair, not per chatId alone. index.js calls
// AiConversation.syncIndexes() once at startup, which drops the stale
// chatId-only unique index left over from before this change and creates
// this one — self-healing, no manual DB step needed. Any pre-existing
// document from before this change (old shape: chatId only, no senderId)
// is simply invisible to every query here going forward and ages out on
// its own via the TTL field above — nothing reads or writes it again.
AiConversationSchema.index({ chatId: 1, senderId: 1 }, { unique: true });

module.exports = mongoose.model('AiConversation', AiConversationSchema);
