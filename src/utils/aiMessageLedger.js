/**
 * AI Message Ledger
 * Tracks AI conversation messages with enhanced features:
 * - Emoji support in AI responses
 * - Emoji filtering for TTS/Voice commands
 * - Reaction handling for bot's own messages
 * - Persona-aware conversation tracking
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
  '[gasp]', '[sigh]', '[giggle]', '[chuckle]', '[sobbing]', '[panting]',
  '[groaning]', '[laughing]', '[shouting]', '[screaming]', '[crying]',
];

// Emoji patterns that should be filtered for TTS
const EMOTICON_PATTERNS = [
  /[:;=8][-^']?[)(DPpOo3\/\\|*$]+/g,
  /[xX][Dd]+/g,
  /[>^<][_.-]?[<^>]/g,
  /[Tt][_.-][Tt]/g,
  /-_-/g,
  /o_o/g,
  /O_O/g,
  /;_;/g,
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
 * Track AI sent messages for reaction detection
 */
const aiSentMessages = new Map();

/**
 * Remember an AI sent message for reaction tracking
 */
function remember(msg, kind, personaId = 'default') {
  if (!msg || !msg.id) return;
  
  const key = msg.id._serialized || msg.id;
  aiSentMessages.set(key, {
    msg,
    kind,
    personaId,
    timestamp: Date.now(),
    fromMe: msg.fromMe || false,
    chatId: msg.chatId || msg.from,
  });
  
  setTimeout(() => aiSentMessages.delete(key), 3600000);
}

/**
 * Check if a message is a bot's own message
 */
function isAIBotMessage(msg) {
  if (!msg || !msg.id) return false;
  const key = msg.id._serialized || msg.id;
  return aiSentMessages.has(key);
}

/**
 * Get the AI's sent message by key
 */
function getAISentMessage(key) {
  const id = key._serialized || key.id || key;
  return aiSentMessages.get(id);
}

/**
 * Handle reaction to AI's own message
 * AI can react back but should NOT send a text message
 */
async function handleReactionToAI(msg, reactionInfo) {
  if (!msg || !reactionInfo) return false;
  
  const { key, receipt, isReactionToBot, botMessage } = reactionInfo;
  
  if (!isReactionToBot || !botMessage) return false;
  
  if (receipt?.type === 'reaction' && receipt.reaction) {
    const emoji = receipt.reaction;
    const aiMsg = botMessage.msg;
    const personaId = botMessage.personaId || 'default';
    
    try {
      return { shouldReact: true, shouldSendText: false, emoji, personaId };
    } catch (err) {
      console.error('Error handling reaction to AI message:', err.message);
      return { shouldReact: false, shouldSendText: false, personaId };
    }
  }
  
  return { shouldReact: false, shouldSendText: true };
}

/**
 * Filter out Fish Audio expression tags from text
 * These should not be spoken aloud when using .tts or .voice
 */
function filterEmojisForTTS(text) {
  if (!text) return text;
  
  let result = text;
  
  FISH_EXPRESSION_TAGS.forEach(tag => {
    result = result.replace(new RegExp(tag, 'gi'), '');
  });
  
  result = result.replace(/\[\[\s*emoji:([^\]\r\n]*?)\s*\]\]/gi, '');
  result = result.replace(/\[\[\s*sticker:(\d+)\s*\]\]/gi, '');
  
  EMOTICON_PATTERNS.forEach(pattern => {
    result = result.replace(pattern, '');
  });
  
  result = result.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{200D}\u{23E9}-\u{23F3}\u{25AA}-\u{25AB}\u{25B6}\u{25C0}\u{25FB}-\u{25FE}\u{2614}-\u{2615}\u{2648}-\u{2653}\u{267F}\u{2693}\u{26A1}\u{26AA}-\u{26AB}\u{26BD}-\u{26BE}\u{26C4}-\u{26C5}\u{26CE}\u{26D4}\u{26EA}\u{26F2}-\u{26F3}\u{26F5}\u{26FA}-\u{26FF}\u{2702}\u{2705}\u{2708}-\u{270D}\u{270F}\u{2712}\u{2714}\u{2716}-\u{271D}\u{2721}\u{2728}\u{2733}-\u{2734}\u{2744}\u{2747}\u{274C}-\u{274E}\u{2753}-\u{2755}\u{2757}\u{2763}-\u{2767}\u{2795}-\u{2797}\u{27B0}\u{27BF}\u{2B1B}-\u{2B1C}\u{2B50}\u{2B55}\u{2934}-\u{2935}\u{2B00}-\u{2BFF}\u{3030}\u{303D}\u{3297}\u{3299}\u{1F004}\u{1F0CF}\u{1F170}-\u{1F251}\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F774}-\u{1F775}\u{1F7F0}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{1FB00}-\u{1FBFF}]/gu, '');
  
  result = result.replace(/\s+/g, ' ').trim();
  
  return result;
}

/**
 * Add emoji support back to AI responses
 * But ensure they're filtered for TTS/Voice commands
 */
async function processAIResponse(msg, content, command, personaId = 'default') {
  if (command === 'tts' || command === 'voice') {
    return filterEmojisForTTS(content);
  }
  
  let processed = content;
  
  const emojiReactionMatches = processed.matchAll(/\[\[\s*emoji:([^\]\r\n]*?)\s*\]\]/gi);
  for (const match of emojiReactionMatches) {
    const emoji = match[1];
    processed = processed.replace(match[0], '');
    
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
  
  const stickerMatches = processed.matchAll(/\[\[\s*sticker:(\d+)\s*\]\]/gi);
  for (const match of stickerMatches) {
    const stickerNum = parseInt(match[1]);
    processed = processed.replace(match[0], '');
    
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
 * Add a message to the conversation history with persona support
 * Handles reaction detection and expiration logic
 */
async function addToHistory(msg, role, content, personaId = null) {
  const senderId = msg.author || msg.from;
  const chatId = msg.from;
  
  if (!personaId) {
    const persona = getActivePersonaSafe();
    personaId = persona?.id || 'default';
  }
  
  if (role === 'assistant' && content.startsWith('[REACT:') && (msg.fromMe || isAIBotMessage(msg))) {
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
  
  if (role === 'user') {
    if (msg.hasQuotedMsg) {
      try {
        const quoted = await msg.getQuotedMessage();
        if (quoted.fromMe || isAIBotMessage(quoted)) {
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
  
  if (!isBotOwner(senderId)) {
    await AiConversation.findOneAndUpdate(
      { chatId, senderId, personaId },
      { $set: { lastActivityAt: new Date() } }
    );
  }
  
  return conversation.messages.map(m => ({ role: m.role, content: m.content }));
}

/**
 * Handle persona switching
 * When persona is switched, start a new conversation thread
 */
async function switchPersona(msg, newPersonaId) {
  const senderId = msg.author || msg.from;
  const chatId = msg.from;
  
  const persona = getActivePersonaSafe();
  const currentPersonaId = persona?.id || 'default';
  
  if (currentPersonaId === newPersonaId) {
    return AiConversation.findOne({ chatId, senderId, personaId: newPersonaId });
  }
  
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
  remember,
  isAIBotMessage,
  getAISentMessage,
  handleReactionToAI,
  addToHistory, 
  getHistory, 
  filterEmojisForTTS, 
  processAIResponse,
  switchPersona,
  isBotOwner,
  FISH_EXPRESSION_TAGS
};

export default {
  remember,
  isAIBotMessage,
  getAISentMessage,
  handleReactionToAI,
  addToHistory,
  getHistory,
  filterEmojisForTTS,
  processAIResponse,
  switchPersona,
  isBotOwner,
  FISH_EXPRESSION_TAGS
};
