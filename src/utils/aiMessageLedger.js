/**
 * AI Message Ledger
 * Tracks AI conversation messages with enhanced features:
 * - Emoji support in AI responses
 * - Emoji filtering for TTS/Voice commands
 * - Reaction handling
 */

import AiConversation from '../models/AiConversation.js';
import aiReactions from './aiReactions.js';
import { getActivePersonaSafe } from './persona.js';
import { BOT_OWNER } from './config.js';

// Fish Audio expression tags that should be filtered out for TTS
// These are internal control codes that shouldn't be spoken aloud
const FISH_EXPRESSION_TAGS = [
  '[happy]', '[sad]', '[angry]', '[excited]', '[nervous]', '[sarcastic]',
  '[whisper]', '[shout]', '[laugh]', '[cry]', '[surprised]', '[confused]',
  '[tired]', '[bored]', '[scared]', '[disgusted]', '[proud]', '[shy]',
];

/**
 * Check if user is bot owner
 */
function isBotOwner(senderId) {
  const owner = BOT_OWNER || process.env.BOT_OWNER;
  if (!owner) return false;
  return senderId === owner || senderId.includes(owner.split('@')[0]);
}

/**
 * Add a message to the conversation history
 * Handles persona switching and expiration logic
 */
async function addToHistory(msg, role, content, personaId = null) {
  const senderId = msg.author || msg.from;
  const chatId = msg.from;
  
  // Get active persona if not provided
  if (!personaId) {
    const persona = getActivePersonaSafe();
    personaId = persona?.id || 'default';
  }
  
  // Check if this is a reaction to bot's own message
  // If AI reacts to its own message, don't send a message
  if (role === 'assistant' && content.startsWith('[REACT:') && msg.fromMe) {
    // This is the bot reacting to its own message - just record it
    const conversation = await AiConversation.findOneAndUpdate(
      { chatId, senderId, personaId },
      { 
        $push: { messages: { role, content, timestamp: new Date() } },
        $slice: -20,
        $set: { lastActivityAt: new Date() }
      },
      { upsert: true, new: true }
    );
    return conversation;
  }
  
  // For user messages, check if they're reacting to AI's message
  if (role === 'user') {
    // Check if user is reacting to their own message
    // In this case, AI should be able to react but not send a message
    if (msg.hasQuotedMsg) {
      try {
        const quoted = await msg.getQuotedMessage();
        if (quoted.fromMe) {
          // User is reacting to AI's message
          // AI can react back but shouldn't send a text message
          // Just record the user's reaction in history
          const conversation = await AiConversation.findOneAndUpdate(
            { chatId, senderId, personaId },
            { 
              $push: { messages: { role, content, timestamp: new Date() } },
              $slice: -20,
              $set: { lastActivityAt: new Date() }
            },
            { upsert: true, new: true }
          );
          return conversation;
        }
      } catch (err) {
        console.error('Error checking quoted message:', err.message);
      }
    }
  }
  
  // Normal message - add to history with expiration logic
  const isOwner = isBotOwner(senderId);
  const now = new Date();
  const expiresAt = isOwner ? null : new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  
  const conversation = await AiConversation.findOneAndUpdate(
    { chatId, senderId, personaId },
    {
      $push: {
        messages: {
          $each: [{ role, content, timestamp: now }],
          $slice: -20,
        },
      },
      $set: { 
        lastActivityAt: now,
        ...(expiresAt ? { expiresAt } : {})
      },
    },
    { upsert: true, new: true }
  );
  
  return conversation;
}

/**
 * Get conversation history for a user with a specific persona
 */
async function getHistory(msg, personaId = null) {
  const senderId = msg.author || msg.from;
  const chatId = msg.from;
  
  if (!personaId) {
    const persona = getActivePersonaSafe();
    personaId = persona?.id || 'default';
  }
  
  const conversation = await AiConversation.findOne({ 
    chatId, 
    senderId, 
    personaId 
  }).catch(err => {
    console.error('getHistory: lookup failed:', err.message);
    return null;
  });
  
  if (!conversation) return [];
  
  // Update lastActivityAt on read
  if (!isBotOwner(senderId)) {
    await AiConversation.findOneAndUpdate(
      { chatId, senderId, personaId },
      { $set: { lastActivityAt: new Date() } }
    );
  }
  
  return conversation.messages.map(m => ({ role: m.role, content: m.content }));
}

/**
 * Filter out Fish Audio expression tags from text
 * These should not be spoken aloud when using .tts or .voice
 */
function filterEmojisForTTS(text) {
  if (!text) return text;
  
  let result = text;
  
  // Remove Fish Audio expression tags
  FISH_EXPRESSION_TAGS.forEach(tag => {
    result = result.replace(new RegExp(tag, 'gi'), '');
  });
  
  // Remove emoji reaction codes like [[emoji:😊]]
  result = result.replace(/\[\[emoji:[^\]]+\]\]/g, '');
  
  // Remove sticker codes like [[sticker:N]]
  result = result.replace(/\[\[sticker:[^\]]+\]\]/g, '');
  
  return result.trim();
}

/**
 * Add emoji support back to AI responses
 * But ensure they're filtered for TTS/Voice commands
 */
async function processAIResponse(msg, content, command) {
  // For TTS and Voice commands, filter out expressions
  if (command === 'tts' || command === 'voice') {
    return filterEmojisForTTS(content);
  }
  
  // For normal AI responses, allow emojis
  // Also handle reaction and sticker codes
  let processed = content;
  
  // Handle emoji reaction codes: [[emoji:😊]] -> add actual emoji as reaction
  const emojiReactionMatches = processed.matchAll(/\[\[emoji:([^\]]+)\]\]/g);
  for (const match of emojiReactionMatches) {
    const emoji = match[1];
    // For now, just remove the code - reaction handling is done separately
    processed = processed.replace(match[0], '');
    
    // If this is a reaction to a quoted message, handle it
    if (msg.hasQuotedMsg) {
      try {
        const quoted = await msg.getQuotedMessage();
        if (quoted.id) {
          await aiReactions.addReaction(msg, quoted.id, emoji);
        }
      } catch (err) {
        console.error('Error adding reaction:', err.message);
      }
    }
  }
  
  // Handle sticker codes: [[sticker:N]]
  const stickerMatches = processed.matchAll(/\[\[sticker:(\d+)\]\]/g);
  for (const match of stickerMatches) {
    const stickerNum = parseInt(match[1]);
    processed = processed.replace(match[0], '');
    
    // Send the sticker
    try {
      const { aiStickers } = await import('./aiStickers.js');
      await aiStickers.sendStickerByNumber(msg, stickerNum);
    } catch (err) {
      console.error('Error sending sticker:', err.message);
    }
  }
  
  return processed.trim();
}

/**
 * Handle persona switching
 * When persona is switched, start a new conversation thread
 */
async function switchPersona(msg, newPersonaId) {
  const senderId = msg.author || msg.from;
  const chatId = msg.from;
  
  // Get current persona
  const persona = getActivePersonaSafe();
  const currentPersonaId = persona?.id || 'default';
  
  if (currentPersonaId === newPersonaId) {
    // Same persona, return existing conversation
    return AiConversation.findOne({ chatId, senderId, personaId: newPersonaId });
  }
  
  // Different persona, start fresh conversation
  const isOwner = isBotOwner(senderId);
  const now = new Date();
  const expiresAt = isOwner ? null : new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  
  const conversation = await AiConversation.findOneAndUpdate(
    { chatId, senderId, personaId: newPersonaId },
    {
      $set: { 
        lastActivityAt: now,
        ...(expiresAt ? { expiresAt } : {})
      }
    },
    { upsert: true, new: true }
  );
  
  return conversation;
}

export { 
  addToHistory, 
  getHistory, 
  filterEmojisForTTS, 
  processAIResponse,
  switchPersona,
  isBotOwner,
  FISH_EXPRESSION_TAGS
};

export default {
  addToHistory,
  getHistory,
  filterEmojisForTTS,
  processAIResponse,
  switchPersona,
  isBotOwner,
  FISH_EXPRESSION_TAGS
};
