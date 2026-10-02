/**
 * AiConversation Model
 * Persists AI conversation history per user per persona
 * 
 * Key changes from original design:
 * 1. Now supports 3 separate conversations per user (one per persona)
 * 2. Expires after 7 days of inactivity (not 30 minutes)
 * 3. Bot owner has unlimited chat history (no expiration)
 * 4. Each persona switch starts a new conversation thread
 * 5. Switching back to a persona returns to that persona's conversation
 */

import mongoose from 'mongoose';
import { BOT_OWNER } from '../utils/config.js';

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
  // NEW: Track which persona this conversation is for
  // This allows 3 separate conversations per user (one per persona)
  personaId: { type: String, required: true, default: 'default' },
  // Capped to the most recent messages via $slice in addTurnToHistory()
  // see commands/ai.js — rather than enforced here.
  messages: [{
    role: { type: String, required: true }, // 'user' | 'assistant'
    content: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
  }],
  // NEW: Track last activity time for inactivity-based expiration
  lastActivityAt: { type: Date, default: Date.now },
  // TTL field. `expires: 0` (a SchemaType option, not a query operator)
  // tells Mongoose to create the index as expireAfterSeconds: 0 — meaning
  // "expire exactly at the date stored here", not N seconds after some
  // other fixed timestamp. 
  // 
  // NEW: For non-owner users, this is set to 7 days from lastActivityAt
  // For bot owner, this is not set (unlimited history)
  expiresAt: { type: Date },
}, { timestamps: true });

// Compound unique index (replaces the old single-field unique index on
// chatId) — findOneAndUpdate's upsert relies on this being unique per
// (chatId, senderId, personaId) pair, not per chatId alone. This allows
// each user to have 3 separate conversations (one per persona).
AiConversationSchema.index({ chatId: 1, senderId: 1, personaId: 1 }, { unique: true });

// TTL index for automatic cleanup after 7 days of inactivity
// Only applies to non-owner users
AiConversationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/**
 * Helper to check if a user is the bot owner
 */
function isBotOwner(senderId) {
  const owner = BOT_OWNER || process.env.BOT_OWNER;
  if (!owner) return false;
  return senderId === owner || senderId.includes(owner.split('@')[0]);
}

/**
 * Get or create conversation for a specific persona
 * This ensures each persona has its own conversation thread
 */
async function getConversation(chatId, senderId, personaId) {
  const isOwner = isBotOwner(senderId);
  
  // For bot owner, no expiration
  const expiresAt = isOwner ? null : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  
  const conversation = await mongoose.model('AiConversation').findOneAndUpdate(
    { chatId, senderId, personaId },
    { 
      $set: { 
        lastActivityAt: new Date(),
        ...(!isOwner && expiresAt ? { expiresAt } : {})
      }
    },
    { upsert: true, new: true }
  );
  
  return conversation;
}

/**
 * Add a turn (user + assistant messages) to conversation history
 * Updates lastActivityAt and extends expiration for non-owner users
 */
async function addTurn(chatId, senderId, personaId, userContent, assistantContent) {
  const isOwner = isBotOwner(senderId);
  const now = new Date();
  const newExpiresAt = isOwner ? null : new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  
  const result = await mongoose.model('AiConversation').findOneAndUpdate(
    { chatId, senderId, personaId },
    {
      $push: {
        messages: {
          $each: [
            { role: 'user', content: userContent, timestamp: now },
            { role: 'assistant', content: assistantContent, timestamp: now },
          ],
          $slice: -20, // Keep last 20 messages
        },
      },
      $set: { 
        lastActivityAt: now,
        ...(newExpiresAt ? { expiresAt: newExpiresAt } : {})
      },
    },
    { upsert: true, new: true }
  );
  
  return result;
}

/**
 * Get conversation history for a specific persona
 */
async function getHistory(chatId, senderId, personaId) {
  const conversation = await mongoose.model('AiConversation').findOne({ 
    chatId, 
    senderId, 
    personaId 
  }).catch(err => {
    console.error('getHistory: lookup failed:', err.message);
    return null;
  });
  
  if (!conversation) return [];
  
  // Update lastActivityAt on read (keeps conversation alive)
  if (!isBotOwner(senderId)) {
    await mongoose.model('AiConversation').findOneAndUpdate(
      { chatId, senderId, personaId },
      { $set: { lastActivityAt: new Date() } }
    );
  }
  
  return conversation.messages.map(m => ({ role: m.role, content: m.content }));
}

/**
 * Switch persona - this starts a new conversation thread
 * Returns the existing conversation for that persona, or creates a new one
 */
async function switchPersona(chatId, senderId, newPersonaId) {
  // Get current active persona
  const { getActivePersonaSafe } = await import('../utils/persona.js');
  const currentPersona = getActivePersonaSafe();
  const currentPersonaId = currentPersona?.id || 'default';
  
  if (currentPersonaId === newPersonaId) {
    // Same persona, return existing conversation
    return getConversation(chatId, senderId, newPersonaId);
  }
  
  // Different persona, start fresh conversation
  return getConversation(chatId, senderId, newPersonaId);
}

const AiConversation = mongoose.model('AiConversation', AiConversationSchema);

// Export the model and helper functions
export { getConversation, addTurn, getHistory, switchPersona, isBotOwner };
export default AiConversation;
