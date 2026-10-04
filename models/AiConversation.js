const mongoose = require('mongoose');

// Persists .copilot/.voice conversation memory in Mongo (it survives PM2
// restarts). All reads and writes go through utils/aiConversations.js.
//
// One document per (chat, sender, PERSONA): a user who talks to Marin, then to
// Karane, then to Marin again has two separate threads, and the Marin one picks
// up exactly where it stopped. (Before this, the persona was not part of the
// key, so every character shared one thread and answered as if the previous
// character's conversation was their own.)
const AiConversationSchema = new mongoose.Schema({
  chatId: { type: String, required: true },
  // Who this conversation belongs to. In a DM chatId alone is unique per person,
  // but in a GROUP chatId is the same for every member, so senderId
  // (msg.author in a group, msg.from in a DM) keeps each person's thread apart.
  senderId: { type: String, required: true },
  // Which character the user was talking to (the persona id, e.g. "marin").
  personaId: { type: String, required: true },
  // Trimmed on every write ($slice) in utils/aiConversations.js: the most recent
  // AI_HISTORY_MESSAGES for everyone, a much larger AI_HISTORY_OWNER_KEPT for the owner.
  messages: [{
    role: { type: String, required: true }, // 'user' | 'assistant'
    content: { type: String, required: true },
  }],
  // Native MongoDB TTL field. `expires: 0` makes Mongo delete the document the
  // moment this date passes. Every exchange moves it to "now + 7 days", so it
  // always means "7 days after the last message". It is deliberately NOT
  // required: the bot owner's conversations have no expiresAt at all, and a TTL
  // index ignores documents without the field, so they can never expire.
  expiresAt: { type: Date, expires: 0 },
}, { timestamps: true });

// Replaces the old (chatId, senderId) unique index. findOneAndUpdate's upsert
// relies on this being unique per (chat, sender, persona). index.js runs
// syncIndexes() once at startup, which drops the old index and builds these.
AiConversationSchema.index({ chatId: 1, senderId: 1, personaId: 1 }, { unique: true });
// Lets "refresh every conversation this user has" find them without a scan.
AiConversationSchema.index({ senderId: 1 });

module.exports = mongoose.model('AiConversation', AiConversationSchema);
