/**
 * Messages Service for WhatsApp Adapter
 * Handles sending, replying, reacting, and deleting messages
 */

import socketManager from './socket.js';

class MessagesService {
  constructor() {
    this.sock = null;
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
   * Send text message
   * @param {string} jid - Target JID
   * @param {string} text - Text content
   * @param {object} options - Message options
   */
  async sendText(jid, text, options = {}) {
    const sock = this.getSock();
    if (!sock) throw new Error('Socket not initialized');
    
    const msgOptions = {
      text,
      ...options,
    };
    
    if (options.quotedMessageId) {
      msgOptions.quoted = {
        id: options.quotedMessageId,
        remoteJid: jid,
      };
    }
    
    if (options.mentions) {
      msgOptions.mentions = options.mentions;
    }
    
    const result = await sock.sendMessage(jid, msgOptions);
    if (result && result.key) {
      socketManager.registerSentMessage(result.key, result);
    }
    return result;
  }

  /**
   * Reply to a message
   * @param {object} msg - Message to reply to
   * @param {*} content - Reply content
   * @param {object} options - Message options
   */
  async reply(msg, content, options = {}) {
    const sock = this.getSock();
    if (!sock) throw new Error('Socket not initialized');
    
    const jid = msg.chatId || msg.from;
    const quotedMsg = msg;
    
    if (typeof content === 'string') {
      return this.sendText(jid, content, { ...options, quotedMessageId: quotedMsg.id?._serialized || quotedMsg.id });
    }
    
    // For media content
    const media = { ...content };
    
    if (quotedMsg.id) {
      media.quoted = {
        id: quotedMsg.id._serialized || quotedMsg.id,
        remoteJid: jid,
      };
    }
    
    const result = await sock.sendMessage(jid, media, options);
    if (result && result.key) {
      socketManager.registerSentMessage(result.key, result);
    }
    return result;
  }

  /**
   * React to a message
   * @param {object} msg - Message to react to
   * @param {string} emoji - Reaction emoji
   */
  async react(msg, emoji) {
    const sock = this.getSock();
    if (!sock) throw new Error('Socket not initialized');
    
    const key = msg.id ? { ...msg.id, remoteJid: msg.chatId || msg.from } : msg._baileys?.key;
    
    try {
      await sock.react(key, emoji);
      return true;
    } catch (error) {
      console.error('❌ Failed to react:', error.message);
      return false;
    }
  }

  /**
   * Delete a message
   * @param {object} msg - Message to delete
   * @param {boolean} forEveryone - Delete for everyone in group
   */
  async delete(msg, forEveryone = false) {
    const sock = this.getSock();
    if (!sock) throw new Error('Socket not initialized');
    
    const key = msg.id ? { ...msg.id, remoteJid: msg.chatId || msg.from } : msg._baileys?.key;
    
    try {
      await sock.deleteMessage(key, forEveryone);
      return true;
    } catch (error) {
      console.error('❌ Failed to delete message:', error.message);
      return false;
    }
  }

  /**
   * Edit a message (if supported)
   * @param {object} msg - Message to edit
   * @param {string} newText - New text content
   */
  async edit(msg, newText) {
    const sock = this.getSock();
    if (!sock) throw new Error('Socket not initialized');
    
    const key = msg.id ? { ...msg.id, remoteJid: msg.chatId || msg.from } : msg._baileys?.key;
    
    try {
      // Baileys doesn't support edit directly, but we can delete and resend
      await this.delete(msg);
      return this.sendText(msg.chatId || msg.from, newText);
    } catch (error) {
      console.error('❌ Failed to edit message:', error.message);
      throw error;
    }
  }

  /**
   * Send typing indicator
   * @param {string} jid - Target JID
   */
  async sendTyping(jid) {
    const sock = this.getSock();
    if (!sock) throw new Error('Socket not initialized');
    
    try {
      await sock.sendPresenceUpdate('composing', jid);
      return true;
    } catch (error) {
      console.error('❌ Failed to send typing indicator:', error.message);
      return false;
    }
  }

  /**
   * Send recording indicator
   * @param {string} jid - Target JID
   */
  async sendRecording(jid) {
    const sock = this.getSock();
    if (!sock) throw new Error('Socket not initialized');
    
    try {
      await sock.sendPresenceUpdate('recording', jid);
      return true;
    } catch (error) {
      console.error('❌ Failed to send recording indicator:', error.message);
      return false;
    }
  }

  /**
   * Clear presence (stop typing/recording)
   * @param {string} jid - Target JID
   */
  async clearPresence(jid) {
    const sock = this.getSock();
    if (!sock) throw new Error('Socket not initialized');
    
    try {
      await sock.sendPresenceUpdate('paused', jid);
      return true;
    } catch (error) {
      console.error('❌ Failed to clear presence:', error.message);
      return false;
    }
  }

  /**
   * Mark message as read
   * @param {object} msg - Message to mark as read
   */
  async markAsRead(msg) {
    const sock = this.getSock();
    if (!sock) throw new Error('Socket not initialized');
    
    const key = msg.id ? { ...msg.id, remoteJid: msg.chatId || msg.from } : msg._baileys?.key;
    
    try {
      await sock.readMessages([key]);
      return true;
    } catch (error) {
      console.error('❌ Failed to mark as read:', error.message);
      return false;
    }
  }
}

const messages = new MessagesService();
export default messages;
