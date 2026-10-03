/**
 * Messages Service for WhatsApp Adapter
 * Centralized message sending and management
 * 
 * This is the AUTHORITATIVE transport path for all outgoing messages.
 * All send operations should flow through this service.
 */

import { toBaileysMediaPayload } from './media.js';
import socketManager from './socket.js';
import identity from './identity.js';
import pino from 'pino';
import { BOT_NAME } from '../utils/config.js';
import { getActivePersonaSafe } from '../utils/persona.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'silent' });

/**
 * Extract message key from various message formats
 * Handles both Baileys and normalized message formats
 */
function messageKey(message) {
  if (!message) return null;
  
  // Try to get from _baileys first
  const raw = message?._baileys?.key || message?.key || {};
  
  // Extract ID
  let id = raw.id || message?.id?._serialized || message?.id;
  if (!id) {
    // Try to get from message itself
    id = message.messageId || message._data?.id;
  }
  
  // Extract remoteJid
  let remoteJid = raw.remoteJid || message?.chatId || message?.from || message?._data?.from;
  if (!remoteJid) {
    // Try to get from message
    remoteJid = message.chatId || message.from || message._data?.from;
  }
  
  if (!id || !remoteJid) return null;
  
  // Normalize the JIDs
  const normalizedRemoteJid = identity.normalizeJid(remoteJid);
  
  // Handle participant for group messages
  const participant = raw.participant || 
    (message.isGroup ? (message.author || message.participant) : undefined) ||
    (raw.fromMe ? undefined : raw.participant);
  
  const normalizedParticipant = participant ? identity.normalizeJid(participant) : undefined;
  
  return {
    ...raw,
    id,
    remoteJid: normalizedRemoteJid,
    fromMe: raw.fromMe ?? Boolean(message?.fromMe),
    participant: normalizedParticipant,
    // Include alternate JIDs if available
    remoteJidAlt: raw.remoteJidAlt,
    participantAlt: raw.participantAlt,
  };
}

/**
 * Get guaranteed sticker metadata
 * Ensures packName = BOT_NAME and author = active persona
 */
function getStickerMetadata(options = {}) {
  const persona = getActivePersonaSafe();
  const packName = options.packName || options.stickerPack || BOT_NAME;
  const author = options.author || options.stickerAuthor || (persona?.stickerAuthor || persona?.displayName || BOT_NAME);
  const categories = options.categories || ['\ud83d\ude02'];
  const keepScale = options.keepScale !== undefined ? options.keepScale : true;
  const circle = options.circle !== undefined ? options.circle : false;
  const removeBackground = options.removeBackground !== undefined ? options.removeBackground : false;
  
  return {
    packName,
    author,
    categories,
    keepScale,
    circle,
    removeBackground,
  };
}

/**
 * Convert content to Baileys payload
 * Handles MessageMedia, strings, and objects
 * Guarantees sticker metadata for sticker content
 */
function payloadFor(content, options = {}) {
  const mediaPayload = toBaileysMediaPayload(content, options);
  if (mediaPayload) {
    // Ensure sticker metadata is set
    if (mediaPayload.sticker && !mediaPayload.packname) {
      const metadata = getStickerMetadata(options);
      mediaPayload.packname = metadata.packName;
      mediaPayload.author = metadata.author;
      mediaPayload.categories = metadata.categories;
      mediaPayload.keepScale = metadata.keepScale;
      mediaPayload.circle = metadata.circle;
      mediaPayload.removeBackground = metadata.removeBackground;
    }
    return mediaPayload;
  }
  
  if (typeof content === 'string') {
    const text = { text: content };
    if (Array.isArray(options.mentions) && options.mentions.length) text.mentions = options.mentions;
    return text;
  }
  
  if (content && typeof content === 'object') {
    const payload = { ...content };
    if (Array.isArray(options.mentions) && options.mentions.length) payload.mentions = options.mentions;
    if (options.caption !== undefined && payload.caption === undefined) payload.caption = options.caption;
    
    // Ensure sticker metadata for sticker objects
    if (payload.sticker && !payload.packname) {
      const metadata = getStickerMetadata(options);
      payload.packname = metadata.packName;
      payload.author = metadata.author;
      payload.categories = metadata.categories;
      payload.keepScale = metadata.keepScale;
      payload.circle = metadata.circle;
      payload.removeBackground = metadata.removeBackground;
    }
    
    return payload;
  }
  
  return { text: String(content ?? '') };
}

/**
 * Build send options for Baileys
 * Handles quoting, link preview, and other options
 */
function sendOptions(options = {}, quotedMessage = null) {
  const output = {};
  
  // Handle quoted message
  const quoted = options.quoted || quotedMessage?._baileys || quotedMessage?.key || null;
  if (quoted) {
    output.quoted = quoted;
  }
  
  // Link preview
  if (options.linkPreview !== undefined) output.linkPreview = options.linkPreview;
  
  // Message ID
  if (options.messageId) output.messageId = options.messageId;
  
  // Ephemeral settings
  if (options.ephemeralSettings !== undefined) output.ephemeralSettings = options.ephemeralSettings;
  
  return output;
}

/**
 * Messages Service
 * Centralized message sending and management
 * THIS IS THE AUTHORITATIVE TRANSPORT PATH
 */
class MessagesService {
  constructor() {
    this.sock = null;
    this.sentMessageRegistry = new Map();
  }

  init(sock) {
    this.sock = sock || null;
  }

  getSock() {
    if (!this.sock) throw new Error('WhatsApp socket is not initialized.');
    return this.sock;
  }

  /**
   * Register a sent message for tracking
   * Used for reaction detection, message history, etc.
   * Also registers with socket manager for backward compatibility
   */
  registerSentMessage(key, msg) {
    const msgKey = key.id || key._serialized;
    this.sentMessageRegistry.set(msgKey, { key, msg, timestamp: Date.now() });
    
    // Also register with socket manager for backward compatibility
    socketManager.registerSentMessage(key, msg);
    
    // Cleanup after 1 hour
    const cleanupTimer = setTimeout(() => {
      this.sentMessageRegistry.delete(msgKey);
    }, 3600000);
    cleanupTimer.unref?.();
  }

  /**
   * Check if a message was sent by the bot
   */
  isBotMessage(key) {
    const msgKey = key.id || key._serialized;
    return this.sentMessageRegistry.has(msgKey) || socketManager.isBotMessage(key);
  }

  /**
   * Get bot's sent message by key
   */
  getBotSentMessage(key) {
    const msgKey = key.id || key._serialized;
    return this.sentMessageRegistry.get(msgKey) || socketManager.getBotSentMessage(key);
  }

  /**
   * Send text message
   */
  async sendText(jid, text, options = {}) {
    return this.sendMessage(jid, text, options);
  }

  /**
   * Send message - CENTRAL AUTHORITATIVE TRANSPORT METHOD
   * ALL outgoing messages should flow through this method
   * Guarantees sticker metadata (BOT_NAME + active persona)
   */
  async sendMessage(jid, content, options = {}, quotedMessage = null) {
    if (!jid) throw new TypeError('A recipient JID is required.');
    
    const sock = this.getSock();
    const normalizedJid = identity.normalizeJid(jid);
    
    try {
      // Build payload with guaranteed sticker metadata
      const payload = payloadFor(content, options);
      const sendOpts = sendOptions(options, quotedMessage);
      
      const result = await sock.sendMessage(normalizedJid, payload, sendOpts);
      
      if (result?.key) {
        this.registerSentMessage(result.key, result);
      }
      
      return result;
    } catch (error) {
      logger.error({ error, jid: normalizedJid }, 'Failed to send WhatsApp message');
      throw error;
    }
  }

  /**
   * Reply to a message
   * All replies flow through sendMessage with quoting
   */
  async reply(message, content, options = {}) {
    const jid = message?.chatId || message?.from;
    if (!jid) throw new TypeError('Cannot reply to a message without a chat JID.');
    
    const normalizedJid = identity.normalizeJid(jid);
    const quote = message?._baileys || message?.key || null;
    
    return this.sendMessage(normalizedJid, content, { 
      ...options, 
      quoted: options.quoted || quote 
    });
  }

  /**
   * Send sticker with guaranteed metadata
   * Ensures packName = BOT_NAME and author = active persona
   */
  async sendSticker(jid, sticker, options = {}) {
    // Merge sticker metadata guarantees with provided options
    const metadata = getStickerMetadata(options);
    const stickerOptions = {
      ...metadata,
      ...options,
      // Ensure these are always set
      packName: metadata.packName,
      author: metadata.author,
    };
    
    return this.sendMessage(jid, sticker, stickerOptions);
  }

  /**
   * Send image
   */
  async sendImage(jid, image, options = {}) {
    return this.sendMessage(jid, image, options);
  }

  /**
   * Send video
   */
  async sendVideo(jid, video, options = {}) {
    return this.sendMessage(jid, video, options);
  }

  /**
   * Send audio
   * Properly handles voice notes vs regular audio
   */
  async sendAudio(jid, audio, options = {}) {
    return this.sendMessage(jid, audio, options);
  }

  /**
   * Send document
   */
  async sendDocument(jid, document, options = {}) {
    return this.sendMessage(jid, document, options);
  }

  /**
   * React to a message
   */
  async react(message, emoji) {
    const sock = this.getSock();
    const key = messageKey(message);
    if (!key) throw new TypeError('Cannot react without a valid WhatsApp message key.');
    
    const normalizedKey = {
      ...key,
      remoteJid: identity.normalizeJid(key.remoteJid),
    };
    
    return sock.sendMessage(normalizedKey.remoteJid, { 
      react: { 
        text: String(emoji || ''), 
        key: normalizedKey 
      } 
    });
  }

  /**
   * Delete a message
   */
  async delete(message, forEveryone = true) {
    const sock = this.getSock();
    const key = messageKey(message);
    if (!key) throw new TypeError('Cannot delete without a valid WhatsApp message key.');
    
    if (!forEveryone) return false;
    
    const normalizedKey = {
      ...key,
      remoteJid: identity.normalizeJid(key.remoteJid),
    };
    
    return sock.sendMessage(normalizedKey.remoteJid, { delete: normalizedKey });
  }

  /**
   * Edit a message
   * Note: Baileys edit is not the same as delete+send
   * This method uses Baileys' edit capability if available
   */
  async edit(message, newText) {
    const jid = message?.chatId || message?.from;
    if (!jid) throw new TypeError('Cannot edit a message without a chat JID.');
    
    const normalizedJid = identity.normalizeJid(jid);
    const key = messageKey(message);
    if (!key) throw new TypeError('Cannot edit without a valid WhatsApp message key.');
    
    const sock = this.getSock();
    
    // Check if socket supports edit
    if (sock.editMessage) {
      try {
        return await sock.editMessage(normalizedJid, key, { text: newText });
      } catch (error) {
        logger.warn('editMessage not supported, falling back to delete+send');
      }
    }
    
    // Fallback: delete and send new message
    await this.delete(message, true);
    return this.sendText(normalizedJid, newText);
  }

  /**
   * Send typing indicator
   */
  async sendTyping(jid) {
    const normalizedJid = identity.normalizeJid(jid);
    return this.getSock().sendPresenceUpdate('composing', normalizedJid);
  }

  /**
   * Send recording indicator
   */
  async sendRecording(jid) {
    const normalizedJid = identity.normalizeJid(jid);
    return this.getSock().sendPresenceUpdate('recording', normalizedJid);
  }

  /**
   * Clear presence
   */
  async clearPresence(jid) {
    const normalizedJid = identity.normalizeJid(jid);
    return this.getSock().sendPresenceUpdate('paused', normalizedJid);
  }

  /**
   * Mark message as read
   */
  async markAsRead(message) {
    const key = messageKey(message);
    if (!key) throw new TypeError('Cannot mark read without a valid WhatsApp message key.');
    
    const normalizedKey = {
      ...key,
      remoteJid: identity.normalizeJid(key.remoteJid),
    };
    
    return this.getSock().readMessages([normalizedKey]);
  }

  /**
   * Forward a message
   */
  async forward(message, jid) {
    if (!message) throw new TypeError('Cannot forward without a message.');
    if (!jid) throw new TypeError('Cannot forward without a target JID.');
    
    const normalizedJid = identity.normalizeJid(jid);
    const baileysMsg = message._baileys || message;
    
    const { key, message: msgContent } = baileysMsg;
    const forwardMsg = { ...msgContent, key: { ...key } };
    delete forwardMsg.key.id;
    
    const result = await this.getSock().sendMessage(normalizedJid, {
      forward: forwardMsg,
    });
    
    if (result?.key) {
      this.registerSentMessage(result.key, result);
    }
    
    return result;
  }
}

const messages = new MessagesService();
export default messages;
