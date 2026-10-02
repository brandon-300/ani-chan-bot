/**
 * WhatsApp Adapter Layer
 * Public API for all WhatsApp operations
 * This provides a clean abstraction over Baileys
 */

import socketManager from './socket.js';
import authManager from './auth.js';
import messages from './messages.js';
import media from './media.js';
import identity from './identity.js';
import groups from './groups.js';

/**
 * WhatsApp Adapter
 * Main entry point for all WhatsApp operations
 */
class WhatsAppAdapter {
  constructor() {
    this.socket = socketManager;
    this.auth = authManager;
    this.messages = messages;
    this.media = media;
    this.identity = identity;
    this.groups = groups;
    
    // Expose socket manager methods
    this.on = this.socket.on.bind(this.socket);
    this.emit = this.socket.emit.bind(this.socket);
    this.getSocket = this.socket.getSocket.bind(this.socket);
    this.getWid = this.socket.getWid.bind(this.socket);
    this.getUser = this.socket.getUser.bind(this.socket);
    this.connect = this.socket.connect.bind(this.socket);
    this.disconnect = this.socket.disconnect.bind(this.socket);
    this.isConnected = () => this.socket.isConnected;
    this.isAuthenticated = () => this.socket.isAuthenticated();
    
    // Bot info
    this.info = {
      get wid() {
        const jid = socketManager.getWid();
        return jid ? { _serialized: jid } : null;
      },
      get user() {
        return socketManager.getUser();
      },
      get pushname() {
        return socketManager.getUser()?.name || socketManager.info?.pushname;
      },
    };
  }

  /**
   * Initialize the adapter
   */
  async init() {
    // Ensure auth is initialized first
    await authManager.init();
    
    // Initialize socket
    await socketManager.init();
    
    // Initialize all services with the socket
    const sock = socketManager.getSocket();
    this.media.init(sock, (key, msg) => socketManager.registerSentMessage(key, msg));
    this.messages.init(sock);
    this.identity.init(sock);
    this.groups.init(sock);
    
    return this;
  }

  /**
   * Send text message
   * @param {string} jid - Target JID
   * @param {string} text - Text content
   * @param {object} options - Message options
   */
  async sendText(jid, text, options = {}) {
    return this.messages.sendText(jid, text, options);
  }

  /**
   * Reply to a message
   * @param {object} msg - Message to reply to
   * @param {*} content - Reply content
   * @param {object} options - Message options
   */
  async reply(msg, content, options = {}) {
    return this.messages.reply(msg, content, options);
  }

  /**
   * React to a message
   * @param {object} msg - Message to react to
   * @param {string} emoji - Reaction emoji
   */
  async react(msg, emoji) {
    return this.messages.react(msg, emoji);
  }

  /**
   * Delete a message
   * @param {object} msg - Message to delete
   * @param {boolean} forEveryone - Delete for everyone in group
   */
  async deleteMessage(msg, forEveryone = false) {
    return this.messages.delete(msg, forEveryone);
  }

  /**
   * Mark message as read
   * @param {object} msg - Message to mark as read
   */
  async markAsRead(msg) {
    return this.messages.markAsRead(msg);
  }

  /**
   * Send typing indicator
   * @param {string} jid - Target JID
   */
  async sendTyping(jid) {
    return this.messages.sendTyping(jid);
  }

  /**
   * Send recording indicator
   * @param {string} jid - Target JID
   */
  async sendRecording(jid) {
    return this.messages.sendRecording(jid);
  }

  /**
   * Clear presence
   * @param {string} jid - Target JID
   */
  async clearPresence(jid) {
    return this.messages.clearPresence(jid);
  }

  /**
   * Download media from a message
   * @param {object} msg - Message with media
   */
  async downloadMedia(msg) {
    return this.media.download(msg);
  }

  /**
   * Send image
   * @param {string} jid - Target JID
   * @param {Buffer|string} image - Image buffer or base64 string or URL
   * @param {object} options - Message options
   */
  async sendImage(jid, image, options = {}) {
    return this.media.sendImage(jid, image, options);
  }

  /**
   * Send video
   * @param {string} jid - Target JID
   * @param {Buffer|string} video - Video buffer or base64 string or URL
   * @param {object} options - Message options
   */
  async sendVideo(jid, video, options = {}) {
    return this.media.sendVideo(jid, video, options);
  }

  /**
   * Send audio
   * @param {string} jid - Target JID
   * @param {Buffer|string} audio - Audio buffer or base64 string or URL
   * @param {object} options - Message options
   */
  async sendAudio(jid, audio, options = {}) {
    return this.media.sendAudio(jid, audio, options);
  }

  /**
   * Send sticker
   * @param {string} jid - Target JID
   * @param {Buffer|string} sticker - Sticker buffer or base64 string or URL
   * @param {object} options - Message options including pack name and author
   */
  async sendSticker(jid, sticker, options = {}) {
    return this.media.sendSticker(jid, sticker, options);
  }

  /**
   * Send document
   * @param {string} jid - Target JID
   * @param {Buffer|string} document - Document buffer or base64 string or URL
   * @param {object} options - Message options
   */
  async sendDocument(jid, document, options = {}) {
    return this.media.sendDocument(jid, document, options);
  }

  /**
   * Send message with automatic content type detection
   * @param {string} jid - Target JID
   * @param {*} content - Message content
   * @param {object} options - Message options
   */
  async sendMessage(jid, content, options = {}) {
    return this.messages.sendMessage(jid, content, options);
  }

  /**
   * Get sender info from message
   * @param {object} msg - Message object
   * @returns {object} Sender info { id, name, pushName, number }
   */
  getSender(msg) {
    return this.identity.getSender(msg);
  }

  /**
   * Get group info
   * @param {string} jid - Group JID
   * @returns {Promise<object>} Group info
   */
  async getGroup(jid) {
    return this.groups.getGroup(jid);
  }

  /**
   * Get group participants
   * @param {string} jid - Group JID
   * @returns {Promise<Array>} List of participants
   */
  async getParticipants(jid) {
    return this.groups.getParticipants(jid);
  }

  async getChatById(jid) {
    return socketManager.getChat(jid);
  }

  async getChats() {
    const sock = socketManager.getSocket();
    if (!sock?.groupFetchAllParticipating) throw new Error('WhatsApp socket is not connected.');
    const groupsById = await sock.groupFetchAllParticipating();
    return Object.entries(groupsById || {}).map(([jid, group]) => ({
      id: { _serialized: jid },
      name: group.subject || jid,
      isGroup: true,
      participants: (group.participants || []).map(participant => {
        const participantId = identity.normalizeJid(participant.id);
        const name = participant.pushName || participantId.split('@')[0].split(':')[0];
        identity.rememberContact(participantId, name);
        return {
          id: { _serialized: participantId, user: participantId.split('@')[0].split(':')[0] },
          number: participantId.split('@')[0].split(':')[0],
          name,
          pushname: name,
          pushName: name,
          isAdmin: Boolean(participant.isAdmin),
          isSuperAdmin: Boolean(participant.isSuperAdmin),
        };
      }),
      sendMessage: (content, options = {}) => this.sendMessage(jid, content, options),
      setMessagesAdminsOnly: onlyAdmins => this.setMessagesAdminsOnly(jid, onlyAdmins),
    }));
  }

  async getContactById(jid) {
    return identity.getContact(jid);
  }

  async setMessagesAdminsOnly(jid, onlyAdmins) {
    return groups.setMessagesAdminsOnly(jid, onlyAdmins);
  }

  /**
   * Check if user is admin in group
   * @param {string} jid - Group JID
   * @param {string} userId - User JID
   * @returns {Promise<boolean>}
   */
  async isGroupAdmin(jid, userId) {
    return this.groups.isAdmin(jid, userId);
  }

  /**
   * Check if bot is admin in group
   * @param {string} jid - Group JID
   * @returns {Promise<boolean>}
   */
  async isBotAdmin(jid) {
    return this.groups.isBotAdmin(jid);
  }

  /**
   * Check if user is participant in group
   * @param {string} jid - Group JID
   * @param {string} userId - User JID
   * @returns {Promise<boolean>}
   */
  async isParticipant(jid, userId) {
    return this.groups.isParticipant(jid, userId);
  }

  /**
   * Promote participant to admin
   * @param {string} jid - Group JID
   * @param {string|string[]} userIds - User JID(s) to promote
   */
  async promote(jid, userIds) {
    return this.groups.promote(jid, userIds);
  }

  /**
   * Demote admin to participant
   * @param {string} jid - Group JID
   * @param {string|string[]} userIds - User JID(s) to demote
   */
  async demote(jid, userIds) {
    return this.groups.demote(jid, userIds);
  }

  /**
   * Remove participants from group
   * @param {string} jid - Group JID
   * @param {string|string[]} userIds - User JID(s) to remove
   */
  async removeParticipants(jid, userIds) {
    return this.groups.removeParticipants(jid, userIds);
  }

  /**
   * Add participants to group
   * @param {string} jid - Group JID
   * @param {string|string[]} userIds - User JID(s) to add
   */
  async addParticipants(jid, userIds) {
    return this.groups.addParticipants(jid, userIds);
  }

  /**
   * Leave group
   * @param {string} jid - Group JID
   */
  async leaveGroup(jid) {
    return this.groups.leave(jid);
  }

  /**
   * Get group invite code
   * @param {string} jid - Group JID
   * @returns {Promise<string>} Invite code
   */
  async getInviteCode(jid) {
    return this.groups.getInviteCode(jid);
  }

  /**
   * Revoke group invite code
   * @param {string} jid - Group JID
   * @returns {Promise<boolean>}
   */
  async revokeInviteCode(jid) {
    return this.groups.revokeInviteCode(jid);
  }

  /**
   * Update group subject
   * @param {string} jid - Group JID
   * @param {string} newSubject - New group subject
   * @returns {Promise<boolean>}
   */
  async updateGroupSubject(jid, newSubject) {
    return this.groups.updateSubject(jid, newSubject);
  }

  /**
   * Update group description
   * @param {string} jid - Group JID
   * @param {string} newDesc - New group description
   * @returns {Promise<boolean>}
   */
  async updateGroupDescription(jid, newDesc) {
    return this.groups.updateDescription(jid, newDesc);
  }

  /**
   * Generate mention string for user
   * @param {string} jid - User JID
   * @returns {string} Mention string
   */
  mention(jid) {
    return this.identity.mention(jid);
  }

  /**
   * Check if user is owner
   * @param {string} userId - User JID
   * @returns {boolean}
   */
  isOwner(userId) {
    return this.identity.isOwner(userId);
  }

  /**
   * Check if user is mod
   * @param {string} userId - User JID
   * @returns {boolean}
   */
  isMod(userId) {
    return this.identity.isMod(userId);
  }

  /**
   * Check if user is admin (global or group)
   * @param {string} userId - User JID
   * @param {string} groupJid - Optional group JID
   * @returns {Promise<boolean>}
   */
  async isAdmin(userId, groupJid = null) {
    if (groupJid) {
      return this.groups.isAdmin(groupJid, userId);
    }
    return this.identity.isMod(userId);
  }

  /**
   * Resolve sender name
   * @param {object} msg - Message object
   * @returns {Promise<string>} Sender name
   */
  async resolveSenderName(msg) {
    return this.identity.resolveSenderName(msg);
  }

  /**
   * Normalize JID
   * @param {string} jid - JID to normalize
   * @returns {string} Normalized JID
   */
  normalizeJid(jid) {
    return this.identity.normalizeJid(jid);
  }

  /**
   * Get contact info
   * @param {string} jid - User JID
   * @returns {Promise<object>} Contact info
   */
  async getContact(jid) {
    return this.identity.getContact(jid);
  }

  /**
   * Get user info
   * @param {string} jid - User JID
   * @returns {Promise<object>} User info
   */
  async getUserInfo(jid) {
    return this.identity.getUserInfo(jid);
  }

  /**
   * Check if message is from bot
   * @param {object} msg - Message object
   * @returns {boolean}
   */
  isFromBot(msg) {
    return this.identity.isFromBot(msg);
  }

  /**
   * Get bot's own JID
   * @returns {string}
   */
  getBotJid() {
    return this.identity.getBotJid();
  }

  /**
   * Get bot's own number
   * @returns {string}
   */
  getBotNumber() {
    return this.identity.getBotNumber();
  }
}

// Singleton instance
const wa = new WhatsAppAdapter();

// Export all public methods
export default wa;

export { MessageMedia } from './media.js';

export {
  wa,
  socketManager,
  authManager,
  messages,
  media,
  identity,
  groups,
};
