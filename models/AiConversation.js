const mongoose = require('mongoose');

// Persists .copilot/.voice's per-chat conversation memory in Mongo instead
// of the old in-memory chatHistory Map in commands/ai.js. Two problems that
// fixes: it no longer resets on every PM2 restart, and it removes a real
// bug the old Map had — every addToHistory() call created its OWN
// `setTimeout(() => chatHistory.delete(chatId), 30 * 60 * 1000)`, so an
// earlier call's timer could fire and wipe out a chat's newer history
// while the conversation was still actively going.
//
// Here there's exactly one document per chat (upserted), and expiresAt is
// a genuine MongoDB TTL index: Mongo's own background process deletes the
// document once `expiresAt` is in the past, so there's no
// setTimeout/scheduler task involved at all for the 30-minute idle
// cleanup — the database does it natively. (That background sweep runs
// roughly once a minute, not instantly on the second — fine for a
// 30-minute idle window.)
const AiConversationSchema = new mongoose.Schema({
  // One document per chat — findOneAndUpdate's upsert relies on this being
  // unique.
  chatId: { type: String, required: true, unique: true },
  // Capped to the most recent 20 turns via $slice in addToHistory() — see
  // commands/ai.js — rather than enforced here.
  messages: [{
    role: { type: String, required: true }, // 'user' | 'assistant'
    content: { type: String, required: true },
  }],
  // TTL field. `expires: 0` (a SchemaType option, not a query operator)
  // tells Mongoose to create the index as expireAfterSeconds: 0 — meaning
  // "expire exactly at the date stored here", not N seconds after some
  // other fixed timestamp. addToHistory() pushes this out another 30
  // minutes on every new message, so it always reflects "30 minutes since
  // the last activity in this chat".
  expiresAt: { type: Date, required: true, expires: 0 },
}, { timestamps: true });

module.exports = mongoose.model('AiConversation', AiConversationSchema);
