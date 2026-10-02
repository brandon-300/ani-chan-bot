/**
 * Identity Service for WhatsApp Adapter
 * Handles sender identification, JID normalization, and permission checks
 */

import socketManager from './socket.js';

class IdentityService {
  constructor() {
    this.sock = null;
    this.ownerNumber = process.env.OWNER_NUMBER || process.env.BOT_OWNER;
    this.modNumbers = (process.env.MOD_NUMBERS || '').split(',').filter(Boolean);
  }

  init(sock) {
    this.sock = sock || socketManager.getSocket();
  }

  getSock() {
    if (!this.sock) {
      this.sock = socketManager.getSocket();
    }
    return this.sock;
  }

  /**
   * Normalize JID to standard format
   * @param {string} jid - JID to normalize
   * @returns {string} Normalized JID
   */
  normalizeJid(jid) {
    if (!jid) return jid;
    
    // Remove any whitespace
    jid = jid.trim();
    
    // If it's already a full JID, return as-is
    if (jid.includes('@')) {
      return jid;
    }
    
    // If it's a plain number, add @s.whatsapp.net
    if (/^\d+$/.test(jid)) {
      return `${jid}@s.whatsapp.net`;
    }
    
    return jid;
  }

  /**
   * Get sender info from message
   * @param {object} msg - Message object
   * @returns {object} Sender info { id, name, pushName, number }
   */
  getSender(msg) {
    if (!msg) return null;

    // From normalized message
    if (msg.author) {
      return {
        id: msg.author,
        name: msg.pushName || msg.author.split('@')[0],
        pushName: msg.pushName || msg.author.split('@')[0],
        number: msg.author.split('@')[0],
      };
    }

    // From Baileys message
    if (msg._baileys) {
      const baileysMsg = msg._baileys;
      const { key, pushName, participant } = baileysMsg;
      
      const isGroup = key.remoteJid?.endsWith('@g.us');
      const senderId = isGroup && participant ? participant : key.remoteJid;
      
      return {
        id: senderId,
        name: pushName || senderId.split('@')[0],
        pushName: pushName || senderId.split('@')[0],
        number: senderId.split('@')[0],
      };
    }

    // From key object
    if (msg.key) {
      const { key, pushName, participant } = msg;
      const isGroup = key.remoteJid?.endsWith('@g.us');
      const senderId = isGroup && participant ? participant : key.remoteJid;
      
      return {
        id: senderId,
        name: pushName || senderId.split('@')[0],
        pushName: pushName || senderId.split('@')[0],
        number: senderId.split('@')[0],
      };
    }

    return null;
  }

  /**
   * Resolve sender name from message
   * @param {object} msg - Message object
   * @returns {string} Sender name
   */
  async resolveSenderName(msg) {
    const sender = this.getSender(msg);
    if (sender) return sender.pushName || sender.name || sender.id.split('@')[0];
    
    return msg.pushName || msg.from?.split('@')[0] || 'Unknown';
  }

  /**
   * Check if user is owner
   * @param {string} userId - User JID or number
   * @returns {boolean}
   */
  isOwner(userId) {
    if (!userId) return false;
    
    const normalizedUserId = this.normalizeJid(userId);
    const normalizedOwner = this.normalizeJid(this.ownerNumber);
    
    // Direct comparison
    if (normalizedUserId === normalizedOwner) return true;
    
    // Compare just the number part
    const userNumber = normalizedUserId.split('@')[0];
    const ownerNumber = normalizedOwner.split('@')[0];
    
    return userNumber === ownerNumber;
  }

  /**
   * Check if user is mod
   * @param {string} userId - User JID or number
   * @returns {boolean}
   */
  isMod(userId) {
    if (!userId) return false;
    
    const normalizedUserId = this.normalizeJid(userId);
    const userNumber = normalizedUserId.split('@')[0];
    
    // Check if owner
    if (this.isOwner(userId)) return true;
    
    // Check mod numbers
    for (const modNumber of this.modNumbers) {
      const normalizedMod = this.normalizeJid(modNumber);
      const modNumberPart = normalizedMod.split('@')[0];
      
      if (userNumber === modNumberPart) return true;
    }
    
    return false;
  }

  /**
   * Check if user is admin (mod or owner)
   * @param {string} userId - User JID or number
   * @returns {boolean}
   */
  isAdmin(userId) {
    return this.isOwner(userId) || this.isMod(userId);
  }

  /**
   * Get bot's own JID
   * @returns {string}
   */
  getBotJid() {
    const sock = this.getSock();
    if (!sock) return null;
    
    return sock.user?.id || socketManager.getWid();
  }

  /**
   * Get bot's own number
   * @returns {string}
   */
  getBotNumber() {
    const jid = this.getBotJid();
    if (!jid) return null;
    return jid.split('@')[0];
  }

  /**
   * Generate mention string for user
   * @param {string} jid - User JID
   * @returns {string} Mention string
   */
  mention(jid) {
    if (!jid) return '';
    const normalized = this.normalizeJid(jid);
    return `@${normalized.split('@')[0]}`;
  }

  /**
   * Get user info from JID
   * @param {string} jid - User JID
   * @returns {Promise<object>} User info
   */
  async getUserInfo(jid) {
    const sock = this.getSock();
    if (!sock) throw new Error('Socket not initialized');
    
    try {
      // For now, return basic info
      // Baileys doesn't have a direct getContact method
      return {
        id: jid,
        name: jid.split('@')[0],
        pushName: jid.split('@')[0],
        isBot: jid === this.getBotJid(),
      };
    } catch (error) {
      console.error('Failed to get user info:', error);
      return {
        id: jid,
        name: jid.split('@')[0],
        pushName: jid.split('@')[0],
      };
    }
  }

  /**
   * Check if message is from bot
   * @param {object} msg - Message object
   * @returns {boolean}
   */
  isFromBot(msg) {
    if (!msg) return false;
    
    if (msg.fromMe) return true;
    
    const sender = this.getSender(msg);
    if (!sender) return false;
    
    return sender.id === this.getBotJid();
  }

  /**
   * Get contact from JID
   * @param {string} jid - User JID
   * @returns {Promise<object>} Contact info
   */
  async getContact(jid) {
    const normalizedJid = this.normalizeJid(jid);
    
    return {
      id: { _serialized: normalizedJid },
      name: normalizedJid.split('@')[0],
      pushName: normalizedJid.split('@')[0],
    };
  }
}

const identity = new IdentityService();
export default identity;
